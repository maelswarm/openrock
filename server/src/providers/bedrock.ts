import {
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseStreamCommandInput,
  type DocumentFormat,
  type ImageFormat,
  type Message,
  type SystemContentBlock,
  type VideoFormat,
} from '@aws-sdk/client-bedrock-runtime';
import { bedrockModelParams, type BedrockReplySettings, type Effort, type ModelInfo, type Settings, type TokenUsage } from '@open-rock/shared';
import { friendlyAwsError, runtimeClient } from '../aws/clients.js';
import { extOf } from '../extract.js';
import { fileAsText, normalizeHistory, omittedNote } from './history.js';
import { ProviderError, type ChatRequest, type LoadedAttachment, type NeutralMessage, type ProviderEvent } from './types.js';

const DOC_FORMATS: Record<string, DocumentFormat> = { pdf: 'pdf', doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx' };
const VIDEO_FORMATS: Record<string, VideoFormat> = {
  mp4: 'mp4', mov: 'mov', mkv: 'mkv', webm: 'webm', flv: 'flv', mpeg: 'mpeg', mpg: 'mpg', wmv: 'wmv', '3gp': 'three_gp',
};
const MAX_DOC_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

export interface BedrockParams {
  modelId: string;
  model: ModelInfo;
  /** The settings this model uses: its own, or the ones for all models. */
  replies: BedrockReplySettings;
}

/** Workarounds applied after a validation error, for models whose limits aren't known up front. */
interface Relaxations {
  mergeSystem: boolean;
  docsAsText: boolean;
  dropTopP: boolean;
  dropTopK: boolean;
  dropTemperature: boolean;
  dropMaxTokens: boolean;
  dropStop: boolean;
  noStream: boolean;
  noThinking: boolean;
  noEffort: boolean;
  noDisplay: boolean;
}

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Bedrock document names: letters, digits, single spaces, hyphens, parentheses and square brackets. */
function docName(name: string, used: Set<string>): string {
  const stem = name.replace(/\.[^.]+$/, '');
  let clean = stem.replace(/[^a-zA-Z0-9\s\-()[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Document';
  let candidate = clean;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${clean} (${i++})`;
  used.add(candidate.toLowerCase());
  clean = candidate;
  return clean;
}

function imageFormat(a: LoadedAttachment): ImageFormat | null {
  if (a.mime === 'image/png') return 'png';
  if (a.mime === 'image/jpeg') return 'jpeg';
  if (a.mime === 'image/gif') return 'gif';
  if (a.mime === 'image/webp') return 'webp';
  return null;
}

async function buildMessages(
  history: NeutralMessage[],
  model: ModelInfo,
  relax: Relaxations,
  system: string,
  notices: Set<string>,
): Promise<Message[]> {
  const caps = model.capabilities;
  const msgs = normalizeHistory(history);
  // Count native media from the newest message backwards so the latest files get priority.
  let imagesLeft = caps.images ? caps.maxImages : 0;
  let docsLeft = caps.documents && !relax.docsAsText ? caps.maxDocuments : 0;
  let videoLeft = caps.video ? 1 : 0;
  const usedDocNames = new Set<string>();
  const out: Message[] = [];

  for (let mi = msgs.length - 1; mi >= 0; mi--) {
    const m = msgs[mi];
    const content: ContentBlock[] = [];
    const textParts: string[] = [];
    if (m.role === 'user') {
      for (const a of m.attachments) {
        const ext = extOf(a.name);
        if (a.kind === 'image') {
          const fmt = imageFormat(a);
          if (!caps.images) {
            notices.add(`${model.name} can't see images, so they were left out.`);
            textParts.push(omittedNote(a.name, 'this model does not accept images'));
          } else if (!fmt || a.size > MAX_IMAGE_BYTES) {
            textParts.push(omittedNote(a.name, 'image is too large or an unsupported format'));
          } else if (imagesLeft <= 0) {
            textParts.push(omittedNote(a.name, 'too many images in this conversation'));
          } else {
            imagesLeft--;
            content.push({ image: { format: fmt, source: { bytes: await a.bytes() } } });
          }
        } else if (a.kind === 'video') {
          const fmt = VIDEO_FORMATS[ext];
          if (!caps.video || !fmt) {
            notices.add(`${model.name} can't watch video, so it was left out.`);
            textParts.push(omittedNote(a.name, 'this model does not accept video'));
          } else if (a.size > MAX_VIDEO_BYTES || videoLeft <= 0) {
            textParts.push(omittedNote(a.name, 'video is over 25 MB or another video is already attached'));
          } else {
            videoLeft--;
            content.push({ video: { format: fmt, source: { bytes: await a.bytes() } } });
          }
        } else if (a.kind === 'document' && DOC_FORMATS[ext] && docsLeft > 0 && a.size <= MAX_DOC_BYTES) {
          docsLeft--;
          content.push({ document: { format: DOC_FORMATS[ext], name: docName(a.name, usedDocNames), source: { bytes: await a.bytes() } } });
        } else {
          const text = await a.text();
          if (text) {
            textParts.push(fileAsText(a.name, text));
            if (a.kind === 'document') notices.add(`Sent ${a.name} as extracted text.`);
          } else {
            textParts.push(omittedNote(a.name, 'no readable text could be extracted'));
          }
        }
      }
    }
    let text = [...textParts, m.text].filter((t) => t.trim()).join('\n\n');
    if (!text.trim()) text = m.role === 'user' ? 'Please look at the attached file.' : '…';
    content.push({ text });
    out.unshift({ role: m.role, content });
  }

  if (system.trim() && (relax.mergeSystem || !caps.systemPrompt) && out[0]?.content) {
    const first = out[0].content;
    const last = first[first.length - 1];
    if (last && 'text' in last && typeof last.text === 'string') {
      first[first.length - 1] = { text: `${system.trim()}\n\n${last.text}` };
    }
  }
  return out;
}

