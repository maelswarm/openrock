import fs from 'node:fs';
import {
  DEFAULT_DEDICATED_MODEL,
  DEFAULT_SETTINGS,
  SECRET_MASK,
  parseServerAddress,
  type BedrockReplySettings,
  type DedicatedApiStyle,
  type DedicatedAuthHeader,
  type DedicatedModelSettings,
  type DedicatedServer,
  type DeepPartial,
  type Effort,
  type Settings,
  type ThinkingChoice,
} from '@open-rock/shared';
import { dataPath, ensureDir, config } from './config.js';
import { HttpError, newId, writeFileAtomic } from './util.js';

const SECRET_PATHS: [keyof Settings, string][] = [['aws', 'bedrockApiKey']];

/** Fields that are replaced wholesale instead of deep-merged. */
const REPLACE_PATHS = new Set(['bedrock.pricing', 'bedrock.customModels', 'bedrock.modelReplies', 'dedicated.servers']);

/** Fields older versions kept directly under `dedicated`, for their one server. They now live on each server. */
const LEGACY_DEDICATED_KEYS = ['port', 'apiKey', 'authHeader', 'apiStyle', 'model', 'displayName', ...Object.keys(DEFAULT_DEDICATED_MODEL)];
/** Reply settings older versions kept directly under `bedrock`, for every model. They now live in `replies`. */
const LEGACY_BEDROCK_KEYS = ['temperature', 'topP', 'maxTokens', 'stopSequences', 'reasoning', 'showLegacy'];

const AUTH_HEADERS: DedicatedAuthHeader[] = ['auto', 'bearer', 'x-api-key', 'api-key', 'raw'];
const API_STYLES: DedicatedApiStyle[] = ['auto', 'openai', 'ollama'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_CHOICES: ThinkingChoice[] = ['default', 'on', 'off'];
/** Model settings that may be left blank (null) to use the server's own default. */
const NULLABLE_MODEL_KEYS = new Set(['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'frequencyPenalty', 'seed', 'numGpu', 'numThread']);
const MODEL_CHOICES: Partial<Record<keyof DedicatedModelSettings, string[]>> = {
  contextStrategy: ['truncate', 'error', 'none'],
  systemPromptMode: ['native', 'merge'],
};

type Listener = (s: Settings) => void;

let current: Settings | null = null;
const listeners: Listener[] = [];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown, prefix = ''): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (REPLACE_PATHS.has(p) || !isPlainObject(v) || !isPlainObject(out[k])) out[k] = v;
    else out[k] = merge(out[k], v, p);
  }
  return out as T;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const oneOf = <T extends string>(list: T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A server's model settings from `raw`, keeping `base` for anything missing or of the wrong type. */
function modelSettingsFrom(raw: Record<string, unknown>, base: DedicatedModelSettings): DedicatedModelSettings {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_DEDICATED_MODEL)) {
    const fallback = (base as unknown as Record<string, unknown>)[key];
    const v = raw[key];
    out[key] = fallback;
    if (v === undefined) continue;
    const choices = MODEL_CHOICES[key as keyof DedicatedModelSettings];
    if (choices) out[key] = choices.includes(v as string) ? v : fallback;
    else if (NULLABLE_MODEL_KEYS.has(key)) out[key] = v === null || isNumber(v) ? v : fallback;
    else if (Array.isArray(fallback)) out[key] = isStringList(v) ? v : fallback;
    else out[key] = typeof v === typeof fallback && (typeof v !== 'number' || Number.isFinite(v)) ? v : fallback;
  }
  return out as unknown as DedicatedModelSettings;
}

/** Reply settings from `raw`, keeping `base` for anything missing or of the wrong type. */
function repliesFrom(raw: unknown, base: BedrockReplySettings): BedrockReplySettings {
  const r = isPlainObject(raw) ? raw : {};
  const num = (v: unknown, fallback: number | null) => (v === null || isNumber(v) ? v : fallback);
  return {
    maxTokens: num(r.maxTokens, base.maxTokens),
    temperature: num(r.temperature, base.temperature),
    topP: num(r.topP, base.topP),
    topK: num(r.topK, base.topK),
    stopSequences: isStringList(r.stopSequences) ? r.stopSequences : base.stopSequences,
    // Settings saved before thinking had a "model's default" stored true or false; false was the untouched default.
    thinking: typeof r.thinking === 'boolean' ? (r.thinking ? 'on' : 'default') : THINKING_CHOICES.includes(r.thinking as ThinkingChoice) ? (r.thinking as ThinkingChoice) : base.thinking,
    budgetTokens: isNumber(r.budgetTokens) ? r.budgetTokens : base.budgetTokens,
    effort: r.effort === null || EFFORTS.includes(r.effort as Effort) ? (r.effort as Effort | null) : base.effort,
  };
}

/**
 * Checks a server list from the client. Every server needs an address and a valid port; a port typed into the
 * address wins. A masked token keeps the saved one for the same ID. Missing or repeated IDs get a new one.
 */
