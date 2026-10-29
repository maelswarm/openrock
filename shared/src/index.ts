// Types and helpers shared by the server and the web/desktop client.

export type Mode = 'bedrock' | 'dedicated';

export interface AwsSettings {
  region: string;
  /** Amazon Bedrock API key (sent as a bearer token). Secret: returned to the client masked. */
  bedrockApiKey: string;
}

export type CrossRegionPreference = 'auto' | 'global' | 'geo' | 'off';

export interface CustomBedrockModel {
  /** Model ID, inference profile ID or ARN (provisioned throughput, imported model, application profile). */
  id: string;
  name: string;
  images: boolean;
  documents: boolean;
  video: boolean;
}

export interface ModelPrice {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read input tokens */
  cacheRead?: number;
  /** USD per 1M cache-write input tokens */
  cacheWrite?: number;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** For models where thinking is optional. "default" leaves it to the model: newer Claude models think, older ones don't. */
export type ThinkingChoice = 'default' | 'on' | 'off';

/** How a Bedrock model replies. Numbers left null use the model's own default. Each model only gets what it supports. */
export interface BedrockReplySettings {
  /** null = the model's maximum. */
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  stopSequences: string[];
  /** Thinking for models where it's optional. */
  thinking: ThinkingChoice;
  /** Thinking budget, for models that take one. */
  budgetTokens: number;
  /** How hard the model works, for models that take an effort level. null = the model's default. */
  effort: Effort | null;
}

export interface BedrockSettings {
  defaultModelId: string;
  crossRegion: CrossRegionPreference;
  systemPrompt: string;
  /** Used by every model without settings of its own. */
  replies: BedrockReplySettings;
  /** Settings for one model, keyed by its base model ID. They replace `replies` for that model. */
  modelReplies: Record<string, BedrockReplySettings>;
  customModels: CustomBedrockModel[];
  /** Keyed by a model ID fragment, e.g. "anthropic.claude-sonnet-4-5". Matched against the base model ID. */
  pricing: Record<string, ModelPrice>;
}

/** Which wire protocol the Gemma endpoint speaks. "auto" probes the server once and remembers. */
export type DedicatedApiStyle = 'auto' | 'openai' | 'ollama';
/** How the token is sent. "auto" tries Authorization: Bearer first, then the other common API-key headers. */
export type DedicatedAuthHeader = 'auto' | 'bearer' | 'x-api-key' | 'api-key' | 'raw';
export type ContextStrategy = 'truncate' | 'error' | 'none';
export type SystemPromptMode = 'native' | 'merge';

/** How a dedicated server's model is used. Each server runs one model, so each server has its own. */
export interface DedicatedModelSettings {
  timeoutSec: number;

  // Context
  contextSize: number;
  maxTokens: number;
  contextStrategy: ContextStrategy;
  safetyMarginTokens: number;
  charsPerToken: number;
  imageTokens: number;

  // Sampling (null = server default)
  temperature: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repetitionPenalty: number | null;
  presencePenalty: number | null;
  frequencyPenalty: number | null;
  seed: number | null;
  stop: string[];

  // Behaviour
  systemPromptMode: SystemPromptMode;
  stream: boolean;
  includeUsage: boolean;
  keepAlive: string;
  numGpu: number | null;
  numThread: number | null;
  extraBody: string;

