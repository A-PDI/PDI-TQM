import { useEffect, useId, useRef, useState } from 'react';

/** Chart roles (light surface only; the app has no dark theme). Status steps are fixed and always paired with a label. */
export const VIZ = {
  surface: '#ffffff',
  grid: '#e6e8ec',
  axis: '#6b7280',
  text: '#1f2937',
  series1: '#2a78d6',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
};

export interface ColumnSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Integer-friendly axis maximum and step with at most four gridlines above zero. */
function niceScale(max: number) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
  return { top: Math.ceil(max / step) * step, step };
}

/** Rounded data-end (top), square at the baseline. */
const topRounded = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};

/**
 * Column chart (stacked when given several series) for counts over time. One axis, thin columns,
 * 2px surface gaps between stacked segments, per-column hover/focus tooltip and a table view.
 */
export function ColumnChart({ title, categories, series, formatCategory = (c) => c, height = 190 }: { title: string; categories: string[]; series: ColumnSeries[]; formatCategory?: (c: string) => string; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const totals = categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const { top, step } = niceScale(Math.max(0, ...totals));
  const m = { l: 34, r: 8, t: 10, b: 24 };
  const innerW = Math.max(0, width - m.l - m.r);
  const innerH = height - m.t - m.b;
  const band = categories.length ? innerW / categories.length : 0;
  const barW = Math.max(4, Math.min(24, band * 0.6));
  const y = (v: number) => m.t + innerH - (v / top) * innerH;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const labelEvery = Math.max(1, Math.ceil(46 / Math.max(band, 1)));

  return (
    <figure className="viz" aria-labelledby={titleId} style={{ margin: 0 }}>
      <figcaption id={titleId} className="viz-title">
        {title}
      </figcaption>
      {series.length > 1 && (
        <div className="viz-legend" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key}>
              <span className="viz-swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setActive(null)}>
        {categories.length === 0 ? (
          <div className="empty small">No data in this period.</div>
        ) : (
          width > 0 && (
            <svg width={width} height={height} role="group" aria-label={`${title}: ${categories.length} periods, total ${totals.reduce((a, b) => a + b, 0)}`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke={VIZ.grid} strokeWidth={1} />
                  <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={VIZ.axis}>
                    {t}
                  </text>
                </g>
              ))}
              {categories.map((c, i) => {
                const cx = m.l + band * i + band / 2;
                let base = 0;
                const visible = series.filter((s) => (s.values[i] ?? 0) > 0);
                return (
                  <g key={c}>
                    {visible.map((s, k) => {
                      const v = s.values[i]!;
                      const y0 = y(base);
                      const y1 = y(base + v);
                      base += v;
                      const gap = k > 0 ? 2 : 0;
                      const h = Math.max(1, y0 - y1 - gap);
                      const yTop = y0 - gap - h;
                      return k === visible.length - 1 ? (
                        <path key={s.key} d={topRounded(cx - barW / 2, yTop, barW, h, 4)} fill={s.color} />
                      ) : (
                        <rect key={s.key} x={cx - barW / 2} y={yTop} width={barW} height={h} fill={s.color} />
                      );
                    })}
                    {i % labelEvery === 0 && (
                      <text x={cx} y={height - 6} textAnchor="middle" fontSize={11} fill={VIZ.axis}>
                        {formatCategory(c)}
                      </text>
                    )}
                    <rect
                      x={m.l + band * i}
                      y={m.t}
                      width={band}
                      height={innerH}
                      fill="transparent"
                      tabIndex={0}
                      role="img"
                      aria-label={`${formatCategory(c)}: ${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join(', ')}`}
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive(null)}
                    />
                  </g>
                );
              })}
              <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} stroke={VIZ.axis} strokeWidth={1} />
            </svg>
          )
        )}
        {active !== null && categories[active] !== undefined && (
          <div
            className="viz-tip"
            role="status"
            style={{ left: Math.min(Math.max(0, m.l + band * active + band / 2 - 70), Math.max(0, width - 150)), top: 0 }}
          >
            <strong>{formatCategory(categories[active]!)}</strong>
            {series.map((s) => (
              <div key={s.key}>
                <span className="viz-swatch" style={{ background: s.color }} />
                {s.label}: {s.values[active] ?? 0}
              </div>
            ))}
            {series.length > 1 && <div>Total: {totals[active]}</div>}
          </div>
        )}
      </div>
      <details className="small">
        <summary>Table view</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Period</th>
                {series.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((c, i) => (
                <tr key={c}>
                  <td>{formatCategory(c)}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.values[i] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole-date period (both ends included) kept in the URL so a view can be shared and reproduced. */
export function PeriodFilter({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  useEffect(() => {
    setF(from);
    setT(to);
  }, [from, to]);
  const preset = (days: number) => onChange(isoDay(new Date(Date.now() - (days - 1) * 86_400_000)), isoDay(new Date()));
  return (
    <form
      className="row-actions"
      aria-label="Report period"
      onSubmit={(e) => {
        e.preventDefault();
        if (f && t) onChange(f, t);
      }}
    >
      <label className="small" htmlFor="period-from">
        From
      </label>
      <input id="period-from" type="date" value={f} max={t || undefined} onChange={(e) => setF(e.target.value)} style={{ width: 'auto' }} />
      <label className="small" htmlFor="period-to">
        To
      </label>
      <input id="period-to" type="date" value={t} min={f || undefined} onChange={(e) => setT(e.target.value)} style={{ width: 'auto' }} />
      <button type="submit" className="btn btn-small btn-primary">
        Apply
      </button>
      {[30, 90, 365].map((d) => (
        <button key={d} type="button" className="btn btn-small" onClick={() => preset(d)}>
          Last {d} days
        </button>
      ))}
    </form>
  );
}

export const pctText = (r: { pass: number; of: number; percent: number | null }) => (r.of ? `${r.percent}%` : 'n/a');
