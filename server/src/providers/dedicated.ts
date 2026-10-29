import http from 'node:http';
import https from 'node:https';
import {
  estimateTokens,
  serverUrl,
  type ContextReport,
  type DedicatedServer,
  type DedicatedStatus,
  type TokenUsage,
} from '@open-rock/shared';
import { config } from '../config.js';
import { errorMessage } from '../util.js';
import { fileAsText, normalizeHistory, omittedNote } from './history.js';
import { ProviderError, type ChatRequest, type LoadedAttachment, type NeutralMessage, type ProviderEvent } from './types.js';

type Style = 'openai' | 'ollama';

// ---------- Transport ----------
// node:https instead of fetch so any certificate the Gemma server presents is accepted, for these requests only
// (Bedrock and everything else keep normal certificate checks): self-signed, expired, issued for another name or by a
// private CA, weak keys and old signature hashes. Traffic is encrypted; the certificate isn't used to verify the
// server's identity. The same code runs under Node (website) and Bun (desktop sidecar), whose TLS libraries take
// different options.

const BUN = typeof process.versions.bun === 'string';

/** Every signature scheme, including Ed25519 and SHA-1, which Bun's TLS library leaves out by default. */
const SIGALGS = [
  'ed25519',
  'ecdsa_secp256r1_sha256',
  'ecdsa_secp384r1_sha384',
  'ecdsa_secp521r1_sha512',
  'rsa_pss_rsae_sha256',
  'rsa_pss_rsae_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha256',
  'rsa_pkcs1_sha384',
  'rsa_pkcs1_sha512',
  'ecdsa_sha1',
  'rsa_pkcs1_sha1',
].join(':');

/** Accept any certificate, and servers that only speak TLS 1.0 or 1.1. OpenSSL's security level 0 lets weak keys and hashes through. */
const ANY_CERT: https.RequestOptions = {
  rejectUnauthorized: false,
  checkServerIdentity: () => undefined,
  minVersion: 'TLSv1',
  ...(BUN ? { sigalgs: SIGALGS } : { ciphers: 'DEFAULT:@SECLEVEL=0' }),
};

/**
 * Keys that can't sign a TLS 1.3 handshake (RSA under 528 bits, uncommon curves like secp256k1) still work over TLS 1.2.
 * Used after a handshake fails, then remembered for that server.
 */
const ANY_CERT_TLS12: https.RequestOptions = {
  ...ANY_CERT,
  maxVersion: 'TLSv1.2',
  ...(BUN ? {} : { ecdhCurve: 'X25519:prime256v1:secp384r1:secp521r1:secp256k1' }),
};
const needsTls12 = new Set<string>();