/** Whether this reply will think, given the model and the settings. */
export function thinksFor(baseId: string, r: BedrockReplySettings): boolean {
  const t = bedrockModelParams(baseId).thinking;
  return t === 'always' || t === 'builtin' || t === 'effort' || ((t === 'budget' || t === 'adaptive') && r.thinking);
}

/** The request for one model: only the settings it takes, within its limits. */
function inputFor(p: BedrockParams, messages: Message[], system: string, relax: Relaxations): ConverseStreamCommandInput {
  const caps = p.model.capabilities;
  const params = bedrockModelParams(p.model.baseId);
  const r = p.replies;
  const inference: NonNullable<ConverseStreamCommandInput['inferenceConfig']> = {};
  const extra: Record<string, unknown> = {};
  const limit = (n: number) => (params.maxOutputTokens ? Math.min(n, params.maxOutputTokens) : n);
  let maxTokens = r.maxTokens === null ? undefined : limit(r.maxTokens);
  const effort = r.effort && params.effortLevels.includes(r.effort) && !relax.noEffort ? r.effort : null;
  let thinkingOn = false;

  if (!relax.noThinking) {
    if (params.thinking === 'budget' && r.thinking) {
      const budget = Math.max(1024, Math.min(r.budgetTokens, (params.maxOutputTokens ?? Infinity) - 1024));
      extra.thinking = { type: 'enabled', budget_tokens: budget };
      // The budget has to fit inside max_tokens, with room left for the answer.
      if (maxTokens !== undefined) maxTokens = limit(Math.max(maxTokens, budget + 2048));
      thinkingOn = true;
    } else if (params.thinking === 'adaptive' || params.thinking === 'always') {
      thinkingOn = params.thinking === 'always' || r.thinking;
      if (thinkingOn) extra.thinking = relax.noDisplay ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' };
      else if (params.thinkingOnByDefault) extra.thinking = { type: 'disabled' };
    } else if (params.thinking === 'effort' && effort) {
      extra.reasoning_effort = effort;
    }
  }
  if (effort && (params.thinking === 'adaptive' || params.thinking === 'always')) {
    // Some models only turn thinking off at effort high or below.
    const cap = !thinkingOn ? params.maxEffortWithoutThinking : null;
    const level = cap && EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(cap) ? cap : effort;
    extra.output_config = { effort: level };
  }

  if (!(thinkingOn && params.noSamplingWhileThinking)) {
    if (params.temperature && r.temperature !== null && !relax.dropTemperature) inference.temperature = r.temperature;
    if (params.topP && r.topP !== null && !relax.dropTopP && !(params.temperatureOrTopP && inference.temperature !== undefined)) inference.topP = r.topP;
    if (params.topK && r.topK !== null && !relax.dropTopK) {
      if (p.model.baseId.startsWith('amazon.nova')) extra.inferenceConfig = { topK: r.topK };
      else extra.top_k = r.topK;
    }
  }
  if (maxTokens !== undefined && !relax.dropMaxTokens) inference.maxTokens = maxTokens;
  if (params.stopSequences && r.stopSequences.length && !relax.dropStop) inference.stopSequences = r.stopSequences.slice(0, 4);

  const input: ConverseStreamCommandInput = { modelId: p.modelId, messages, inferenceConfig: inference };
  if (system.trim() && caps.systemPrompt && !relax.mergeSystem) {
    input.system = [{ text: system.trim() } as SystemContentBlock];
  }
  if (Object.keys(extra).length) input.additionalModelRequestFields = extra as ConverseStreamCommandInput['additionalModelRequestFields'];
  return input;
}