  // Capabilities
  vision: boolean;
  maxImages: number;
  documentsAsText: boolean;
}

/**
 * One Gemma server and the model settings for it. Connections always use HTTPS and accept any certificate.
 * The token is never sent back to the browser.
 */
export interface DedicatedServer extends DedicatedModelSettings {
  /** Stable ID; chats remember their server by it. */
  id: string;
  name: string;
  /** Hostname or IP address, without scheme or port. */
  host: string;
  /** HTTPS port of the Gemma server (or the TLS proxy in front of it). */
  port: number;
  /** Token (API key) for this server. Secret: returned to the client masked. */
  apiKey: string;
  authHeader: DedicatedAuthHeader;
  apiStyle: DedicatedApiStyle;
  /** Model name to request. Empty = the first model the server reports. */
  model: string;
}

export interface DedicatedSettings {
  servers: DedicatedServer[];
  /** Sent before every conversation on every server. */
  systemPrompt: string;
}

export interface Settings {
  mode: Mode;
  aws: AwsSettings;
  bedrock: BedrockSettings;
  dedicated: DedicatedSettings;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const SECRET_MASK = '••••••••';

export const DEFAULT_REPLIES: BedrockReplySettings = {
  maxTokens: null,
  temperature: null,
  topP: null,
  topK: null,
  stopSequences: [],
  thinking: 'default',
  budgetTokens: 4096,
  effort: null,
};

/** A new dedicated server's model settings: Gemma 3's recommended sampling and a context most servers can hold. */
export const DEFAULT_DEDICATED_MODEL: DedicatedModelSettings = {
  timeoutSec: 300,
  contextSize: 8192,
  maxTokens: 1024,
  contextStrategy: 'truncate',
  safetyMarginTokens: 128,
  charsPerToken: 3.6,
  imageTokens: 256,
  temperature: 1.0,
  topP: 0.95,
  topK: 64,
  minP: null,
  repetitionPenalty: null,
  presencePenalty: null,
  frequencyPenalty: null,
  seed: null,
  stop: [],
  systemPromptMode: 'native',
  stream: true,
  includeUsage: true,
  keepAlive: '',
  numGpu: null,
  numThread: null,
  extraBody: '',
  vision: true,
  maxImages: 8,
  documentsAsText: true,
};

export const DEFAULT_SETTINGS: Settings = {
  mode: 'bedrock',
  aws: {
    region: 'us-east-1',
    bedrockApiKey: '',
  },
  bedrock: {
    defaultModelId: '',
    crossRegion: 'auto',
    systemPrompt: '',
    replies: DEFAULT_REPLIES,
    modelReplies: {},
    customModels: [],
    // Starter on-demand list prices (USD per 1M tokens). Check the Bedrock pricing page for your region and edit in Settings.
    pricing: {
      'anthropic.claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'anthropic.claude-3-7-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'anthropic.claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      'anthropic.claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
      'anthropic.claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'amazon.nova-micro': { input: 0.035, output: 0.14 },
      'amazon.nova-lite': { input: 0.06, output: 0.24 },
      'amazon.nova-pro': { input: 0.8, output: 3.2 },
      'meta.llama3-3-70b': { input: 0.72, output: 0.72 },
    },
  },
  dedicated: {
    servers: [],
    systemPrompt: '',
  },
};

/** The reply settings a Bedrock model uses: its own, or the ones for all models. */
export function repliesFor(b: BedrockSettings, baseId: string): BedrockReplySettings {
  return b.modelReplies[baseId] ?? b.replies;
}

// ---------- Models ----------

export interface ModelCapabilities {
  images: boolean;
  /** Accepts native document blocks (PDF, DOCX…). If false, documents are sent as extracted text. */
  documents: boolean;
  video: boolean;
  /** Text-like files are always accepted (inlined as text). */
  text: true;
  streaming: boolean;
  systemPrompt: boolean;
  reasoning: boolean;
  maxImages: number;
  maxDocuments: number;
}

export interface ModelInfo {
  /** The ID used to invoke the model (may be an inference profile ID or ARN). */
  id: string;
  /** Base foundation model ID (for pricing / grouping). */
  baseId: string;
  name: string;
  provider: string;
  mode: Mode;
  legacy?: boolean;
  /** When Bedrock stops serving a legacy model (epoch ms), if it says. */
  endOfLife?: number;
  /** e.g. "us" when invoked via a cross-region inference profile */
  profileScope?: string;
  custom?: boolean;
  capabilities: ModelCapabilities;
}

// ---------- What each Bedrock model accepts ----------

/**
 * How a model thinks before answering:
 * - budget: optional extended thinking with a token budget (Claude 3.7 to 4.5)
 * - adaptive: optional thinking whose depth follows the effort level (Claude 4.6 to 5)
 * - always: always thinks; effort sets how much (the newest Claude models)
 * - effort: reasoning effort only (OpenAI gpt-oss)
 * - builtin: always reasons and has nothing to set (DeepSeek R1)
 */
export type ThinkingStyle = 'budget' | 'adaptive' | 'always' | 'effort' | 'builtin';

export interface ModelParams {
  /** Highest max-output value the model takes, when it's known. */
  maxOutputTokens: number | null;
  /** Converse takes 0 to 1 for both. */
  temperature: boolean;
  topP: boolean;
  /** Sent as a model-specific field; only some models have it. */
  topK: boolean;
  stopSequences: boolean;
  thinking: ThinkingStyle | null;
  /** For adaptive thinking: whether leaving thinking unset means on. */
  thinkingOnByDefault: boolean;
  /** Effort levels the model takes; empty when it has none. */
  effortLevels: Effort[];
  /** Highest effort the model takes with thinking turned off, when it limits it. */
  maxEffortWithoutThinking: Effort | null;
  /** Temperature and Top P can't both be sent; temperature wins. */
  temperatureOrTopP: boolean;
  /** Sampling settings are dropped while thinking is on. */
  noSamplingWhileThinking: boolean;
}

const EFFORT_3: Effort[] = ['low', 'medium', 'high'];
const EFFORT_4: Effort[] = ['low', 'medium', 'high', 'max'];
const EFFORT_5: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const GENERIC_PARAMS: ModelParams = {
  maxOutputTokens: null,
  temperature: true,
  topP: true,
  topK: false,
  stopSequences: true,
  thinking: null,
  thinkingOnByDefault: false,
  effortLevels: [],
  maxEffortWithoutThinking: null,
  temperatureOrTopP: false,
  noSamplingWhileThinking: false,
};

/** Claude family and version from a Bedrock model ID, e.g. "anthropic.claude-sonnet-4-5-20250929-v1:0" → sonnet 4.5. */
export function claudeVersion(baseId: string): { family: string; version: number } | null {
  const id = stripProfilePrefix(baseId);
  if (!/^anthropic\.claude-/.test(id)) return null;
  // New style: claude-opus-4-1-…, claude-sonnet-4-20250514…, claude-opus-5-5. A minor version is one digit on its own.
  const m = /^anthropic\.claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?!\d))?/.exec(id);
  if (m) return { family: m[1], version: Number(m[2]) + Number(m[3] ?? 0) / 10 };
  // Old style: claude-3-7-sonnet, claude-3-haiku.
  const o = /^anthropic\.claude-(\d)-(?:(\d)-)?(opus|sonnet|haiku)/.exec(id);
  if (o) return { family: o[3], version: Number(o[1]) + Number(o[2] ?? 0) / 10 };
  return { family: 'claude', version: 2 };
}