function isHandshakeRefusal(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return /HANDSHAKE_FAILURE|alert handshake failure|no shared (cipher|signature)|NO_SHARED/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`);
}

interface DResponse {
  status: number;
  ok: boolean;
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
  header(name: string): string | undefined;
}

interface DRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Fail if no response headers arrive within this time. */
  timeoutMs?: number;
}

function drequest(url: string, opts: DRequest = {}): Promise<DResponse> {
  const u = new URL(url);
  if (u.protocol !== 'https:') return send(u, opts, {});
  if (needsTls12.has(u.host)) return send(u, opts, ANY_CERT_TLS12);
  return send(u, opts, ANY_CERT).catch((err) => {
    // Nothing has been sent yet when the handshake fails, so a retry is safe.
    if (!isHandshakeRefusal(err) || opts.signal?.aborted) throw err;
    return send(u, opts, ANY_CERT_TLS12).then((res) => {
      needsTls12.add(u.host);
      return res;
    });
  });
}

function send(u: URL, opts: DRequest, tls: https.RequestOptions): Promise<DResponse> {
  const mod = u.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
  return new Promise<DResponse>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    let response: http.IncomingMessage | undefined;
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const onAbort = () => {
      req.destroy(abortError());
      response?.destroy(abortError());
    };
    const req = mod.request(
      u,
      { method: opts.method ?? 'GET', headers, ...tls },
      (res) => {
        clearTimeout(timer);
        response = res;
        res.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
        const status = res.statusCode ?? 0;
        resolve({
          status,
          ok: status >= 200 && status < 300,
          body: res,
          header(name: string) {
            const v = res.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(', ') : v;
          },
          async text() {
            const chunks: Buffer[] = [];
            for await (const c of res) chunks.push(Buffer.from(c as Uint8Array));
            return Buffer.concat(chunks).toString('utf8');
          },
        });
      },
    );
    const timer = opts.timeoutMs
      ? setTimeout(() => req.destroy(Object.assign(new Error('timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' })), opts.timeoutMs)
      : undefined;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ---------- Endpoint helpers ----------

function root(srv: DedicatedServer): string {
  return serverUrl(srv);
}

function openaiBase(srv: DedicatedServer): string {
  return `${root(srv)}/v1`;
}

/**
 * The server's token from Settings → Dedicated. A server at OPEN_ROCK_DEDICATED_HOST with no token of its own uses
 * OPEN_ROCK_DEDICATED_TOKEN; other servers never get it.
 * Forgives common paste mistakes: surrounding quotes, a leading "Bearer ", mask bullets, stray whitespace.
 */
export function dedicatedToken(srv: DedicatedServer): string {
  return cleanToken(srv.apiKey) || (isEnvServer(srv) ? cleanToken(config.dedicated.token) : '');
}

export function isEnvServer(srv: { host: string }): boolean {
  return !!config.dedicated.host && srv.host.toLowerCase() === config.dedicated.host.toLowerCase();
}

export function cleanToken(raw: string | undefined): string {
  // Bullets come from typing into an older version of the field that showed the saved token as "••••••••".
  let t = (raw ?? '').replace(/[\u200b-\u200d\ufeff\u2022\u25cf]/g, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^authorization:\s*/i, '').replace(/^bearer\s+/i, '').trim();
  return t;
}

type AuthStyle = Exclude<DedicatedServer['authHeader'], 'auto'>;
const AUTH_ORDER: AuthStyle[] = ['bearer', 'x-api-key', 'raw', 'api-key'];
const AUTH_LABEL: Record<AuthStyle, string> = {
  bearer: 'Authorization: Bearer',
  'x-api-key': 'X-API-Key',
  'api-key': 'api-key',
  raw: 'Authorization (no prefix)',
};

/** Header style that worked last time, per server address and token (auto mode). */
const detectedAuth = new Map<string, AuthStyle>();

function authKey(srv: DedicatedServer): string {
  return `${root(srv)}|${dedicatedToken(srv)}`;
}

function authStyleFor(srv: DedicatedServer): AuthStyle {
  if (srv.authHeader && srv.authHeader !== 'auto') return srv.authHeader;
  return detectedAuth.get(authKey(srv)) ?? 'bearer';
}

function headers(srv: DedicatedServer, json = true, style: AuthStyle = authStyleFor(srv)): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  const token = dedicatedToken(srv);
  if (token) {
    if (style === 'bearer') h.Authorization = `Bearer ${token}`;
    else if (style === 'raw') h.Authorization = token;
    else if (style === 'x-api-key') h['X-API-Key'] = token;
    else h['api-key'] = token;
  }
  return h;
}

interface JsonResult {
  url: string;
  status: number;
  body: unknown;
  text: string;
  server?: string;
  wwwAuthenticate?: string;
}

async function getJson(srv: DedicatedServer, url: string, timeoutMs: number, body?: unknown, style?: AuthStyle): Promise<JsonResult> {
  const res = await drequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: headers(srv, body !== undefined, style),
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep text
  }
  return { url, status: res.status, body: parsed, text, server: res.header('server'), wwwAuthenticate: res.header('www-authenticate') };
}

/** One readable line about a check request, with the token removed. */
function describeAnswer(srv: DedicatedServer, r: PromiseSettledResult<JsonResult>, url: string, style: AuthStyle): string {
  const path = url.replace(root(srv), '') || '/';
  const how = `token as ${AUTH_LABEL[style]}`;
  if (r.status === 'rejected') return `GET ${path} (${how}): no answer. ${describeNetworkError(srv, r.reason)}`;
  const v = r.value;
  const token = dedicatedToken(srv);
  let snippet = v.text.replace(/\s+/g, ' ').trim();
  if (token) snippet = snippet.split(token).join('[token]');
  if (snippet.length > 220) snippet = `${snippet.slice(0, 220)}…`;
  const parts = [`GET ${path} (${how}): HTTP ${v.status}.`];
  if (v.server) parts.push(`Server: ${v.server}.`);
  if (v.wwwAuthenticate) parts.push(`WWW-Authenticate: ${v.wwwAuthenticate}.`);
  parts.push(snippet ? `Body: ${snippet}` : 'Empty body.');
  return parts.join(' ');
}

function describeNetworkError(srv: DedicatedServer, err: unknown): string {
  const msg = errorMessage(err);
  const e = err as { code?: string; name?: string; cause?: { code?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code ?? '';
  const where = root(srv);
  const port = srv.port || 443;
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || /wrong version number|packet length too long|ssl3_get_record/i.test(msg)) {
    return `Port ${port} on ${srv.host} doesn't speak HTTPS. Set the port to your HTTPS proxy (usually 443) in Settings → Dedicated.`;
  }
  if (code.startsWith('ERR_SSL') || code.startsWith('ERR_TLS') || /handshake|ssl|tls/i.test(msg)) {
    return `The HTTPS handshake with ${where} failed: ${msg}`;
  }
  if (code === 'ECONNREFUSED') return `Nothing is accepting connections on port ${port} at ${srv.host}. Check that the server (or its HTTPS proxy) is running.`;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout|timed out/i.test(msg) || e?.name === 'TimeoutError') {
    return `${where} didn't respond in time. Check that the instance is running and port ${port} is open to this machine in its security group.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Couldn't resolve ${srv.host}.`;
  if (code === 'ECONNRESET') return `The connection to ${where} was reset.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${srv.host} isn't reachable from this machine.`;
  return `Couldn't reach the Gemma server at ${where}: ${e?.cause?.message ?? msg}`;
}

