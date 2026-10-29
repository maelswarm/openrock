import type { Effort } from '@open-rock/shared';

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** A model's end-of-life date. AWS gives a UTC date, so it's shown in UTC (local time could make it the day before). */
export function retireDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}

/** What Google publishes about a Gemma model, for when its server doesn't say. Unknown fields are left out. */
export interface ModelHint {
  family: string;
  contextSize: number;
  vision?: boolean;
}

/** Gemma facts from a model name as servers report it: "gemma3:27b", "google/gemma-3-1b-it", "gemma2:9b"… */
export function gemmaHint(name: string): ModelHint | null {
  const n = name.toLowerCase();
  if (!n.includes('gemma')) return null;
  if (/gemma-?3n/.test(n)) return { family: 'Gemma 3n', contextSize: 32_768 };
  if (/gemma-?3/.test(n)) {
    return /[-:_]1b\b/.test(n) ? { family: 'Gemma 3 1B', contextSize: 32_768, vision: false } : { family: 'Gemma 3', contextSize: 131_072, vision: true };
  }
  if (/gemma-?2/.test(n)) return { family: 'Gemma 2', contextSize: 8_192, vision: false };
  return null;
}
