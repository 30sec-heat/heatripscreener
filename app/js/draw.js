import { fN, fSignedN } from './format.js';
import { chartTheme } from './chart-theme.js';

/**
 * Sub-panel OHLC candles (e.g. open interest in USD).
 * `fixedAbsScale`: `{ hi, lo }` over **all loaded** history so the Y axis does not re-zoom when panning.
 * Without it, scale is taken from the visible `oiBars` only (legacy).
 * `colors`: optional { wickBull, wickBear, bull, bear, bodyLine?, bearBorder? }.
 */
export function drawOiCandlesPanel(
  ctx,
  oiBars,
  dT,
  pH,
  pL,
  xRight,
  toX,
  barW,
  wickW,
  base = 0,
  colors = null,
  label = '',
  fixedLabelY,
  edgeLabels = true,
  fixedAbsScale = null,
  showEndLabel = true
) {
  const n = oiBars.length;
  if (!n) return;
  const wbU = colors?.wickBull ?? chartTheme.wickBull;
  const wbD = colors?.wickBear ?? chartTheme.wickBear;
  const bull = colors?.bull ?? chartTheme.bull;
  const bear = colors?.bear ?? chartTheme.bear;
  const bodyLn = colors?.bodyLine ?? chartTheme.bodyLine;
  const bearBr = colors?.bearBorder ?? chartTheme.bearBorder;

  let hi;
  let lo;
  const useGlobal =
    fixedAbsScale &&
    typeof fixedAbsScale.hi === 'number' &&
    typeof fixedAbsScale.lo === 'number' &&
    isFinite(fixedAbsScale.hi) &&
    isFinite(fixedAbsScale.lo);

  if (useGlobal) {
    hi = fixedAbsScale.hi;
    lo = fixedAbsScale.lo;
  } else {
    hi = -Infinity;
    lo = Infinity;
    for (let i = 0; i < n; i++) {
      const b = oiBars[i];
      const o = b.oiO - base;
      const h = b.oiH - base;
      const l = b.oiL - base;
      const c = b.oiC - base;
      hi = Math.max(hi, h, o, c);
      lo = Math.min(lo, l, o, c);
    }
    const r = hi - lo || 1;
    hi += r * 0.08;
    lo -= r * 0.08;
  }
  const span = hi - lo || 1;
  const toYp = (v) => dT + (1 - (v - lo) / span) * pH;

  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = chartTheme.refLine;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(pL, toYp(0));
    ctx.lineTo(xRight, toYp(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const b = oiBars[i];
    const o = useGlobal ? b.oiO : b.oiO - base;
    const h = useGlobal ? b.oiH : b.oiH - base;
    const l = useGlobal ? b.oiL : b.oiL - base;
    const c = useGlobal ? b.oiC : b.oiC - base;
    const x = toX(i);
    ctx.strokeStyle = c >= o ? wbU : wbD;
    ctx.lineWidth = wickW;
    ctx.beginPath();
    ctx.moveTo(x, toYp(h));
    ctx.lineTo(x, toYp(l));
    ctx.stroke();
  }

  ctx.fillStyle = bear;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const b = oiBars[i];
    const o = useGlobal ? b.oiO : b.oiO - base;
    const c = useGlobal ? b.oiC : b.oiC - base;
    if (c >= o) continue;
    const x = toX(i);
    const top = toYp(o);
    const bot = toYp(c);
    ctx.rect(x - barW / 2, top, barW, Math.max(bot - top, 1));
  }
  ctx.fill();
  ctx.strokeStyle = bearBr;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  for (let i = 0; i < n; i++) {
    const b = oiBars[i];
    const o = useGlobal ? b.oiO : b.oiO - base;
    const c = useGlobal ? b.oiC : b.oiC - base;
    if (c >= o) continue;
    const x = toX(i);
    const top = toYp(o);
    const bot = toYp(c);
    ctx.strokeRect(x - barW / 2 + 0.5, top + 0.5, barW - 1, Math.max(bot - top - 1, 1));
  }

  ctx.fillStyle = bull;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const b = oiBars[i];
    const o = useGlobal ? b.oiO : b.oiO - base;
    const c = useGlobal ? b.oiC : b.oiC - base;
    if (c < o) continue;
    const x = toX(i);
    const top = toYp(c);
    const bot = toYp(o);
    ctx.rect(x - barW / 2, top, barW, Math.max(bot - top, 1));
  }
  ctx.fill();

  ctx.strokeStyle = bodyLn;
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const b = oiBars[i];
    const o = useGlobal ? b.oiO : b.oiO - base;
    const c = useGlobal ? b.oiC : b.oiC - base;
    if (c < o) continue;
    const x = toX(i);
    const top = toYp(c);
    const bot = toYp(o);
    ctx.rect(x - barW / 2 + 0.5, top + 0.5, barW - 1, Math.max(bot - top - 1, 0.5));
  }
  ctx.stroke();

  if (showEndLabel) {
    ctx.fillStyle = colors?.bull ?? chartTheme.oiLine;
    ctx.font = "600 8px 'IBM Plex Mono',monospace";
    ctx.textAlign = 'left';
    const lastAbs = oiBars[n - 1].oiC;
    const lastPlot = useGlobal ? lastAbs : lastAbs - base;
    let ly = toYp(lastPlot);
    ly = Math.max(dT + 8, Math.min(dT + pH - 2, ly + 3));
    if (typeof fixedLabelY === 'number' && !Number.isNaN(fixedLabelY)) ly = fixedLabelY;
    const lastBarDelta = oiBars[n - 1].oiC - oiBars[n - 1].oiO;
    const endStr = label
      ? `${label} ${fN(lastAbs)} ${fSignedN(lastBarDelta)}`
      : `${fN(lastAbs)} ${fSignedN(lastBarDelta)}`;
    ctx.fillText(endStr, toX(n - 1) + 3, ly);
  }
  if (edgeLabels) {
    ctx.fillStyle = chartTheme.gridText;
    ctx.font = "7px 'IBM Plex Mono',monospace";
    ctx.textAlign = 'left';
    const topLab = useGlobal ? hi : hi + base;
    const botLab = useGlobal ? lo : lo + base;
    ctx.fillText(fN(topLab), xRight + 2, dT + 5);
    ctx.fillText(fN(botLab), xRight + 2, dT + pH);
  }
}

