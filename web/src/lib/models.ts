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