// ---------- Detection & status ----------

/** Protocol found per server address (auto mode). */
const detected = new Map<string, { style: Style; at: number }>();
/** Models each server listed at its last check, per address. */
const listedModels = new Map<string, string[]>();

interface ProbeResult {
  style: Style;
  models: string[];
  raw: unknown;
  auth: AuthStyle;
  details: string[];
}

function asListing(r: PromiseSettledResult<JsonResult>, kind: 'tags' | 'models'): string[] | null {
  if (r.status !== 'fulfilled' || r.value.status !== 200 || !r.value.body || typeof r.value.body !== 'object') return null;
  if (kind === 'tags') {
    const list = (r.value.body as { models?: { name?: string; model?: string }[] }).models;
    return Array.isArray(list) ? list.map((m) => m.name ?? m.model ?? '').filter(Boolean) : null;
  }
  const data = (r.value.body as { data?: { id: string }[] }).data;
  return Array.isArray(data) ? data.map((d) => d.id).filter(Boolean) : null;
}

const isAuthFailure = (r: PromiseSettledResult<JsonResult>) => r.status === 'fulfilled' && (r.value.status === 401 || r.value.status === 403);

/**
 * Ollama listening on 127.0.0.1 answers a bare 403 (no body) when the Host header isn't localhost, a private IP or one
 * of the machine's own addresses (allowedHostsMiddleware in ollama/server/routes.go). A proxy that forwards the public
 * Host (nginx `proxy_set_header Host $host;`) triggers it. Ollama's FAQ uses `proxy_set_header Host localhost:11434;`.
 */
const isOllamaHostRefusal = (r: PromiseSettledResult<JsonResult>) => r.status === 'fulfilled' && r.value.status === 403 && r.value.text.trim() === '';

function ollamaHostMessage(where: string): string {
  return `The proxy at ${where} accepted the token, but Ollama behind it refused the request (HTTP 403, empty body). Ollama rejects requests whose Host header isn't localhost. In the nginx config, change "proxy_set_header Host $host;" to "proxy_set_header Host localhost:11434;" and reload nginx.`;
}

