import { create } from 'zustand';
import {
  serverUrl,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type ConversationSummary,
  type DedicatedServer,
  type DedicatedStatus,
  type DeepPartial,
  type Mode,
  type ModelInfo,
  type Settings,
  type StreamEvent,
} from '@open-rock/shared';
import { api, connect, streamMessage, type SettingsInfo } from './api';
import { applyTheme, loadPrefs, savePrefs, type Prefs } from './prefs';
import { navigate, parseRoute, type Route } from './route';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface Streaming {
  conversationId: string;
  controller: AbortController;
}

interface State {
  booted: boolean;
  bootError: string | null;
  authRequired: boolean;
  route: Route;
  settings: Settings | null;
  info: SettingsInfo | null;
  prefs: Prefs;
  mode: Mode;
  models: Record<Mode, ModelInfo[]>;
  modelsLoading: Record<Mode, boolean>;
  modelsError: Record<Mode, string | null>;
  selected: Record<Mode, string>;
  conversations: ConversationSummary[];
  current: Conversation | null;
  currentLoading: boolean;
  streaming: Streaming | null;
  /** Last check of each dedicated server, by server ID. */
  dedicated: Record<string, DedicatedStatus>;
  dedicatedChecking: Record<string, boolean>;
  toasts: Toast[];
  sidebarOpen: boolean;

  boot(): Promise<void>;
  setRoute(r: Route): void;
  setPrefs(p: Partial<Prefs>): void;
  setMode(m: Mode): void;
  selectModel(id: string): void;
  loadModels(mode: Mode, refresh?: boolean): Promise<void>;
  refreshSettings(): Promise<void>;
  saveSettings(patch: DeepPartial<Settings>): Promise<void>;
  /** Check one dedicated server, or all of them. */
  checkDedicated(serverId?: string): Promise<void>;
  loadConversations(): Promise<void>;
  openConversation(id: string | null): Promise<void>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  send(content: string, attachments: Attachment[], opts?: { editMessageId?: string; regenerate?: boolean }): Promise<void>;
  stop(): void;
  toast(message: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  setSidebar(open: boolean): void;
}

let toastId = 0;

export function currentModel(s: Pick<State, 'models' | 'selected' | 'mode'>): ModelInfo | null {
  const list = s.models[s.mode];
  return list.find((m) => m.id === s.selected[s.mode]) ?? list[0] ?? null;
}

/** The dedicated server new messages go to in dedicated mode: the one picked, or the first. */
export function currentServer(s: Pick<State, 'settings' | 'selected'>): DedicatedServer | null {
  const list = s.settings?.dedicated.servers ?? [];
  return list.find((x) => x.id === s.selected.dedicated) ?? list[0] ?? null;
}

function pickDefaultBedrock(models: ModelInfo[], preferred: string[]): string {
  for (const p of preferred) if (p && models.some((m) => m.id === p)) return p;
  const sonnet = models.find((m) => /claude-sonnet-4/.test(m.baseId)) ?? models.find((m) => /anthropic\.claude/.test(m.baseId));
  return sonnet?.id ?? models[0]?.id ?? '';
}

export const useStore = create<State>((set, get) => ({
  booted: false,
  bootError: null,
  authRequired: false,
  route: parseRoute(location.hash),
  settings: null,
  info: null,
  prefs: loadPrefs(),
  mode: 'bedrock',
  models: { bedrock: [], dedicated: [] },
  modelsLoading: { bedrock: false, dedicated: false },
  modelsError: { bedrock: null, dedicated: null },
  selected: { bedrock: '', dedicated: '' },
  conversations: [],
  current: null,
  currentLoading: false,
  streaming: null,
  dedicated: {},
  dedicatedChecking: {},
  toasts: [],
  sidebarOpen: false,

  async boot() {
    applyTheme(get().prefs.theme);
    try {
      const health = await connect();
      let payload;
      try {
        payload = await api.settings();
      } catch (err) {
        if ((err as { status?: number }).status === 401 && health.authRequired) {
          set({ authRequired: true, booted: true });
          return;
        }
        throw err;
      }
      const prefs = get().prefs;
      const mode: Mode = prefs.mode ?? payload.settings.mode;
      document.documentElement.setAttribute('data-mode', mode);
      set({
        settings: payload.settings,
        info: payload.info,
        mode,
        authRequired: false,
        selected: { bedrock: prefs.lastModel.bedrock || payload.settings.bedrock.defaultModelId, dedicated: prefs.lastModel.dedicated },
      });
      await get().loadConversations();
      set({ booted: true });
      void get().loadModels('bedrock');
      void get().loadModels('dedicated');
      void get().checkDedicated();
      const r = get().route;
      if (r.name === 'chat' && r.id) void get().openConversation(r.id);
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err), booted: true });
    }
  },

  setRoute(route) {
    set({ route, sidebarOpen: false });
    if (route.name === 'chat') {
      const cur = get().current;
      if ((route.id ?? null) !== (cur?.id ?? null)) void get().openConversation(route.id ?? null);
    }
  },

