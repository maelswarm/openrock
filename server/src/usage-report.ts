import { costFor, findPrice, type Settings, type UsageBucket, type UsageModelRow, type UsageRange, type UsageReport } from '@open-rock/shared';
import { allUsage } from './store/usage.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Bucket boundaries in UTC ms. Day buckets start at the viewer's local midnight;
 * tzOffsetMin is the browser's Date#getTimezoneOffset() (minutes behind UTC).
 */
function rangeSpec(range: UsageRange, now: number, tzOffsetMin: number): { fromUtc: number; toUtc: number; bucketMs: number } {
  if (range === '24h') {
    const toUtc = Math.ceil(now / HOUR) * HOUR;
    return { fromUtc: toUtc - 24 * HOUR, toUtc, bucketMs: HOUR };
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const off = tzOffsetMin * 60_000;
  const localNow = now - off;
  const endLocal = Math.floor(localNow / DAY) * DAY + DAY;
  const toUtc = endLocal + off;
  return { fromUtc: toUtc - days * DAY, toUtc, bucketMs: DAY };
}

/** Bedrock usage per model, from the requests Open Rock has sent. */
export function usageReport(settings: Settings, range: UsageRange, tzOffsetMin = 0): UsageReport {
  const { fromUtc, toUtc, bucketMs } = rangeSpec(range, Date.now(), tzOffsetMin);

  const rows = new Map<string, UsageModelRow & { latencySum: number; latencyN: number }>();
  const bucketCount = Math.round((toUtc - fromUtc) / bucketMs);
  const buckets: UsageBucket[] = Array.from({ length: bucketCount }, (_, i) => ({ start: fromUtc + i * bucketMs, tokens: {} }));

  for (const r of allUsage()) {
    if (r.mode !== 'bedrock' || r.ts < fromUtc || r.ts >= toUtc) continue;
    let row = rows.get(r.modelId);
    if (!row) {
      row = {
        modelId: r.modelId,
        name: r.modelName || r.modelId,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        errors: 0,
        throttles: 0,
        avgLatencyMs: null,
        cost: null,
        latencySum: 0,
        latencyN: 0,
      };
      rows.set(r.modelId, row);
    }
    row.requests++;
    row.inputTokens += r.inputTokens;
    row.outputTokens += r.outputTokens;
    row.cacheReadTokens += r.cacheReadTokens;
    row.cacheWriteTokens += r.cacheWriteTokens;
    if (!r.ok) row.errors++;
    if (r.throttled) row.throttles++;
    if (r.ok && r.latencyMs) {
      row.latencySum += r.latencyMs;
      row.latencyN++;
    }
    const bi = Math.floor((r.ts - fromUtc) / bucketMs);
    const b = buckets[bi];
    if (b) b.tokens[r.modelId] = (b.tokens[r.modelId] ?? 0) + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  }

  let cost = 0;
  let pricedTokens = 0;
  let allTokens = 0;
  const models: UsageModelRow[] = [];
  for (const row of rows.values()) {
    const price = findPrice(settings.bedrock.pricing, row.modelId);
    row.cost = costFor(price, row);
    row.avgLatencyMs = row.latencyN ? Math.round(row.latencySum / row.latencyN) : null;
    const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    allTokens += tokens;
    if (row.cost !== null) {
      cost += row.cost;
      pricedTokens += tokens;
    }
    const { latencySum: _s, latencyN: _n, ...clean } = row;
    models.push(clean);
  }
  models.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  return {
    range,
    region: settings.aws.region,
    from: fromUtc,
    to: toUtc,
    bucketMs,
    models,
    buckets,
    totals: {
      requests: models.reduce((a, m) => a + m.requests, 0),
      inputTokens: models.reduce((a, m) => a + m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens, 0),
      outputTokens: models.reduce((a, m) => a + m.outputTokens, 0),
      cost: pricedTokens > 0 ? cost : null,
      pricedShare: allTokens ? pricedTokens / allTokens : 1,
    },
  };
}
