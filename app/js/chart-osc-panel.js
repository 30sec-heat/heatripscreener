import { chartTheme } from './chart-theme.js';
import { computeOscillator, rollingOscQuantile } from './oscillator.js';
import { computeRSI } from './rsi.js';
import { computeOscCrossP95Arrows } from './sniper.js';

export const oscCache = { k: '', arr: [], p95: [], rsi: [], oscCrossSig: [] };

export function invalidateOscDerived() {
  oscCache.k = '';
}

export function ensureOscDerived(all, tf) {
  const k = all.length + ':' + tf + ':' + (all[all.length - 1]?.t ?? 0);
  if (k === oscCache.k) return;
  oscCache.k = k;
  oscCache.arr = computeOscillator(all, 100, 14);
  oscCache.p95 = rollingOscQuantile(oscCache.arr, 1000, 0.95);
  oscCache.rsi = computeRSI(all, 14);
  oscCache.oscCrossSig = computeOscCrossP95Arrows(
    oscCache.arr,
    oscCache.p95,
    oscCache.rsi,
  );
}

export function drawOscPanel(ctx, vals, p95Vals, dT, pH, pL, xRight, toX, lineFill = null) {
  const lineC = lineFill?.line ?? chartTheme.oscLine;
  const fillC = lineFill?.fill ?? chartTheme.oscFill;
  const lo = 1;
  const hi = 100;
  const toYv = (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return dT + pH * 0.5;
    const t = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo);
    return dT + pH - t * pH;
  };
  ctx.strokeStyle = chartTheme.oscMid;
  ctx.lineWidth = 0.5;
  for (const pv of [25, 50, 75]) {
    const y = toYv(pv);
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  const pts = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (typeof v === 'number' && !Number.isNaN(v)) pts.push({ i, y: toYv(v) });
  }
  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(toX(pts[0].i), pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(toX(pts[k].i), pts[k].y);
    ctx.strokeStyle = lineC;
    ctx.lineWidth = 1.15;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX(pts[0].i), dT + pH);
    for (let k = 0; k < pts.length; k++) ctx.lineTo(toX(pts[k].i), pts[k].y);
    ctx.lineTo(toX(pts[pts.length - 1].i), dT + pH);
    ctx.closePath();
    ctx.fillStyle = fillC;
    ctx.fill();
  }

  if (p95Vals && p95Vals.length === vals.length) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vals.length; i++) {
      const pv = p95Vals[i];
      if (typeof pv !== 'number' || Number.isNaN(pv)) {
        started = false;
        continue;
      }
      const x = toX(i);
      const y = toYv(pv);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (started) {
      ctx.strokeStyle = chartTheme.oscP95;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

export function drawPctArrows(ctx, shown, st, toX, toY) {
  const crossSig = oscCache.oscCrossSig;
  if (!crossSig.length) return;
  const h = 6;
  const w = 5;
  const off = 11;
  const sw = chartTheme.rsiArrowStrokeW;
  for (let i = 0; i < shown.length; i++) {
    const gi = st + i;
    const d = crossSig[gi];
    if (!d) continue;
    const x = toX(i);
    const c = shown[i];
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (d === 'long') {
      const y = toY(c.l) + off;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x - w, y);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fillStyle = chartTheme.rsiArrowBelowFill;
      ctx.fill();
      ctx.strokeStyle = chartTheme.rsiArrowBelowStroke;
      ctx.lineWidth = sw;
      ctx.stroke();
    } else {
      const y = toY(c.h) - off;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x - w, y);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fillStyle = chartTheme.rsiArrowAboveFill;
      ctx.fill();
      ctx.strokeStyle = chartTheme.rsiArrowAboveStroke;
      ctx.lineWidth = sw;
      ctx.stroke();
    }
  }
}