async function probe(srv: DedicatedServer): Promise<ProbeResult> {
  const tagsUrl = `${root(srv)}/api/tags`;
  const modelsUrl = `${openaiBase(srv)}/models`;
  const first = authStyleFor(srv);
  const styles = srv.authHeader === 'auto' && dedicatedToken(srv) ? [first, ...AUTH_ORDER.filter((s) => s !== first)] : [first];
  const details: string[] = [];
  let lastTags: PromiseSettledResult<JsonResult> | null = null;
  let lastModels: PromiseSettledResult<JsonResult> | null = null;

  for (const style of styles) {
    // Ask both protocols at once. Prefer Ollama: it also answers /v1/models, but only its native API honours num_ctx.
    const [tags, models] = await Promise.allSettled([getJson(srv, tagsUrl, 6000, undefined, style), getJson(srv, modelsUrl, 6000, undefined, style)]);
    lastTags = tags;
    lastModels = models;
    details.push(describeAnswer(srv, tags, tagsUrl, style), describeAnswer(srv, models, modelsUrl, style));
    if (tags.status === 'rejected' && models.status === 'rejected') {
      throw new ProviderError(describeNetworkError(srv, models.reason), 503, false, details);
    }
    const ollama = asListing(tags, 'tags');
    if (ollama) return { style: 'ollama', models: ollama, raw: (tags as PromiseFulfilledResult<JsonResult>).value.body, auth: style, details };
    const openai = asListing(models, 'models');
    if (openai) return { style: 'openai', models: openai, raw: (models as PromiseFulfilledResult<JsonResult>).value.body, auth: style, details };
    if (isOllamaHostRefusal(tags) || isOllamaHostRefusal(models)) {
      // The token got past the proxy in this format; the refusal comes from Ollama's Host check.
      if (srv.authHeader === 'auto') detectedAuth.set(authKey(srv), style);
      throw new ProviderError(ollamaHostMessage(root(srv)), 403, false, details);
    }
    // Only try another header style when the server said "not authorized".
    if (!isAuthFailure(tags) && !isAuthFailure(models)) {
      // Reachable but neither listing worked: assume an OpenAI-compatible server without /models.
      return { style: 'openai', models: [], raw: null, auth: style, details };
    }
  }

  const where = root(srv);
  const answers = [lastTags, lastModels].filter((r): r is PromiseFulfilledResult<JsonResult> => r?.status === 'fulfilled').map((r) => r.value);
  const basic = answers.some((a) => /^\s*basic/i.test(a.wwwAuthenticate ?? ''));
  const codes = [...new Set(answers.map((a) => a.status))].join(' and ');
  let message: string;
  if (!dedicatedToken(srv)) {
    message = `${where} needs a token (HTTP ${codes}). Paste it into this server's Token field in Settings → Dedicated.`;
  } else if (basic) {
    message = `${where} asks for a username and password (HTTP Basic auth), not an API token. Check the proxy in front of the Gemma server; its answers are listed below.`;
  } else if (styles.length > 1) {
    message = `${where} refused the token (HTTP ${codes}) in every format Open Rock tried: ${styles.map((s) => AUTH_LABEL[s]).join(', ')}. Check the token, and compare with the server's answers below.`;
  } else {
    message = `${where} refused the token (HTTP ${codes}) sent as ${AUTH_LABEL[styles[0]]}. Check the token, or set "Send the token as" to Detect automatically.`;
  }
  throw new ProviderError(message, 401, false, details);
}

async function resolveStyle(srv: DedicatedServer): Promise<Style> {
  if (srv.apiStyle !== 'auto') return srv.apiStyle;
  const base = root(srv);
  const known = detected.get(base);
  if (known && Date.now() - known.at < 10 * 60 * 1000) return known.style;
  const p = await probe(srv);
  detected.set(base, { style: p.style, at: Date.now() });
  if (srv.authHeader === 'auto') detectedAuth.set(authKey(srv), p.auth);
  return p.style;
}