  setPrefs(p) {
    const prefs = { ...get().prefs, ...p };
    savePrefs(prefs);
    if (p.theme) applyTheme(p.theme);
    set({ prefs });
  },

  setMode(mode) {
    document.documentElement.setAttribute('data-mode', mode);
    get().setPrefs({ mode });
    set({ mode });
    void get().saveSettings({ mode }).catch(() => undefined);
    const cur = get().current;
    if (cur && cur.mode !== mode && cur.messages.length) {
      // Switching modes starts a fresh chat; the old one stays in the list.
      if (get().route.name === 'chat') navigate({ name: 'chat' });
      else set({ current: null });
    }
  },

  selectModel(id) {
    const mode = get().mode;
    set({ selected: { ...get().selected, [mode]: id } });
    const prefs = get().prefs;
    get().setPrefs({ lastModel: { ...prefs.lastModel, [mode]: id } });
  },

  async loadModels(mode, refresh = false) {
    set({ modelsLoading: { ...get().modelsLoading, [mode]: true }, modelsError: { ...get().modelsError, [mode]: null } });
    try {
      const { models, error } = await api.models(mode, refresh);
      if (error) set({ modelsError: { ...get().modelsError, [mode]: error } });
      const selected = { ...get().selected };
      if (mode === 'bedrock') {
        selected.bedrock = pickDefaultBedrock(models, [selected.bedrock, get().settings?.bedrock.defaultModelId ?? '']);
      } else {
        const keep = [selected.dedicated, get().prefs.lastModel.dedicated].find((id) => id && models.some((m) => m.id === id));
        selected.dedicated = keep ?? models[0]?.id ?? '';
      }
      set({ models: { ...get().models, [mode]: models }, selected });
    } catch (err) {
      set({ modelsError: { ...get().modelsError, [mode]: err instanceof Error ? err.message : String(err) } });
    } finally {
      set({ modelsLoading: { ...get().modelsLoading, [mode]: false } });
    }
  },

  async refreshSettings() {
    const payload = await api.settings();
    set({ settings: payload.settings, info: payload.info });
  },

  async saveSettings(patch) {
    const payload = await api.saveSettings(patch);
    set({ settings: payload.settings, info: payload.info });
    if (patch.aws || patch.bedrock?.crossRegion !== undefined || patch.bedrock?.customModels) {
      void get().loadModels('bedrock', true);
    }
    if (patch.dedicated) {
      // Forget removed servers, then check the rest (an address or token may have changed).
      const ids = new Set(payload.settings.dedicated.servers.map((s) => s.id));
      set({ dedicated: Object.fromEntries(Object.entries(get().dedicated).filter(([id]) => ids.has(id))) });
      void get().loadModels('dedicated');
      void get().checkDedicated();
    }
  },

  async checkDedicated(serverId) {
    const servers = (get().settings?.dedicated.servers ?? []).filter((s) => !serverId || s.id === serverId);
    if (!servers.length) return;
    set({ dedicatedChecking: { ...get().dedicatedChecking, ...Object.fromEntries(servers.map((s) => [s.id, true])) } });
    await Promise.all(
      servers.map(async (srv) => {
        let st: DedicatedStatus;
        try {
          st = await api.dedicatedStatus(srv.id);
        } catch (err) {
          st = { ok: false, message: err instanceof Error ? err.message : String(err), endpoint: serverUrl(srv), models: [] };
        }
        set({ dedicated: { ...get().dedicated, [srv.id]: st }, dedicatedChecking: { ...get().dedicatedChecking, [srv.id]: false } });
      }),
    );
    // The model each server runs is known after a check.
    void get().loadModels('dedicated');
  },

  async loadConversations() {
    const { conversations } = await api.conversations();
    set({ conversations });
  },

  async openConversation(id) {
    if (!id) {
      set({ current: null });
      return;
    }
    set({ currentLoading: true });
    try {
      const conv = await api.conversation(id);
      set({ current: conv });
      if (conv.mode !== get().mode) {
        document.documentElement.setAttribute('data-mode', conv.mode);
        set({ mode: conv.mode });
      }
      if (conv.mode === 'bedrock' && conv.modelId) set({ selected: { ...get().selected, bedrock: conv.modelId } });
      // Dedicated chats keep going to their server, as long as it's still in the list.
      if (conv.mode === 'dedicated' && get().settings?.dedicated.servers.some((s) => s.id === conv.modelId)) {
        set({ selected: { ...get().selected, dedicated: conv.modelId } });
      }
    } catch (err) {
      get().toast(err instanceof Error ? err.message : String(err), 'error');
      navigate({ name: 'chat' });
    } finally {
      set({ currentLoading: false });
    }
  },

  async renameConversation(id, title) {
    const summary = await api.updateConversation(id, { title });
    set({
      conversations: get().conversations.map((c) => (c.id === id ? { ...c, title: summary.title } : c)),
      current: get().current?.id === id ? { ...get().current!, title: summary.title } : get().current,
    });
  },