export function linePanelScale(vals, dT, pH) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const v of vals) {
    hi = Math.max(hi, v);
    lo = Math.min(lo, v);
  }
  const r = hi - lo || 1;
  hi += r * 0.1;
  lo -= r * 0.1;
  const span = hi - lo;
  const toY = (v) => dT + (1 - (v - lo) / span) * pH;
  return {
    toY,
    hi,
    lo,
    last: vals.length ? vals[vals.length - 1] : 0,
  };
}

/** Spread right-end labels vertically so short tickers (Bin, Byb, …) do not overlap. */
export function staggerEndLabelYs(rawYs, dT, pH, gap = 9) {
  const top = dT + 8;
  const bot = dT + pH - 2;
  const n = rawYs.length;
  if (!n) return [];
  let ys = rawYs.map((y) => Math.max(top, Math.min(bot, y)));
  for (let iter = 0; iter < 10; iter++) {
    const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
    let changed = false;
    for (let k = 1; k < n; k++) {
      if (idx[k].y - idx[k - 1].y < gap) {
        idx[k].y = idx[k - 1].y + gap;
        changed = true;
      }
    }
    for (const it of idx) ys[it.i] = it.y;
    const maxY = Math.max(...ys);
    if (maxY > bot) {
      const s = maxY - bot;
      ys = ys.map((y) => y - s);
      changed = true;
    }
    const minY = Math.min(...ys);
    if (minY < top) {
      const s = top - minY;
      ys = ys.map((y) => y + s);
      changed = true;
    }
    if (!changed) break;
  }
  return ys;
}

/** xRight = canvas width minus right padding (same as W - pR in chart). */
export function drawLine(ctx, vals, dT, pH, pL, xRight, toX, color, fill, alpha, label, fixedLabelY) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const v of vals) {
    hi = Math.max(hi, v);
    lo = Math.min(lo, v);
  }
  const r = hi - lo || 1;
  hi += r * 0.1;
  lo -= r * 0.1;
  const toY = (v) => dT + (1 - (v - lo) / (hi - lo)) * pH;
  if (fill !== 'transparent') {
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = chartTheme.refLine;
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(pL, toY(0));
      ctx.lineTo(xRight, toY(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(0));
    for (let i = 0; i < vals.length; i++) ctx.lineTo(toX(i), toY(vals[i]));
    ctx.lineTo(toX(vals.length - 1), toY(0));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = label ? 1.5 : 1.2;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const y = toY(vals[i]);
    if (!i) ctx.moveTo(toX(i), y);
    else ctx.lineTo(toX(i), y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  const last = vals[vals.length - 1];
  let ly = toY(last);
  ly = Math.max(dT + 8, Math.min(dT + pH - 2, ly + 3));
  if (typeof fixedLabelY === 'number' && !Number.isNaN(fixedLabelY)) ly = fixedLabelY;
  ctx.fillStyle = color;
  ctx.font = "600 8px 'IBM Plex Mono',monospace";
  ctx.textAlign = 'left';
  ctx.fillText(label || (last >= 0 ? '+' : '') + fN(last), toX(vals.length - 1) + 3, ly);
  if (!label) {
    ctx.fillStyle = chartTheme.gridText;
    ctx.font = "7px 'IBM Plex Mono',monospace";
    ctx.fillText(fN(hi), xRight + 2, dT + 5);
    ctx.fillText(fN(lo), xRight + 2, dT + pH);
  }
}