export async function dedicatedStatus(srv: DedicatedServer): Promise<DedicatedStatus> {
  const started = Date.now();
  const endpoint = root(srv);
  try {
    // The probe finds both the protocol and how the server wants the token.
    const p = await probe(srv);
    const style: Style = srv.apiStyle === 'auto' ? p.style : srv.apiStyle;
    let models = p.models;
    let raw = p.raw;
    if (srv.apiStyle !== 'auto' && style !== p.style) {
      // The user picked the other protocol: list models with that one.
      try {
        const r = style === 'openai' ? await getJson(srv, `${openaiBase(srv)}/models`, 8000, undefined, p.auth) : await getJson(srv, `${endpoint}/api/tags`, 8000, undefined, p.auth);
        raw = r.body;
        models = style === 'openai' ? ((r.body as { data?: { id: string }[] })?.data ?? []).map((d) => d.id) : ((r.body as { models?: { name: string }[] })?.models ?? []).map((m) => m.name);
      } catch {
        models = [];
      }
    }
    detected.set(endpoint, { style, at: Date.now() });
    if (srv.authHeader === 'auto') detectedAuth.set(authKey(srv), p.auth);
    const authUsed = p.auth;
    const details = p.details;
    const latencyMs = Date.now() - started;
    const model = srv.model || models[0] || '';
    let contextSize: number | undefined;
    let vision: boolean | undefined;
    if (style === 'openai') {
      const card = ((raw as { data?: Record<string, unknown>[] })?.data ?? []).find((d) => d.id === model);
      if (card && typeof card.max_model_len === 'number') contextSize = card.max_model_len;
      if (!contextSize) {
        // llama.cpp exposes its context size at /props
        try {
          const props = await getJson(srv, `${endpoint}/props`, 4000, undefined, authUsed);
          const n = (props.body as { default_generation_settings?: { n_ctx?: number }; modalities?: { vision?: boolean } }) ?? {};
          if (props.status === 200 && n.default_generation_settings?.n_ctx) contextSize = n.default_generation_settings.n_ctx;
          if (props.status === 200 && typeof n.modalities?.vision === 'boolean') vision = n.modalities.vision;
        } catch {
          // optional
        }
      }
    } else if (model) {
      try {
        const show = await getJson(srv, `${endpoint}/api/show`, 6000, { model }, authUsed);
        const b = show.body as { model_info?: Record<string, unknown>; capabilities?: string[] };
        for (const [k, v] of Object.entries(b?.model_info ?? {})) {
          if (k.endsWith('.context_length') && typeof v === 'number') contextSize = v;
        }
        if (Array.isArray(b?.capabilities)) vision = b.capabilities.includes('vision');
      } catch {
        // optional
      }
    }
    listedModels.set(endpoint, models);
    return {
      ok: true,
      message: `Connected to ${endpoint}`,
      endpoint,
      apiStyle: style,
      models,
      contextSize,
      vision,
      latencyMs,
      authHeader: authUsed,
      details,
    };
  } catch (err) {
    listedModels.set(endpoint, []);
    return {
      ok: false,
      message: err instanceof ProviderError ? err.message : describeNetworkError(srv, err),
      details: err instanceof ProviderError ? err.details : undefined,
      endpoint,
      models: [],
    };
  }
}

export function cachedDedicatedModel(srv: DedicatedServer): string {
  if (srv.model) return srv.model;
  return listedModels.get(root(srv))?.[0] ?? '';
}

// ---------- Context fitting ----------

export interface Prepared {
  role: 'user' | 'assistant';
  text: string;
  images: LoadedAttachment[];
}

async function prepare(history: NeutralMessage[], srv: DedicatedServer, notices: Set<string>): Promise<Prepared[]> {
  const msgs = normalizeHistory(history);
  let imagesLeft = srv.vision ? Math.max(0, srv.maxImages) : 0;
  const out: Prepared[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const parts: string[] = [];
    const images: LoadedAttachment[] = [];
    for (const a of m.attachments) {
      if (a.kind === 'image') {
        if (!srv.vision) {
          notices.add('Vision is off for the dedicated server, so images were left out.');
          parts.push(omittedNote(a.name, 'image input is turned off'));
        } else if (imagesLeft <= 0) {
          parts.push(omittedNote(a.name, `only the ${srv.maxImages} most recent images are sent`));
        } else {
          imagesLeft--;
          images.push(a);
        }
      } else if (a.kind === 'video') {
        notices.add("Gemma can't watch video, so it was left out.");
        parts.push(omittedNote(a.name, 'video is not supported'));
      } else if (a.kind === 'document' && !srv.documentsAsText) {
        parts.push(omittedNote(a.name, 'document reading is turned off'));
      } else {
        const text = await a.text();
        parts.push(text ? fileAsText(a.name, text) : omittedNote(a.name, 'no readable text could be extracted'));
      }
    }
    const text = [...parts, m.text].filter((t) => t.trim()).join('\n\n') || (m.role === 'user' ? 'Please look at the attached image.' : '…');
    out.unshift({ role: m.role, text, images });
  }
  return out;
}