  async deleteConversation(id) {
    await api.deleteConversation(id);
    set({ conversations: get().conversations.filter((c) => c.id !== id) });
    if (get().current?.id === id) navigate({ name: 'chat' });
  },

  async send(content, attachments, opts = {}) {
    const state = get();
    if (state.streaming) return;
    const mode = state.mode;
    const model = currentModel(state);
    if (mode === 'bedrock' && !model) {
      get().toast('Pick a Bedrock model first. If the list is empty, add your API key in Settings.', 'error');
      return;
    }
    if (mode === 'dedicated' && !state.settings?.dedicated.servers.length) {
      get().toast('Add a dedicated server in Settings first.', 'error');
      return;
    }
    let conv = state.current;
    if (!conv) {
      conv = await api.createConversation({ mode, modelId: model?.id ?? '', modelName: model?.name ?? '' });
      set({ current: conv });
      navigate({ name: 'chat', id: conv.id }, true);
    }
    const convId = conv.id;
    const now = Date.now();
    let messages = [...conv.messages];
    const tempUserId = `tmp_u_${now}`;
    if (opts.regenerate) {
      while (messages.length && messages[messages.length - 1].role === 'assistant') messages.pop();
    } else {
      if (opts.editMessageId) {
        const idx = messages.findIndex((m) => m.id === opts.editMessageId);
        if (idx >= 0) messages = messages.slice(0, idx);
      }
      messages.push({ id: tempUserId, role: 'user', content, attachments: attachments.length ? attachments : undefined, createdAt: now });
    }
    const tempAssistantId = `tmp_a_${now}`;
    let assistant: ChatMessage = { id: tempAssistantId, role: 'assistant', content: '', mode, modelId: model?.id, modelName: model?.name, createdAt: now };
    messages.push(assistant);
    const controller = new AbortController();
    set({ current: { ...conv, messages }, streaming: { conversationId: convId, controller } });

    // Coalesce deltas into one render per frame.
    let pendingText = '';
    let pendingReasoning = '';
    let frame = 0;
    const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
      assistant = fn(assistant);
      const cur = get().current;
      if (!cur || cur.id !== convId) return;
      set({ current: { ...cur, messages: cur.messages.map((m) => (m.id === tempAssistantId || m.id === assistant.id ? assistant : m)) } });
    };
    const flush = () => {
      frame = 0;
      if (!pendingText && !pendingReasoning) return;
      const t = pendingText;
      const r = pendingReasoning;
      pendingText = '';
      pendingReasoning = '';
      patchAssistant((m) => ({ ...m, content: m.content + t, reasoning: r ? (m.reasoning ?? '') + r : m.reasoning }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onEvent = (ev: StreamEvent) => {
      switch (ev.type) {
        case 'start': {
          const cur = get().current;
          if (cur && cur.id === convId && ev.userMessage) {
            set({ current: { ...cur, title: ev.conversation.title, messages: cur.messages.map((m) => (m.id === tempUserId ? ev.userMessage! : m)) } });
          } else if (cur && cur.id === convId) {
            set({ current: { ...cur, title: ev.conversation.title } });
          }
          const others = get().conversations.filter((c) => c.id !== convId);
          set({ conversations: [ev.conversation, ...others] });
          break;
        }
        case 'delta':
          pendingText += ev.text;
          schedule();
          break;
        case 'reasoning':
          pendingReasoning += ev.text;
          schedule();
          break;
        case 'notice':
          patchAssistant((m) => ({ ...m, notices: [...(m.notices ?? []), ev.message] }));
          break;
        case 'context':
          patchAssistant((m) => ({ ...m, context: ev.context }));
          break;
        case 'done':
          flush();
          patchAssistant(() => ev.message);
          break;
        case 'error':
          flush();
          patchAssistant((m) => ({ ...(ev.assistantMessage ?? m), error: ev.message }));
          break;
      }
    };

    try {
      await streamMessage(
        convId,
        {
          content,
          attachmentIds: attachments.map((a) => a.id),
          mode,
          modelId: model?.id ?? '',
          editMessageId: opts.editMessageId,
          regenerate: opts.regenerate,
        },
        onEvent,
        controller.signal,
      );
      flush();
    } catch (err) {
      flush();
      if (controller.signal.aborted) {
        patchAssistant((m) => ({ ...m, stopReason: 'stopped' }));
      } else {
        patchAssistant((m) => ({ ...m, error: err instanceof Error ? err.message : String(err) }));
      }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      set({ streaming: null });
      // Pull the saved version so ids and metadata match the server.
      if (get().current?.id === convId) {
        try {
          const saved = await api.conversation(convId);
          if (get().current?.id === convId && !get().streaming) set({ current: saved });
        } catch {
          // keep local copy
        }
      }
      void get().loadConversations();
    }
  },

  stop() {
    get().streaming?.controller.abort();
  },

  toast(message, tone = 'info') {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 8000 : 4000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setSidebar(open) {
    set({ sidebarOpen: open });
  },
}));
