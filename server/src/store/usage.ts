import fs from 'node:fs';
import type { Mode, TokenUsage } from '@open-rock/shared';
import { dataPath, ensureDir, config } from '../config.js';

export interface UsageRecord {
  ts: number;
  mode: Mode;
  modelId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number | null;
  ok: boolean;
  throttled?: boolean;
}

let records: UsageRecord[] | null = null;

function file() {
  return dataPath('usage.jsonl');
}

export function allUsage(): UsageRecord[] {
  if (records) return records;
  records = [];
  try {
    const text = fs.readFileSync(file(), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as UsageRecord);
      } catch {
        // ignore a torn line
      }
    }
  } catch {
    // no usage yet
  }
  return records;
}

export async function recordUsage(r: {
  mode: Mode;
  modelId: string;
  modelName: string;
  usage?: TokenUsage;
  latencyMs?: number;
  ok: boolean;
  throttled?: boolean;
}): Promise<void> {
  const rec: UsageRecord = {
    ts: Date.now(),
    mode: r.mode,
    modelId: r.modelId,
    modelName: r.modelName,
    inputTokens: r.usage?.inputTokens ?? 0,
    outputTokens: r.usage?.outputTokens ?? 0,
    cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
    latencyMs: r.latencyMs ?? null,
    ok: r.ok,
    throttled: r.throttled || undefined,
  };
  allUsage().push(rec);
  ensureDir(config.dataDir);
  await fs.promises.appendFile(file(), `${JSON.stringify(rec)}\n`, 'utf8');
}