function usageFrom(u: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined): TokenUsage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadInputTokens || undefined,
    cacheWriteTokens: u?.cacheWriteInputTokens || undefined,
  };
}

/** Decide whether a ValidationException can be fixed by relaxing the request. Returns a notice, or null if not. */
function relaxFor(err: unknown, relax: Relaxations, hasDocs: boolean, hasSystem: boolean, wantsThinking: boolean): string | null {
  const name = (err as { name?: string })?.name ?? '';
  const msg = (err as { message?: string })?.message ?? '';
  if (name !== 'ValidationException') return null;
  if (hasDocs && !relax.docsAsText && /document/i.test(msg)) {
    relax.docsAsText = true;
    return 'This model rejected file attachments, so documents were sent as extracted text.';
  }
  if (hasSystem && !relax.mergeSystem && /system/i.test(msg)) {
    relax.mergeSystem = true;
    return "This model doesn't take a separate system prompt, so it was added to your message.";
  }
  // Checked before thinking: their errors can mention thinking too.
  if (!relax.noDisplay && /display/i.test(msg)) {
    relax.noDisplay = true;
    return null;
  }
  if (!relax.noEffort && /effort|output_config/i.test(msg)) {
    relax.noEffort = true;
    return "This model didn't take the effort setting, so its default was used.";
  }
  if (wantsThinking && !relax.noThinking && /thinking|reasoning|budget/i.test(msg)) {
    relax.noThinking = true;
    return "This model doesn't support extended thinking, so it was turned off for this reply.";
  }
  if (!relax.dropTopK && /top_?k|topK/i.test(msg)) {
    relax.dropTopK = true;
    return null;
  }
  if (!relax.dropTopP && /top_?p|topP/i.test(msg)) {
    relax.dropTopP = true;
    return null;
  }
  if (!relax.dropTemperature && /temperature/i.test(msg)) {
    relax.dropTemperature = true;
    return null;
  }
  if (!relax.dropMaxTokens && /max_?tokens|maxTokens|max_gen_len|max tokens/i.test(msg)) {
    relax.dropMaxTokens = true;
    return "The max-tokens setting is above this model's limit, so the model's default was used.";
  }
  if (!relax.dropStop && /stop_?sequences|stopSequences/i.test(msg)) {
    relax.dropStop = true;
    return "This model doesn't take stop sequences, so they were left out.";
  }
  if (!relax.noStream && /stream/i.test(msg)) {
    relax.noStream = true;
    return null;
  }
  return null;
}