export function fitContext(
  msgs: Prepared[],
  system: string,
  srv: DedicatedServer,
): { messages: Prepared[]; report: ContextReport } {
  const est = (p: { role: Prepared['role'] | 'system'; text: string; images: number }) => estimateTokens(p, srv.charsPerToken, srv.imageTokens);
  const sysTokens = system.trim() ? est({ role: 'system', text: system, images: 0 }) : 0;
  const costs = msgs.map((m) => est({ role: m.role, text: m.text, images: m.images.length }));
  const total = sysTokens + costs.reduce((a, b) => a + b, 0);
  const budget = srv.contextSize - srv.maxTokens - srv.safetyMarginTokens;
  const report = (kept: number, tokens: number): ContextReport => ({
    contextSize: srv.contextSize,
    promptTokens: tokens,
    droppedMessages: msgs.length - kept,
    estimated: true,
  });
  if (srv.contextStrategy === 'none' || total <= budget) return { messages: msgs, report: report(msgs.length, total) };

  const lastCost = costs[costs.length - 1] ?? 0;
  if (sysTokens + lastCost > budget) {
    throw new ProviderError(
      `Your message needs about ${(sysTokens + lastCost).toLocaleString()} tokens, but a ${srv.contextSize.toLocaleString()}-token context with ${srv.maxTokens.toLocaleString()} reserved for the reply leaves ${Math.max(0, budget).toLocaleString()}. Shorten the message or attachments, or raise the context size in Settings → Dedicated.`,
      400,
    );
  }
  if (srv.contextStrategy === 'error') {
    throw new ProviderError(
      `This conversation needs about ${total.toLocaleString()} tokens but only ${budget.toLocaleString()} fit in the context window. Start a new chat, raise the context size, or set "When the context is full" to drop older messages.`,
      400,
    );
  }
  // Keep the newest messages that fit; the kept history must start with a user turn.
  let used = sysTokens;
  let start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (used + costs[i] > budget) break;
    used += costs[i];
    start = i;
  }
  while (start < msgs.length && msgs[start].role !== 'user') {
    used -= costs[start];
    start++;
  }
  const kept = msgs.slice(start);
  return { messages: kept, report: report(kept.length, used) };
}

// ---------- Request bodies ----------

function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function parseExtra(srv: DedicatedServer): Record<string, unknown> {
  if (!srv.extraBody.trim()) return {};
  try {
    const v = JSON.parse(srv.extraBody);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new ProviderError('The extra request JSON in Settings → Dedicated is not valid JSON.', 400);
  }
}

function withSystem(msgs: Prepared[], system: string, srv: DedicatedServer): { system: string | null; msgs: Prepared[] } {
  if (!system.trim()) return { system: null, msgs };
  if (srv.systemPromptMode === 'native') return { system: system.trim(), msgs };
  const copy = msgs.map((m) => ({ ...m }));
  if (copy[0]) copy[0].text = `${system.trim()}\n\n${copy[0].text}`;
  return { system: null, msgs: copy };
}

async function b64(a: LoadedAttachment): Promise<string> {
  return Buffer.from(await a.bytes()).toString('base64');
}

