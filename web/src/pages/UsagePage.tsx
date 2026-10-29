import { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Menu, RefreshCw } from 'lucide-react';
import type { UsageRange, UsageReport } from '@open-rock/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { compact, duration, full, money } from '../lib/format';
import { Segmented } from '../components/fields';

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const SLOTS = 7;
const OTHER = '__other__';

interface Series {
  key: string;
  name: string;
  color: string;
}

/** Give each model a stable color slot so it keeps its color when the range changes. */
function useSeries(report: UsageReport | null): { series: Series[]; seriesOf: (modelId: string) => string } {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const result = useMemo(() => {
    if (!report) return { series: [] as Series[], map: new Map<string, string>(), slots: prefs.colorSlots, changed: false };
    const slots = { ...prefs.colorSlots };
    let changed = false;
    const ranked = report.models; // already sorted by tokens
    const used = new Set<number>();
    const series: Series[] = [];
    const map = new Map<string, string>();
    for (const m of ranked) {
      if (series.length >= SLOTS) {
        map.set(m.modelId, OTHER);
        continue;
      }
      let slot = slots[m.modelId];
      if (slot === undefined || used.has(slot)) {
        const free = Array.from({ length: SLOTS }, (_, i) => i).find((i) => !used.has(i) && !Object.values(slots).includes(i)) ??
          Array.from({ length: SLOTS }, (_, i) => i).find((i) => !used.has(i))!;
        slot = free;
        slots[m.modelId] = slot;
        changed = true;
      }
      used.add(slot);
      series.push({ key: m.modelId, name: m.name, color: `var(--series-${slot + 1})` });
      map.set(m.modelId, m.modelId);
    }
    if (ranked.length > SLOTS) series.push({ key: OTHER, name: `${ranked.length - SLOTS} other models`, color: 'var(--series-other)' });
    return { series, map, slots, changed };
  }, [report, prefs.colorSlots]);

  useEffect(() => {
    if (result.changed) setPrefs({ colorSlots: result.slots });
  }, [result, setPrefs]);

  return { series: result.series, seriesOf: (id: string) => result.map.get(id) ?? OTHER };
}