export async function* bedrockChat(settings: Settings, p: BedrockParams, req: ChatRequest): AsyncGenerator<ProviderEvent> {
  const client = runtimeClient(settings.aws);
  const relax: Relaxations = {
    mergeSystem: false,
    docsAsText: false,
    dropTopP: false,
    dropTopK: false,
    dropTemperature: false,
    dropMaxTokens: false,
    dropStop: false,
    noStream: !p.model.capabilities.streaming,
    noThinking: false,
    noEffort: false,
    noDisplay: false,
  };
  const hasDocs = req.messages.some((m) => m.attachments.some((a) => a.kind === 'document'));
  const hasSystem = !!req.system.trim();
  const wantsThinking = thinksFor(p.model.baseId, p.replies);

  for (let attempt = 0; attempt < 8; attempt++) {
    const notices = new Set<string>();
    const messages = await buildMessages(req.messages, p.model, relax, req.system, notices);
    if (!messages.length) throw new ProviderError('There is no message to send.', 400);
    const input = inputFor(p, messages, req.system, relax);
    let emitted = false;
    try {
      for (const n of notices) yield { type: 'notice', message: n };
      if (relax.noStream) {
        const started = Date.now();
        const res = await client.send(new ConverseCommand(input), { abortSignal: req.signal });
        for (const block of res.output?.message?.content ?? []) {
          if (block.reasoningContent?.reasoningText?.text) yield { type: 'reasoning', text: block.reasoningContent.reasoningText.text };
          if (block.text) {
            emitted = true;
            yield { type: 'delta', text: block.text };
          }
        }
        yield { type: 'usage', usage: usageFrom(res.usage), latencyMs: res.metrics?.latencyMs ?? Date.now() - started };
        yield { type: 'stop', reason: res.stopReason ?? 'end_turn' };
        return;
      }
      const res = await client.send(new ConverseStreamCommand(input), { abortSignal: req.signal });
      if (!res.stream) throw new ProviderError('Bedrock returned no stream.');
      for await (const ev of res.stream) {
        if (ev.contentBlockDelta?.delta) {
          const d = ev.contentBlockDelta.delta;
          if (typeof d.text === 'string' && d.text) {
            emitted = true;
            yield { type: 'delta', text: d.text };
          } else if (d.reasoningContent && 'text' in d.reasoningContent && d.reasoningContent.text) {
            emitted = true;
            yield { type: 'reasoning', text: d.reasoningContent.text };
          }
        } else if (ev.messageStop) {
          yield { type: 'stop', reason: ev.messageStop.stopReason ?? 'end_turn' };
        } else if (ev.metadata) {
          yield { type: 'usage', usage: usageFrom(ev.metadata.usage), latencyMs: ev.metadata.metrics?.latencyMs };
        } else {
          const errEv = ev.internalServerException ?? ev.modelStreamErrorException ?? ev.serviceUnavailableException ?? ev.throttlingException ?? ev.validationException;
          if (errEv) throw errEv;
        }
      }
      return;
    } catch (err) {
      if (req.signal.aborted) throw err;
      if (!emitted) {
        const before = JSON.stringify(relax);
        const notice = relaxFor(err, relax, hasDocs, hasSystem, wantsThinking);
        if (JSON.stringify(relax) !== before) {
          if (notice) yield { type: 'notice', message: notice };
          continue;
        }
      }
      const name = (err as { name?: string })?.name ?? '';
      throw new ProviderError(friendlyAwsError(err), 502, name === 'ThrottlingException');
    }
  }
  throw new ProviderError('Bedrock rejected the request after several adjustments. Try a different model.');
}
