/**
 * Small, dependency-free SVG charts for IntervueX, following the data-viz method:
 * thin 2px lines, recessive grid, crosshair + tooltip on hover, legend for >= 2 series plus direct end labels,
 * a "view as table" fallback, and colours from a validated palette (see --viz-* tokens in styles.css).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export const VIZ = { brand: 'var(--viz-brand)', s1: 'var(--viz-1)', s2: 'var(--viz-2)', s3: 'var(--viz-3)' };
const SERIES_ORDER = [VIZ.s1, VIZ.s2, VIZ.s3];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null); const [w, setW] = useState(280);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(e => setW(Math.max(240, Math.floor(e[0].contentRect.width))));
    ro.observe(ref.current); return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
const niceMax = (v: number) => { if (v <= 0) return 4; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };
export const fmtNum = (v: number) => (Math.abs(v) >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : Math.abs(v) >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v * 10) / 10}`);
export const fmtINR = (v: number) => '₹' + fmtNum(v);
export const monthLabel = (k: string) => new Date(k + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
export const weekLabel = (k: string) => new Date(k + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface Series { name: string; values: number[]; color?: string }

/** Line chart over a shared x axis. One series gets a soft area fill; several get a legend and end labels. */
export function TrendChart({ series, labels, height = 220, format = fmtNum, xFormat = (x: string) => x, title }: { series: Series[]; labels: string[]; height?: number; format?: (v: number) => string; xFormat?: (x: string) => string; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null); const [table, setTable] = useState(false);
  const multi = series.length > 1;
  const colored = series.map((s, i) => ({ ...s, color: s.color ?? (multi ? SERIES_ORDER[i] : VIZ.brand) }));
  const pad = { l: 44, r: multi ? 56 : 16, t: 12, b: 26 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
  const n = labels.length;
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const total = (s: Series) => s.values.reduce((a, b) => a + b, 0);
  const summary = `${title}: ` + colored.map(s => `${s.name} total ${format(total(s))}, latest ${format(s.values[n - 1] ?? 0)}`).join('; ');
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * iw;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / Math.max(1, iw)) * (n - 1)))));
  };
  const gid = useMemo(() => 'g' + Math.random().toString(36).slice(2, 8), []);
  return (
    <div className="relative w-full min-w-0" ref={ref}>
      {(multi) && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted" aria-hidden>
          {colored.map(s => <span key={s.name} className="flex items-center gap-1.5"><span className="h-[3px] w-4 rounded-full" style={{ background: s.color }} />{s.name}</span>)}
        </div>
      )}
      {!table && series.every(s => s.values.every(v => !v)) ? (
        <div className="grid place-items-center rounded-xl border border-dashed border-line text-[13.5px] text-muted" style={{ height }}>No activity recorded in this period yet</div>
      ) : table ? (
        <div className="table-wrap max-h-[260px] overflow-auto"><table><thead><tr><th>Period</th>{colored.map(s => <th key={s.name} className="right">{s.name}</th>)}</tr></thead>
          <tbody>{labels.map((l, i) => <tr key={l}><td>{xFormat(l)}</td>{colored.map(s => <td key={s.name} className="right tabular-nums">{format(s.values[i] ?? 0)}</td>)}</tr>)}</tbody></table></div>
      ) : (
        <svg width={width} height={height} role="img" aria-label={summary} className="block overflow-visible">
          <defs><linearGradient id={gid} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={colored[0]?.color} stopOpacity="0.18" /><stop offset="100%" stopColor={colored[0]?.color} stopOpacity="0" /></linearGradient></defs>
          {ticks.map(t => <g key={t}><line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} stroke="rgb(var(--line))" strokeDasharray={t === 0 ? undefined : '3 4'} /><text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">{format(t)}</text></g>)}
          {labels.map((l, i) => (i % step === 0 || i === n - 1) && <text key={l} x={x(i)} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]">{xFormat(l)}</text>)}
          {!multi && colored[0] && n > 1 && <path d={`${path(colored[0].values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#${gid})`} />}
          {colored.map(s => <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {multi && colored.map(s => n > 0 && <text key={s.name + 'end'} x={x(n - 1) + 8} y={y(s.values[n - 1] ?? 0)} dy="0.32em" className="fill-ink text-[11px] font-semibold tabular-nums">{format(s.values[n - 1] ?? 0)}</text>)}
          {hover != null && <>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="rgb(var(--muted))" strokeOpacity="0.5" />
            {colored.map(s => <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4.5} fill={s.color} stroke="rgb(var(--surface))" strokeWidth={2} />)}
          </>}
          <rect x={pad.l} y={pad.t} width={Math.max(1, iw)} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
      )}
      {hover != null && !table && (
        <div className="pointer-events-none absolute z-10 min-w-[140px] rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px] shadow-lift"
          style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 160), top: multi ? 24 : 0 }}>
          <div className="mb-1 font-semibold">{xFormat(labels[hover])}</div>
          {colored.map(s => <div key={s.name} className="flex items-center justify-between gap-4"><span className="flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span><b className="tabular-nums">{format(s.values[hover] ?? 0)}</b></div>)}
        </div>
      )}
      <button type="button" onClick={() => setTable(t => !t)} className="mt-1 text-[12px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline">{table ? 'View as chart' : 'View as table'}</button>
    </div>
  );
}

/** Ranked horizontal bars with direct value labels (magnitude in one hue). */
export function BarList({ items, format = fmtNum, color = VIZ.brand, empty = 'No data yet', onClick }: { items: Array<{ label: ReactNode; value: number; key?: string; hint?: string }>; format?: (v: number) => string; color?: string; empty?: string; onClick?: (key: string) => void }) {
  const max = Math.max(1, ...items.map(i => i.value));
  if (!items.length) return <div className="py-6 text-center text-[13.5px] text-muted">{empty}</div>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {items.map((it, i) => (
        <li key={it.key ?? i} title={`${typeof it.label === 'string' ? it.label : ''}: ${format(it.value)}${it.hint ? ` · ${it.hint}` : ''}`}
          className={`group grid grid-cols-[minmax(90px,38%)_1fr_auto] items-center gap-3 rounded-lg px-1 py-0.5 text-[13.5px] ${onClick ? 'cursor-pointer hover:bg-raised/60' : ''}`} onClick={() => it.key && onClick?.(it.key)}>
          <span className="truncate">{it.label}</span>
          <span className="h-2.5 rounded-full bg-raised"><span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(it.value > 0 ? 2 : 0, (it.value / max) * 100)}%`, background: color }} /></span>
          <span className="min-w-[2.5rem] text-right font-semibold tabular-nums">{format(it.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tiny trend line for table rows; the title carries the values for hover and screen readers. */
export function Sparkline({ values, labels, width = 96, height = 28, color = VIZ.brand }: { values: number[]; labels?: string[]; width?: number; height?: number; color?: string }) {
  const max = Math.max(1, ...values); const n = values.length;
  const x = (i: number) => 2 + (n <= 1 ? 0 : (i / (n - 1)) * (width - 4)); const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const desc = values.map((v, i) => `${labels?.[i] ? weekLabel(labels[i]) : `#${i + 1}`}: ${v}`).join(', ');
  return (
    <svg width={width} height={height} role="img" aria-label={`Weekly interviews: ${desc}`} className="block"><title>{`Interviews per week — ${desc}`}</title>
      <line x1={2} x2={width - 2} y1={height - 3} y2={height - 3} stroke="rgb(var(--line))" />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && <circle cx={x(n - 1)} cy={y(values[n - 1])} r={2.5} fill={color} />}
    </svg>
  );
}
