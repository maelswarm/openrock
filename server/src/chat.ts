import {
  repliesFor,
  type ChatMessage,
  type Conversation,
  type ContextReport,
  type DedicatedServer,
  type ModelInfo,
  type SendMessageRequest,
  type Settings,
  type StreamEvent,
  type TokenUsage,
} from '@open-rock/shared';
import { getSettings } from './settings.js';
import { getMeta, readBytes, readText } from './store/files.js';
import { saveConversation, summarize, titleFrom } from './store/conversations.js';
import { recordUsage } from './store/usage.js';
import { resolveBedrockModel } from './providers/bedrock-models.js';
import { bedrockChat } from './providers/bedrock.js';
import { cachedDedicatedModel, dedicatedChat } from './providers/dedicated.js';
import { ProviderError, type LoadedAttachment, type NeutralMessage, type ProviderEvent } from './providers/types.js';
import { HttpError, errorMessage, isAbortError, newId } from './util.js';

/** The dedicated server a chat goes to: the one picked by ID, or the first in the list when none was picked. */
export function findServer(settings: Settings, id: string): DedicatedServer {
  const servers = settings.dedicated.servers;
  if (!servers.length) throw new HttpError(400, 'Add a dedicated server in Settings → Dedicated first.');
  if (!id) return servers[0];
  const srv = servers.find((s) => s.id === id);
  if (!srv) throw new HttpError(400, 'That dedicated server has been removed. Pick another one from the menu at the top of the chat.');
  return srv;
}

/** In dedicated mode each server is one entry in the model menu. baseId is the model the server runs, once known. */
export function dedicatedModelInfo(srv: DedicatedServer): ModelInfo {
  return {
    id: srv.id,
    baseId: cachedDedicatedModel(srv),
    name: srv.name,
    provider: 'Dedicated',
    mode: 'dedicated',
    capabilities: {
      images: srv.vision,
      documents: false,
      video: false,
      text: true,
      streaming: srv.stream,
      systemPrompt: true,
      reasoning: false,
      maxImages: srv.maxImages,
      maxDocuments: 0,
    },
  };
}

async function loadAttachment(id: string): Promise<LoadedAttachment | null> {
  try {
    const meta = await getMeta(id);
    return { ...meta, bytes: () => readBytes(id), text: () => readText(id) };
  } catch {
    return null;
  }
}

async function toNeutral(messages: ChatMessage[]): Promise<NeutralMessage[]> {
  const out: NeutralMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.error && !m.content) continue;
    const atts: LoadedAttachment[] = [];
    const missing: string[] = [];
    for (const a of m.attachments ?? []) {
      const loaded = await loadAttachment(a.id);
      if (loaded) atts.push(loaded);
      else missing.push(a.name);
    }
    const note = missing.length ? `\n\n[Files no longer available: ${missing.join(', ')}]` : '';
    out.push({ role: m.role, text: m.content + note, attachments: atts });
  }
  return out;
}

/**
 * Apply the request to the conversation (append, edit or regenerate), stream the reply and persist it.
 */