function claudeParams(family: string, v: number): ModelParams {
  const p: ModelParams = { ...GENERIC_PARAMS, topK: true, temperatureOrTopP: true, noSamplingWhileThinking: true };
  p.maxOutputTokens =
    v >= 4.6 ? 128_000 : v >= 4.5 ? 64_000 : v >= 4 ? (family === 'opus' ? 32_000 : 64_000) : v >= 3.7 ? 64_000 : v >= 3.5 ? 8_192 : 4_096;
  const always = family === 'fable' || family === 'mythos' || v >= 6 || (v >= 5.5 && (family === 'opus' || family === 'sonnet'));
  if (always || v >= 4.7) {
    // Claude 4.7 and later take no temperature, Top P or Top K.
    Object.assign(p, { temperature: false, topP: false, topK: false, temperatureOrTopP: false, noSamplingWhileThinking: false });
  }
  if (always) {
    p.thinking = 'always';
    p.effortLevels = EFFORT_5;
  } else if (v >= 4.6) {
    p.thinking = 'adaptive';
    p.effortLevels = v >= 4.7 ? EFFORT_5 : EFFORT_4;
    // Opus 4.7 and 4.8 think only when asked; Sonnet 5, Opus 5 and Haiku 5.5 think unless told not to.
    p.thinkingOnByDefault = v >= 5;
    if (family === 'opus' && v === 5) p.maxEffortWithoutThinking = 'high';
    if (family === 'haiku' && v >= 5.5) p.maxEffortWithoutThinking = 'high';
  } else if (v >= 3.7) {
    p.thinking = 'budget';
  }
  return p;
}

