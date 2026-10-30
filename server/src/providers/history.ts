import type { NeutralMessage } from './types.js';

/**
 * Make history safe for strict chat templates (Bedrock, Gemma and other local models): no empty assistant turns,
 * strictly alternating roles, starts and ends with the user.
 */
export function normalizeHistory(messages: NeutralMessage[]): NeutralMessage[] {
  const out: NeutralMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && !m.text.trim()) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.text = [prev.text, m.text].filter((t) => t.trim()).join('\n\n');
      prev.attachments = [...prev.attachments, ...m.attachments];
      continue;
    }
    out.push({ role: m.role, text: m.text, attachments: [...m.attachments] });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

/** Wrap an extracted file's text so the model knows where it came from. */
export function fileAsText(name: string, text: string): string {
  return `<file name="${name.replace(/"/g, "'")}">\n${text}\n</file>`;
}

export function omittedNote(name: string, why: string): string {
  return `[Attached file "${name}" was left out: ${why}]`;
}