export function cleanServers(input: unknown, prev: DedicatedServer[]): DedicatedServer[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'The server list must be a list.');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const r = isPlainObject(raw) ? raw : {};
    const label = text(r.name) || `server ${i + 1}`;
    const typed = text(r.host);
    if (!typed) throw new HttpError(400, `Enter a hostname or IP address for ${label}.`);
    const addr = parseServerAddress(typed);
    if (!addr) throw new HttpError(400, `"${typed}" isn't a hostname or IP address (${label}).`);
    const port = addr.port ?? r.port;
    if (!isPort(port)) throw new HttpError(400, `The port for ${label} must be a whole number from 1 to 65535.`);
    const id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) && !seen.has(r.id) ? r.id : newId('srv_');
    seen.add(id);
    const old = prev.find((p) => p.id === id);
    const apiKey = r.apiKey === SECRET_MASK ? (old?.apiKey ?? '') : typeof r.apiKey === 'string' ? r.apiKey : '';
    return {
      ...modelSettingsFrom(r, old ?? DEFAULT_DEDICATED_MODEL),
      id,
      name: text(r.name) || addr.host,
      host: addr.host,
      port,
      apiKey,
      authHeader: oneOf(AUTH_HEADERS, r.authHeader, 'auto'),
      apiStyle: oneOf(API_STYLES, r.apiStyle, 'auto'),
      model: text(r.model),
    };
  });
}

/**
 * Settings as stored, on top of the defaults. Settings older versions kept in one place for every model move to where
 * they live now: Bedrock reply settings into `replies`, and dedicated model settings onto each server. Until a server
 * list is saved, it starts with the server named in .env (if any).
 */
export function fromStored(stored: unknown): Settings {
  const s = merge(structuredClone(DEFAULT_SETTINGS), stored);

  const lb = isPlainObject(stored) && isPlainObject(stored.bedrock) ? stored.bedrock : {};
  if (!isPlainObject(lb.replies)) {
    const reasoning = isPlainObject(lb.reasoning) ? lb.reasoning : {};
    s.bedrock.replies = repliesFrom(
      {
        // 4096 was the old default; leaving it unset lets each model use its full output.
        maxTokens: lb.maxTokens === 4096 ? null : lb.maxTokens,
        temperature: lb.temperature,
        topP: lb.topP,
        stopSequences: lb.stopSequences,
        thinking: reasoning.enabled,
        budgetTokens: reasoning.budgetTokens,
      },
      s.bedrock.replies,
    );
  } else {
    s.bedrock.replies = repliesFrom(lb.replies, structuredClone(DEFAULT_SETTINGS.bedrock.replies));
  }
  s.bedrock.modelReplies = Object.fromEntries(Object.entries(isPlainObject(s.bedrock.modelReplies) ? s.bedrock.modelReplies : {}).map(([id, r]) => [id, repliesFrom(r, s.bedrock.replies)]));
  for (const k of LEGACY_BEDROCK_KEYS) delete (s.bedrock as unknown as Record<string, unknown>)[k];

  const legacy = isPlainObject(stored) && isPlainObject(stored.dedicated) ? stored.dedicated : {};
  const shared = modelSettingsFrom(legacy, DEFAULT_DEDICATED_MODEL);
  if (!Array.isArray(legacy.servers)) {
    s.dedicated.servers = config.dedicated.host
      ? [
          {
            ...shared,
            id: 'env',
            name: text(legacy.displayName) || 'Gemma',
            host: config.dedicated.host,
            port: isPort(legacy.port) ? legacy.port : 443,
            apiKey: typeof legacy.apiKey === 'string' ? legacy.apiKey : '',
            authHeader: oneOf(AUTH_HEADERS, legacy.authHeader, 'auto'),
            apiStyle: oneOf(API_STYLES, legacy.apiStyle, 'auto'),
            model: text(legacy.model),
          },
        ]
      : [];
  } else {
    // Servers saved before model settings moved onto them get the settings that used to apply to all of them.
    s.dedicated.servers = s.dedicated.servers.map((srv) => ({ ...srv, ...modelSettingsFrom(srv as unknown as Record<string, unknown>, shared) }));
  }
  for (const k of LEGACY_DEDICATED_KEYS) delete (s.dedicated as unknown as Record<string, unknown>)[k];
  // Environment overrides for first run / container deployments.
  if (!isPlainObject(stored) || !('aws' in stored)) {
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    if (region) s.aws.region = region;
  }
  return s;
}

function settingsFile() {
  return dataPath('settings.json');
}

export function getSettings(): Settings {
  if (current) return current;
  let stored: unknown = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    stored = {};
  }
  current = fromStored(stored);
  return current;
}

export async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const prev = getSettings();
  const cleaned = structuredClone(patch) as Record<string, Record<string, unknown>>;
  // A masked secret coming back from the client means "unchanged".
  for (const [section, key] of SECRET_PATHS) {
    const sec = cleaned[section];
    if (sec && sec[key] === SECRET_MASK) delete sec[key];
  }
  if (cleaned.dedicated?.servers !== undefined) cleaned.dedicated.servers = cleanServers(cleaned.dedicated.servers, prev.dedicated.servers);
  if (cleaned.bedrock?.modelReplies !== undefined) {
    const list = isPlainObject(cleaned.bedrock.modelReplies) ? cleaned.bedrock.modelReplies : {};
    cleaned.bedrock.modelReplies = Object.fromEntries(Object.entries(list).map(([id, r]) => [id, repliesFrom(r, prev.bedrock.replies)]));
  }
  const next = merge(prev, cleaned);
  ensureDir(config.dataDir);
  await writeFileAtomic(settingsFile(), JSON.stringify(next, null, 2), 0o600);
  current = next;
  for (const l of listeners) l(next);
  return next;
}

export function maskedSettings(s: Settings = getSettings()): Settings {
  const copy = structuredClone(s) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, key] of SECRET_PATHS) {
    if (copy[section][key]) copy[section][key] = SECRET_MASK;
  }
  for (const srv of copy.dedicated.servers as DedicatedServer[]) {
    if (srv.apiKey) srv.apiKey = SECRET_MASK;
  }
  return copy as unknown as Settings;
}

export function onSettingsChange(l: Listener) {
  listeners.push(l);
}
