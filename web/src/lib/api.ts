import type {
  Attachment,
  Conversation,
  ConversationSummary,
  DedicatedStatus,
  DeepPartial,
  HealthResponse,
  Mode,
  ModelInfo,
  SendMessageRequest,
  Settings,
  StreamEvent,
  TestResult,
  UsageRange,
  UsageReport,
} from '@open-rock/shared';

export interface SettingsInfo {
  version: string;
  /** A dedicated server at this host with no token of its own uses the token from the Open Rock server's .env. Empty = none. */
  dedicatedEnvTokenHost: string;
  bedrockKeyFromEnv: boolean;
}

export interface SettingsPayload {
  settings: Settings;
  info: SettingsInfo;
}

const TOKEN_KEY = 'open-rock.access-token';

let baseUrl = '';
let token = '';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Find the API server: the desktop app's bundled server, or the site that served this page. */
export async function connect(): Promise<HealthResponse> {
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<{ url: string; token: string }>('backend_info');
    baseUrl = info.url.replace(/\/$/, '');
    token = info.token;
  } else {
    baseUrl = '';
    try {
      token = localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      token = '';
    }
  }
  let lastErr: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return (await res.json()) as HealthResponse;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, i < 10 ? 150 : 500));
  }
  throw new Error(`Couldn't reach the Open Rock server${baseUrl ? ` at ${baseUrl}` : ''}. ${lastErr instanceof Error ? lastErr.message : ''}`);
}

export function setAccessToken(t: string) {
  token = t;
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // private mode
  }
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'x-open-rock-client': 'web', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : text) || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  settings: () => request<SettingsPayload>('GET', '/api/settings'),
  saveSettings: (patch: DeepPartial<Settings>) => request<SettingsPayload>('PUT', '/api/settings', patch),
  testBedrock: () => request<TestResult>('POST', '/api/bedrock/test'),
  dedicatedStatus: (serverId: string) => request<DedicatedStatus>('GET', `/api/dedicated/status?server=${encodeURIComponent(serverId)}`),
  models: (mode: Mode, refresh = false) => request<{ models: ModelInfo[]; error?: string }>('GET', `/api/models?mode=${mode}${refresh ? '&refresh=1' : ''}`),
  conversations: () => request<{ conversations: ConversationSummary[] }>('GET', '/api/conversations'),
  conversation: (id: string) => request<Conversation>('GET', `/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (input: { mode: Mode; modelId: string; modelName: string }) => request<Conversation>('POST', '/api/conversations', input),
  updateConversation: (id: string, patch: { title?: string; systemPrompt?: string | null }) =>
    request<ConversationSummary>('PATCH', `/api/conversations/${encodeURIComponent(id)}`, patch),
  deleteConversation: (id: string) => request<void>('DELETE', `/api/conversations/${encodeURIComponent(id)}`),
  usage: (range: UsageRange) => request<UsageReport>('GET', `/api/usage?range=${range}&tz=${new Date().getTimezoneOffset()}`),
  deleteFile: (id: string) => request<void>('DELETE', `/api/files/${encodeURIComponent(id)}`),
};

/** Upload with progress (fetch can't report upload progress). */
export function uploadFile(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/api/files`);
    for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Attachment);
      else reject(new ApiError(xhr.status, (data as { error?: string })?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: the server could not be reached.'));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

const blobCache = new Map<string, Promise<string>>();

/** Object URL for a stored file (the API needs headers, so <img src> can't point at it directly). */
export function fileUrl(id: string): Promise<string> {
  let p = blobCache.get(id);
  if (!p) {
    p = fetch(`${baseUrl}/api/files/${encodeURIComponent(id)}`, { headers: headers() }).then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, 'File not found');
      return URL.createObjectURL(await res.blob());
    });
    blobCache.set(id, p);
    p.catch(() => blobCache.delete(id));
  }
  return p;
}

/** POST a message and read the server-sent events as they arrive. */
export async function streamMessage(conversationId: string, body: SendMessageRequest, onEvent: (ev: StreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {
      // text
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as StreamEvent);
      } catch {
        // ignore malformed event
      }
    }
  }
}

export async function openExternal(url: string) {
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