/** Whether a model with optional thinking will think, given the choice: "default" follows the model. */
export function thinkingOn(p: ModelParams, choice: ThinkingChoice): boolean {
  if (p.thinking === 'always' || p.thinking === 'builtin' || p.thinking === 'effort') return true;
  if (p.thinking === 'budget' || p.thinking === 'adaptive') return choice === 'on' || (choice === 'default' && p.thinkingOnByDefault);
  return false;
}

/** What a Bedrock model accepts, from its base model ID. Unknown models get the settings Converse takes for every model. */
export function bedrockModelParams(baseId: string): ModelParams {
  const id = stripProfilePrefix(baseId);
  const claude = claudeVersion(id);
  if (claude) return claudeParams(claude.family, claude.version);
  if (/^openai\.gpt-oss/.test(id)) return { ...GENERIC_PARAMS, thinking: 'effort', effortLevels: EFFORT_3 };
  if (/^deepseek\.r1/.test(id)) return { ...GENERIC_PARAMS, thinking: 'builtin' };
  if (/^amazon\.nova/.test(id)) return { ...GENERIC_PARAMS, topK: true };
  // Gemma 3 on Bedrock: 8K max output (AWS model card).
  if (/^google\.gemma-3/.test(id)) return { ...GENERIC_PARAMS, maxOutputTokens: 8_192 };
  if (/^meta\.llama3/.test(id)) return { ...GENERIC_PARAMS, maxOutputTokens: 2_048 };
  return { ...GENERIC_PARAMS };
}

// ---------- Files ----------

export type AttachmentKind = 'image' | 'document' | 'video' | 'text';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** True when plain text could be extracted (used for models without native file support). */
  hasText: boolean;
  textChars?: number;
}

// ---------- Conversations ----------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ContextReport {
  contextSize: number;
  promptTokens: number;
  droppedMessages: number;
  estimated: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  reasoning?: string;
  mode?: Mode;
  modelId?: string;
  modelName?: string;
  usage?: TokenUsage;
  latencyMs?: number;
  stopReason?: string;
  error?: string;
  notices?: string[];
  context?: ContextReport;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: Mode;
  modelId: string;
  modelName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  systemPrompt?: string;
  messages: ChatMessage[];
}

export interface SendMessageRequest {
  content: string;
  attachmentIds: string[];
  mode: Mode;
  modelId: string;
  /** Replace this user message (and drop everything after it) instead of appending. */
  editMessageId?: string;
  /** Re-run the last assistant reply. Content/attachments are ignored. */
  regenerate?: boolean;
}

/** Server-sent events emitted while a reply streams. */
export type StreamEvent =
  | { type: 'start'; userMessage?: ChatMessage; assistantMessageId: string; conversation: ConversationSummary }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'notice'; message: string }
  | { type: 'context'; context: ContextReport }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; message: string; assistantMessage?: ChatMessage };

// ---------- Usage ----------

export type UsageRange = '24h' | '7d' | '30d' | '90d';

export interface UsageModelRow {
  modelId: string;
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  errors: number;
  throttles: number;
  avgLatencyMs: number | null;
  /** null when no price is configured for this model */
  cost: number | null;
}