async function openaiBody(model: string, msgs: Prepared[], system: string, srv: DedicatedServer) {
  const s = withSystem(msgs, system, srv);
  const messages: unknown[] = [];
  if (s.system) messages.push({ role: 'system', content: s.system });
  for (const m of s.msgs) {
    if (m.images.length) {
      const content: unknown[] = [];
      for (const img of m.images) content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${await b64(img)}` } });
      content.push({ type: 'text', text: m.text });
      messages.push({ role: m.role, content });
    } else {
      messages.push({ role: m.role, content: m.text });
    }
  }
  return {
    ...compact({
      model,
      messages,
      stream: srv.stream,
      max_tokens: srv.maxTokens,
      temperature: srv.temperature,
      top_p: srv.topP,
      top_k: srv.topK,
      min_p: srv.minP,
      repetition_penalty: srv.repetitionPenalty,
      repeat_penalty: srv.repetitionPenalty,
      presence_penalty: srv.presencePenalty,
      frequency_penalty: srv.frequencyPenalty,
      seed: srv.seed,
      stop: srv.stop,
      stream_options: srv.stream && srv.includeUsage ? { include_usage: true } : null,
    }),
    ...parseExtra(srv),
  };
}

/** Ollama reads keep_alive as a number of seconds (negative = forever) or a Go duration string such as "30m" or "1h". */
export function keepAliveValue(v: string): string | number | null {
  const t = v.trim();
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

async function ollamaBody(model: string, msgs: Prepared[], system: string, srv: DedicatedServer) {
  const s = withSystem(msgs, system, srv);
  const messages: unknown[] = [];
  if (s.system) messages.push({ role: 'system', content: s.system });
  for (const m of s.msgs) {
    const images: string[] = [];
    for (const img of m.images) images.push(await b64(img));
    messages.push(compact({ role: m.role, content: m.text, images }));
  }
  const extra = parseExtra(srv);
  const extraOptions = (extra.options as Record<string, unknown> | undefined) ?? {};
  delete extra.options;
  return {
    ...compact({
      model,
      messages,
      stream: srv.stream,
      keep_alive: keepAliveValue(srv.keepAlive),
    }),
    options: {
      ...compact({
        num_ctx: srv.contextSize,
        num_predict: srv.maxTokens,
        temperature: srv.temperature,
        top_p: srv.topP,
        top_k: srv.topK,
        min_p: srv.minP,
        repeat_penalty: srv.repetitionPenalty,
        presence_penalty: srv.presencePenalty,
        frequency_penalty: srv.frequencyPenalty,
        seed: srv.seed,
        stop: srv.stop,
        num_gpu: srv.numGpu,
        num_thread: srv.numThread,
      }),
      ...extraOptions,
    },
    ...extra,
  };
}

// ---------- Streaming ----------

/** Abort when the caller aborts, or when the server goes quiet for too long. */
function idleTimeout(parent: AbortSignal, ms: number) {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error('timeout'));
    }, ms);
  };
  const onAbort = () => ctrl.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  arm();
  return {
    signal: ctrl.signal,
    kick: arm,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

async function* lines(body: AsyncIterable<Uint8Array>, kick: () => void): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const value of body) {
    kick();
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      yield line;
    }
  }
  buf += dec.decode();
  if (buf.trim()) yield buf;
}

async function errorFromResponse(res: DResponse): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let msg = text;
  try {
    const j = JSON.parse(text) as { error?: string | { message?: string }; message?: string; detail?: string };
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? j.detail ?? text;
  } catch {
    // plain text
  }
  if (res.status === 403 && !text.trim()) return new ProviderError(ollamaHostMessage('the Gemma server'), 403);
  msg = (msg || `HTTP ${res.status}`).slice(0, 600);
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`The Gemma server refused the token (HTTP ${res.status}): ${msg} Check the token in Settings → Dedicated, then press Check again.`, 401);
  }
  if (/context length|maximum context|too many tokens|exceeds|max_model_len/i.test(msg)) {
    return new ProviderError(`${msg} Lower the context size or max output tokens in Settings → Dedicated so they match the server.`, 400);
  }
  if (res.status === 404 && /model/i.test(msg)) return new ProviderError(`${msg} Pick the model name the server serves in Settings → Dedicated.`, 404);
  return new ProviderError(`Gemma server error (${res.status}): ${msg}`, res.status >= 500 ? 502 : 400, res.status === 429);
}

/** Chat with one server, using that server's own context, sampling and file settings. */
export async function* dedicatedChat(srv: DedicatedServer, req: ChatRequest): AsyncGenerator<ProviderEvent> {
  const style = await resolveStyle(srv);
  let model = cachedDedicatedModel(srv);
  if (!model) {
    const st = await dedicatedStatus(srv);
    if (!st.ok) throw new ProviderError(st.message, 503);
    model = st.models[0] ?? '';
    if (!model && style === 'ollama') throw new ProviderError('The Gemma server reports no models.', 503);
  }

  const notices = new Set<string>();
  const prepared = await prepare(req.messages, srv, notices);
  for (const n of notices) yield { type: 'notice', message: n };
  const { messages, report } = fitContext(prepared, req.system, srv);
  if (report.droppedMessages > 0) {
    yield { type: 'notice', message: `Left out the ${report.droppedMessages} oldest message${report.droppedMessages === 1 ? '' : 's'} to fit the ${srv.contextSize.toLocaleString()}-token context.` };
  }
  yield { type: 'context', context: report };

  const url = style === 'openai' ? `${openaiBase(srv)}/chat/completions` : `${root(srv)}/api/chat`;
  const body = style === 'openai' ? await openaiBody(model, messages, req.system, srv) : await ollamaBody(model, messages, req.system, srv);
  const t = idleTimeout(req.signal, Math.max(10, srv.timeoutSec) * 1000);
  const started = Date.now();
  let res: DResponse;
  const send = (style: AuthStyle) => drequest(url, { method: 'POST', headers: headers(srv, true, style), body: JSON.stringify(body), signal: t.signal });
  try {
    const firstStyle = authStyleFor(srv);
    res = await send(firstStyle);
    // Not authorized with the remembered header style: find the one the server takes, then retry once.
    if ((res.status === 401 || res.status === 403) && srv.authHeader === 'auto' && dedicatedToken(srv)) {
      await res.text().catch(() => '');
      detectedAuth.delete(authKey(srv));
      const st = await dedicatedStatus(srv);
      const nextStyle = authStyleFor(srv);
      if (st.ok && nextStyle !== firstStyle) res = await send(nextStyle);
      else if (!st.ok) throw new ProviderError(st.message, 401, false, st.details);
      else res = await send(firstStyle);
    }
  } catch (err) {
    t.done();
    if (req.signal.aborted) throw err;
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(t.timedOut() ? `The Gemma server didn't start replying within ${srv.timeoutSec}s.` : describeNetworkError(srv, err), 503);
  }
  if (!res.ok) {
    t.done();
    if (res.status === 404 && srv.apiStyle === 'auto') detected.delete(root(srv));
    throw await errorFromResponse(res);
  }

  let usage: TokenUsage | null = null;
  let stop = 'end_turn';
  try {
    if (!srv.stream) {
      const j = JSON.parse(await res.text()) as Record<string, any>;
      if (style === 'openai') {
        const msg = j.choices?.[0]?.message ?? {};
        if (msg.reasoning_content) yield { type: 'reasoning', text: String(msg.reasoning_content) };
        if (msg.content) yield { type: 'delta', text: String(msg.content) };
        stop = j.choices?.[0]?.finish_reason ?? stop;
        if (j.usage) usage = { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 };
      } else {
        if (j.message?.thinking) yield { type: 'reasoning', text: String(j.message.thinking) };
        if (j.message?.content) yield { type: 'delta', text: String(j.message.content) };
        stop = j.done_reason ?? stop;
        usage = { inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
      }
    } else if (style === 'openai') {
      for await (const line of lines(res.body, t.kick)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j: Record<string, any>;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(`Gemma server error: ${j.error.message ?? JSON.stringify(j.error)}`);
        const choice = j.choices?.[0];
        const d = choice?.delta ?? {};
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (reasoning) yield { type: 'reasoning', text: String(reasoning) };
        if (d.content) yield { type: 'delta', text: String(d.content) };
        if (choice?.finish_reason) stop = choice.finish_reason;
        if (j.usage) usage = { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 };
      }
    } else {
      for await (const line of lines(res.body, t.kick)) {
        if (!line.trim()) continue;
        let j: Record<string, any>;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(`Gemma server error: ${j.error}`);
        if (j.message?.thinking) yield { type: 'reasoning', text: String(j.message.thinking) };
        if (j.message?.content) yield { type: 'delta', text: String(j.message.content) };
        if (j.done) {
          stop = j.done_reason ?? stop;
          usage = { inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
        }
      }
    }
  } catch (err) {
    if (t.timedOut() && !req.signal.aborted) throw new ProviderError(`The Gemma server went quiet for ${srv.timeoutSec}s, so the reply was cut off.`, 504);
    throw err;
  } finally {
    t.done();
  }

  const latencyMs = Date.now() - started;
  if (usage) {
    yield { type: 'usage', usage, latencyMs };
    if (usage.inputTokens > 0) {
      yield { type: 'context', context: { ...report, promptTokens: usage.inputTokens, estimated: false } };
    }
  }
  yield { type: 'stop', reason: stop === 'stop' ? 'end_turn' : stop === 'length' ? 'max_tokens' : stop };
}