export async function runChat(conv: Conversation, req: SendMessageRequest, emit: (ev: StreamEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
  const settings = getSettings();
  const mode = req.mode;
  const server = mode === 'dedicated' ? findServer(settings, req.modelId) : null;
  let model: ModelInfo;
  if (server) {
    model = dedicatedModelInfo(server);
  } else {
    const id = req.modelId || settings.bedrock.defaultModelId;
    if (!id) throw new HttpError(400, 'Pick a Bedrock model first.');
    model = await resolveBedrockModel(settings, id);
  }

  // 1. Update the conversation.
  let userMessage: ChatMessage | undefined;
  if (req.regenerate) {
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') conv.messages.pop();
    if (!conv.messages.length) throw new HttpError(400, 'Nothing to regenerate.');
  } else {
    const attachments = [];
    for (const id of req.attachmentIds ?? []) attachments.push(await getMeta(id));
    if (!req.content.trim() && !attachments.length) throw new HttpError(400, 'Type a message or attach a file.');
    if (req.editMessageId) {
      const idx = conv.messages.findIndex((m) => m.id === req.editMessageId);
      if (idx < 0 || conv.messages[idx].role !== 'user') throw new HttpError(404, 'That message no longer exists.');
      conv.messages = conv.messages.slice(0, idx);
    }
    userMessage = {
      id: newId('m_'),
      role: 'user',
      content: req.content,
      attachments: attachments.length ? attachments : undefined,
      createdAt: Date.now(),
    };
    conv.messages.push(userMessage);
    if (conv.title === 'New chat') conv.title = titleFrom(req.content || attachments[0]?.name || '');
  }
  conv.mode = mode;
  conv.modelId = model.id;
  conv.modelName = model.name;
  conv.updatedAt = Date.now();
  conv.messageCount = conv.messages.length;
  await saveConversation(conv);

  const assistant: ChatMessage = {
    id: newId('m_'),
    role: 'assistant',
    content: '',
    mode,
    modelId: model.id,
    modelName: model.name,
    createdAt: Date.now(),
  };
  await emit({ type: 'start', userMessage, assistantMessageId: assistant.id, conversation: summarize(conv) });

  // 2. Stream the reply.
  const system = (conv.systemPrompt ?? (mode === 'bedrock' ? settings.bedrock.systemPrompt : settings.dedicated.systemPrompt)) || '';
  const history = await toNeutral(conv.messages);
  const request = { messages: history, system, signal };
  const started = Date.now();
  let reasoning = '';
  let usage: TokenUsage | undefined;
  let latencyMs: number | undefined;
  let context: ContextReport | undefined;
  const notices = new Set<string>();

  const events: AsyncGenerator<ProviderEvent> = server
    ? dedicatedChat(server, request)
    : bedrockChat(settings, { modelId: model.id, model, replies: repliesFor(settings.bedrock, model.baseId) }, request);

  const finish = async (extra: Partial<ChatMessage>) => {
    assistant.reasoning = reasoning || undefined;
    assistant.notices = notices.size ? [...notices] : undefined;
    assistant.context = context;
    assistant.latencyMs = latencyMs ?? Date.now() - started;
    if (!usage && assistant.content) {
      const cpt = server ? server.charsPerToken : 4;
      usage = { inputTokens: context?.promptTokens ?? 0, outputTokens: Math.ceil(assistant.content.length / cpt) };
    }
    assistant.usage = usage;
    Object.assign(assistant, extra);
    conv.messages.push(assistant);
    conv.updatedAt = Date.now();
    conv.messageCount = conv.messages.length;
    await saveConversation(conv);
  };

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case 'delta':
          assistant.content += ev.text;
          await emit({ type: 'delta', text: ev.text });
          break;
        case 'reasoning':
          reasoning += ev.text;
          await emit({ type: 'reasoning', text: ev.text });
          break;
        case 'notice':
          if (!notices.has(ev.message)) {
            notices.add(ev.message);
            await emit({ type: 'notice', message: ev.message });
          }
          break;
        case 'context':
          context = ev.context;
          await emit({ type: 'context', context: ev.context });
          break;
        case 'usage':
          usage = ev.usage;
          latencyMs = ev.latencyMs;
          break;
        case 'stop':
          assistant.stopReason = ev.reason;
          break;
      }
    }
    await finish({});
    await recordUsage({ mode, modelId: model.id, modelName: model.name, usage, latencyMs: assistant.latencyMs, ok: true });
    await emit({ type: 'done', message: assistant });
  } catch (err) {
    if (signal.aborted || isAbortError(err)) {
      await finish({ stopReason: 'stopped' });
      if (usage || assistant.content) await recordUsage({ mode, modelId: model.id, modelName: model.name, usage, ok: true });
      return;
    }
    const message = err instanceof ProviderError || err instanceof HttpError ? err.message : errorMessage(err);
    await finish({ error: message, stopReason: 'error' });
    await recordUsage({
      mode,
      modelId: model.id,
      modelName: model.name,
      usage,
      ok: false,
      throttled: err instanceof ProviderError ? err.throttled : false,
    });
    await emit({ type: 'error', message, assistantMessage: assistant });
  }
}
