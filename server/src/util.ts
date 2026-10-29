import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function newId(prefix = ''): string {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(6).toString('hex');
  return `${prefix}${t}${r}`;
}

/** Only allow IDs we generated: letters, digits, dash, underscore. */
export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{4,80}$/.test(id)) throw new HttpError(400, 'Invalid id');
  return id;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.promises.writeFile(tmp, data, mode ? { mode } : undefined);
  await fs.promises.rename(tmp, file);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) return String((err as { name: unknown }).name);
  return '';
}

export function isAbortError(err: unknown): boolean {
  const name = errorName(err);
  return name === 'AbortError' || name === 'RequestAbortedError' || (err instanceof Error && /aborted/i.test(err.message));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[…truncated ${text.length - max} characters]`;
}