export interface UsageBucket {
  start: number;
  /** tokens (input + output) per model id */
  tokens: Record<string, number>;
}

export interface UsageReport {
  range: UsageRange;
  region: string;
  from: number;
  to: number;
  bucketMs: number;
  models: UsageModelRow[];
  buckets: UsageBucket[];
  totals: { requests: number; inputTokens: number; outputTokens: number; cost: number | null; pricedShare: number };
  note?: string;
}

// ---------- Status ----------

export interface HealthResponse {
  ok: true;
  name: 'open-rock';
  version: string;
  authRequired: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface DedicatedStatus {
  ok: boolean;
  message: string;
  /** The address Open Rock is calling, e.g. https://203.0.113.10 (no token). */
  endpoint: string;
  apiStyle?: 'openai' | 'ollama';
  models: string[];
  /** Context window the server reports for the selected model, when it says. */
  contextSize?: number;
  vision?: boolean;
  latencyMs?: number;
  /** How the token was sent when the check succeeded. */
  authHeader?: Exclude<DedicatedAuthHeader, 'auto'>;
  /** What the server answered to each check request, for troubleshooting (token removed). */
  details?: string[];
}

// ---------- Dedicated server addresses ----------

/**
 * Reads a server address as someone might type it: a hostname, an IP address (IPv6 with or without brackets), or a URL.
 * Returns the bare host and the port if one was given, or null if it isn't an address.
 */
export function parseServerAddress(input: string): { host: string; port?: number } | null {
  let t = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // A bare IPv6 address has several colons and no brackets.
  if (!t.startsWith('[') && (t.match(/:/g)?.length ?? 0) > 1) t = `[${t}]`;
  const m = /^(\[[^\]]+\]|[^:[\]@]+)(?::(\d+))?$/.exec(t);
  if (!m) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${m[1]}`).hostname;
  } catch {
    return null;
  }
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  if (!host) return null;
  return m[2] === undefined ? { host } : { host, port: Number(m[2]) };
}

/** Base URL of a dedicated server. Always HTTPS; port 443 is left out. */
export function serverUrl(s: { host: string; port: number }): string {
  const port = Number.isInteger(s.port) && s.port > 0 && s.port <= 65535 ? s.port : 443;
  const host = s.host.includes(':') && !s.host.startsWith('[') ? `[${s.host}]` : s.host;
  return `https://${host}${port === 443 ? '' : `:${port}`}`;
}

/** host[:port] for display, e.g. "gemma.example.com" or "203.0.113.10:8443". */
export function serverAddress(s: { host: string; port: number }): string {
  return serverUrl(s).slice('https://'.length);
}

// ---------- Context estimation (shared so the client meter matches the server) ----------

export interface EstimateInput {
  role: 'user' | 'assistant' | 'system';
  text: string;
  images: number;
}

export function estimateTokens(msg: EstimateInput, charsPerToken: number, imageTokens: number): number {
  const cpt = charsPerToken > 0 ? charsPerToken : 3.6;
  return Math.ceil(msg.text.length / cpt) + msg.images * imageTokens + 6;
}

export function stripProfilePrefix(id: string): string {
  // us.anthropic.claude-… → anthropic.claude-…
  const m = /^(us|eu|apac|global|us-gov|jp|au|ca|apne|uk)\.(.+)$/.exec(id);
  return m ? m[2] : id;
}

export function findPrice(pricing: Record<string, ModelPrice>, modelId: string): ModelPrice | null {
  const base = stripProfilePrefix(modelId);
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(pricing)) {
    if (!key) continue;
    if (base === key || base.includes(key) || modelId.includes(key)) {
      if (!best || key.length > best.key.length) best = { key, price };
    }
  }
  return best ? best.price : null;
}

export function costFor(price: ModelPrice | null, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | null {
  if (!price) return null;
  return (
    (u.inputTokens * price.input +
      u.outputTokens * price.output +
      (u.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input) +
      (u.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) /
    1_000_000
  );
}
