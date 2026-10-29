import type { Attachment, ContextReport, TokenUsage } from '@open-rock/shared';

export interface LoadedAttachment extends Attachment {
  bytes(): Promise<Uint8Array>;
  text(): Promise<string | null>;
}

export interface NeutralMessage {
  role: 'user' | 'assistant';
  text: string;
  attachments: LoadedAttachment[];
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: TokenUsage; latencyMs?: number }
  | { type: 'stop'; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'context'; context: ContextReport };

export interface ChatRequest {
  messages: NeutralMessage[];
  system: string;
  signal: AbortSignal;
}

/** Thrown for errors that should be shown to the person as-is. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public status = 502,
    public throttled = false,
    /** Extra lines for troubleshooting, e.g. what the server answered. */
    public details?: string[],
  ) {
    super(message);
  }
}
