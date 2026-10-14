import React, { useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// Small multi-series line chart for live metrics: one y-axis from 0, recessive
// grid, 2px lines, a legend that doubles as direct labels (latest value per
// series) and a crosshair + tooltip on hover. Colors come from --series-N.
export default function LineChart({ title, series, times, format = (v) => String(v), height = 150, unit = '' }) {
  const { t } = useI18n();
  const fmtAgo = (ms) => (ms < 1000 ? t('dash.now') : t('dash.ago', { span: fmtSpan(Math.round(ms / 1000)) }));
  const boxRef = useRef(null);
  const [w, setW] = useState(400);
  const [hover, setHover] = useState(null); // index into times
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 400));
    ro.observe(el);
    setW(el.clientWidth || 400);
    return () => ro.disconnect();
  }, []);

  const n = times.length;
  const padL = 46; const padR = 10; const padT = 8; const padB = 20;
  const plotW = Math.max(10, w - padL - padR);
  const plotH = height - padT - padB;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  const max = niceMax(Math.max(0, ...all));
  const x = (i) => padL + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const span = n > 1 ? Math.round((times[n - 1] - times[0]) / 1000) : 0;

  function onMove(e) {
    if (n < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left - padL;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / plotW) * (n - 1)))));
  }

  const hi = hover ?? n - 1;
  return (
    <div className="chart-card">
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.name} className="legend-item">
              <span className="swatch" style={{ background: s.color }} />
              {s.name} <b>{s.values.length && s.values[hi] != null ? format(s.values[hi]) : '—'}</b>
            </span>
          ))}
        </div>
      </div>
      <div ref={boxRef} className="chart-box" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg width={w} height={height} role="img" aria-label={title}>
          {ticks.map((tv, i) => (
            <g key={i}>
              <line x1={padL} x2={padL + plotW} y1={y(tv)} y2={y(tv)} className={i === 0 ? 'axis' : 'grid'} />
              <text x={padL - 6} y={y(tv) + 4} textAnchor="end" className="tick">{format(tv)}</text>
            </g>
          ))}
          <text x={padL} y={height - 5} className="tick">{span ? `−${fmtSpan(span)}` : ''}</text>
          <text x={padL + plotW} y={height - 5} textAnchor="end" className="tick">{t('dash.now')}</text>
          {series.map((s) => {
            const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)]));
            let d = ''; let pen = false;
            for (const p of pts) {
              if (!p) { pen = false; continue; }
              d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
              pen = true;
            }
            return <path key={s.name} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
          })}
          {hover != null && n > 1 && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className="crosshair" />
              {series.map((s) => (s.values[hover] == null ? null : (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r="4" fill={s.color} className="dot" />
              )))}
            </g>
          )}
        </svg>
        {hover != null && n > 1 && (
          <div className="chart-tip" style={{ left: Math.min(x(hover) + 10, w - 170), top: 6 }}>
            <div className="count">{fmtAgo(times[n - 1] - times[hover])}</div>
            {series.map((s) => (
              <div key={s.name}><span className="swatch" style={{ background: s.color }} /> {s.name}: <b>{s.values[hover] == null ? '—' : format(s.values[hover])}</b>{unit}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
const fmtSpan = (s) => (s < 120 ? `${s} s` : `${Math.round(s / 60)} min`);