export function UsagePage() {
  const setSidebar = useStore((s) => s.setSidebar);
  const region = useStore((s) => s.settings?.aws.region);
  const [range, setRange] = useState<UsageRange>('7d');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .usage(range)
      .then((r) => live && setReport(r))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [range, nonce]);

  const { series, seriesOf } = useSeries(report);
  const totals = report?.totals;
  const totalTokens = totals ? totals.inputTokens + totals.outputTokens : 0;
  const empty = report && report.models.length === 0;

  return (
    <div className="page usage-page">
      <header className="page-head">
        <button className="icon-btn menu-btn" onClick={() => setSidebar(true)} aria-label="Open chats">
          <Menu size={18} />
        </button>
        <h1>Bedrock usage</h1>
      </header>
      <div className="page-body">
        <div className="filters">
          <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
          <button className="btn btn-quiet" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
            {loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            Refresh
          </button>
        </div>
        <p className="usage-note">
          Counted from the requests Open Rock sends to Bedrock{region ? ` in ${region}` : ''}. Costs are estimates from the prices in Settings; your AWS bill is
          the final word.
        </p>

        {error && <p className="test-result bad">{error}</p>}

        {report && (
          <div className={`usage-body${loading ? ' refetching' : ''}`}>
            {empty ? (
              <div className="usage-empty">
                <h2>No Bedrock usage in this range</h2>
                <p>Chats you send in Variable mode show up here, broken down by model.</p>
                <a className="btn btn-primary" href="#/">
                  Start a chat
                </a>
              </div>
            ) : (
              <>
                <div className="kpis">
                  <div className="kpi hero">
                    <span className="kpi-label">{totals!.cost !== null ? 'Estimated cost' : 'Tokens'}</span>
                    <span className="kpi-value">{totals!.cost !== null ? money(totals!.cost) : compact(totalTokens)}</span>
                    {totals!.cost !== null && totals!.pricedShare < 0.999 && (
                      <span className="kpi-sub">
                        Prices cover {Math.round(totals!.pricedShare * 100)}% of tokens. <a href="#/settings/variable">Add prices</a>
                      </span>
                    )}
                    {totals!.cost === null && (
                      <span className="kpi-sub">
                        <a href="#/settings/variable">Add prices</a> to see estimated cost.
                      </span>
                    )}
                  </div>
                  <div className="kpi">
                    <span className="kpi-label">Requests</span>
                    <span className="kpi-value">{full(totals!.requests)}</span>
                  </div>
                  <div className="kpi">
                    <span className="kpi-label">Input tokens</span>
                    <span className="kpi-value">{compact(totals!.inputTokens)}</span>
                  </div>
                  <div className="kpi">
                    <span className="kpi-label">Output tokens</span>
                    <span className="kpi-value">{compact(totals!.outputTokens)}</span>
                  </div>
                </div>

                <section className="chart-card" aria-labelledby="chart-title">
                  <div className="chart-head">
                    <h2 id="chart-title">Tokens per {report.bucketMs === 3600_000 ? 'hour' : 'day'}, by model</h2>
                    <ul className="legend">
                      {series.map((s) => (
                        <li key={s.key}>
                          <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                          {s.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <StackedColumns report={report} series={series} seriesOf={seriesOf} />
                </section>

                <section className="table-card" aria-labelledby="table-title">
                  <h2 id="table-title">By model</h2>
                  <div className="table-scroll">
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th scope="col">Model</th>
                          <th scope="col">Requests</th>
                          <th scope="col">Input</th>
                          <th scope="col">Output</th>
                          <th scope="col">Cached input</th>
                          <th scope="col">Avg time</th>
                          <th scope="col">Errors</th>
                          <th scope="col">Est. cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.models.map((m) => {
                          const s = series.find((x) => x.key === seriesOf(m.modelId));
                          return (
                            <tr key={m.modelId}>
                              <th scope="row">
                                <div className="tm">
                                  <span className="swatch" style={{ background: s?.color }} aria-hidden="true" />
                                  <span className="tm-name">{m.name}</span>
                                  <span className="tm-id">{m.modelId}</span>
                                </div>
                              </th>
                              <td>{full(m.requests)}</td>
                              <td title={full(m.inputTokens)}>{compact(m.inputTokens)}</td>
                              <td title={full(m.outputTokens)}>{compact(m.outputTokens)}</td>
                              <td title={`${full(m.cacheReadTokens)} read, ${full(m.cacheWriteTokens)} written`}>{compact(m.cacheReadTokens + m.cacheWriteTokens)}</td>
                              <td>{m.avgLatencyMs !== null ? duration(m.avgLatencyMs) : '–'}</td>
                              <td>{m.errors ? `${m.errors}${m.throttles ? ` (${m.throttles} throttled)` : ''}` : '0'}</td>
                              <td>{money(m.cost)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
        {!report && loading && (
          <div className="chat-loading">
            <LoaderCircle className="spin" size={18} aria-label="Loading usage" />
          </div>
        )}
      </div>
    </div>
  );
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 1000, step: 250 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { max: Math.ceil(v / step) * step, step };
}

function bucketLabel(ts: number, hourly: boolean, long = false): string {
  const d = new Date(ts);
  if (hourly) return d.toLocaleTimeString(undefined, { hour: 'numeric', ...(long ? { minute: '2-digit', weekday: 'short' } : {}) });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(long ? { weekday: 'short' } : {}) });
}

function StackedColumns({ report, series, seriesOf }: { report: UsageReport; series: Series[]; seriesOf: (id: string) => string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hourly = report.bucketMs === 3600_000;
  const columns = useMemo(
    () =>
      report.buckets.map((b) => {
        const by = new Map<string, number>();
        for (const [id, v] of Object.entries(b.tokens)) {
          const k = seriesOf(id);
          by.set(k, (by.get(k) ?? 0) + v);
        }
        const total = [...by.values()].reduce((a, v) => a + v, 0);
        return { start: b.start, by, total };
      }),
    [report, seriesOf],
  );

  const plotH = 220;
  const axisH = 26;
  const left = 44;
  const right = 8;
  const top = 8;
  const innerW = width - left - right;
  const n = columns.length;
  const slot = innerW / n;
  const barW = Math.max(2, Math.min(24, slot * 0.62));
  const { max, step } = niceMax(Math.max(...columns.map((c) => c.total)));
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 76))));
  const GAP = 2;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  const act = active !== null ? columns[active] : null;
  const tipX = active !== null ? left + slot * active + slot / 2 : 0;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={width}
        height={top + plotH + axisH}
        role="img"
        aria-label={`Stacked columns of tokens per ${hourly ? 'hour' : 'day'} by model. Use the arrow keys to read each ${hourly ? 'hour' : 'day'}.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
        className="chart-svg"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis-line' : 'grid-line'} />
            <text x={left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">
              {compact(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const cx = left + slot * i + slot / 2;
          let acc = 0;
          const segs = series.filter((s) => (c.by.get(s.key) ?? 0) > 0);
          return (
            <g key={c.start} opacity={active !== null && active !== i ? 0.55 : 1}>
              {segs.map((s, si) => {
                const v = c.by.get(s.key)!;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                const isTop = si === segs.length - 1;
                const h = Math.max(0, y0 - y1 - (si > 0 ? GAP : 0));
                const yTop = y1;
                const x = cx - barW / 2;
                if (h <= 0.5) return null;
                if (isTop) {
                  const r = Math.min(4, h, barW / 2);
                  const d = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
                  return <path key={s.key} d={d} fill={s.color} />;
                }
                return <rect key={s.key} x={x} y={yTop} width={barW} height={h} fill={s.color} />;
              })}
              {(i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery * 0.6) && (
                <text x={cx} y={top + plotH + 17} className="tick" textAnchor="middle">
                  {bucketLabel(c.start, hourly)}
                </text>
              )}
              <rect
                x={left + slot * i}
                y={top}
                width={slot}
                height={plotH}
                fill="transparent"
                onPointerMove={() => setActive(i)}
                onPointerDown={() => setActive(i)}
              />
            </g>
          );
        })}
        {active !== null && <line x1={tipX} x2={tipX} y1={top} y2={top + plotH} className="crosshair" />}
      </svg>
      {act && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(tipX, 90), width - 90) }} role="status">
          <div className="tip-title">{bucketLabel(act.start, hourly, true)}</div>
          {act.total === 0 ? (
            <div className="tip-row muted">No requests</div>
          ) : (
            series
              .filter((s) => (act.by.get(s.key) ?? 0) > 0)
              .reverse()
              .map((s) => (
                <div className="tip-row" key={s.key}>
                  <span className="tip-key" style={{ background: s.color }} aria-hidden="true" />
                  <strong>{full(act.by.get(s.key)!)}</strong>
                  <span>{s.name}</span>
                </div>
              ))
          )}
          {act.total > 0 && series.filter((s) => (act.by.get(s.key) ?? 0) > 0).length > 1 && (
            <div className="tip-row tip-total">
              <strong>{full(act.total)}</strong>
              <span>Total</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
