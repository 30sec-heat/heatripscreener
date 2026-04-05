import {
  SNIPER_LB,
  REVERSION_COOLDOWN_BARS,
  RSI_REV_LONG,
  RSI_REV_SHORT,
} from './constants.js';

export function rollingPercentiles(arr, lb, p1, p2) {
  const n = arr.length;
  const med = new Float64Array(n);
  const hi = new Float64Array(n);
  if (n <= lb) return { med, hi };
  const win = arr.slice(0, lb).slice();
  win.sort((a, b) => a - b);
  const i50 = Math.round((lb * p1) / 100);
  const i95 = Math.round((lb * p2) / 100);
  med[lb] = win[i50];
  hi[lb] = win[i95];
  for (let i = lb + 1; i < n; i++) {
    const rem = arr[i - lb - 1];
    const add = arr[i - 1];
    let lo2 = 0;
    let hi2 = win.length - 1;
    while (lo2 <= hi2) {
      const m = (lo2 + hi2) >> 1;
      if (win[m] < rem) lo2 = m + 1;
      else if (win[m] > rem) hi2 = m - 1;
      else {
        lo2 = m;
        break;
      }
    }
    win.splice(lo2, 1);
    lo2 = 0;
    hi2 = win.length;
    while (lo2 < hi2) {
      const m = (lo2 + hi2) >> 1;
      if (win[m] < add) lo2 = m + 1;
      else hi2 = m;
    }
    win.splice(lo2, 0, add);
    med[i] = win[i50];
    hi[i] = win[i95];
  }
  return { med, hi };
}

export function computeSniper(shown, oiAgg) {
  const n = shown.length;
  const lb = SNIPER_LB;
  const sig = new Array(n).fill(null);
  if (n <= lb + 1) return sig;
  const uv = new Float64Array(n);
  const rng = new Float64Array(n);
  const oid = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    uv[i] = Math.abs(shown[i].v * shown[i].c);
    rng[i] = shown[i].h - shown[i].l;
    oid[i] = Math.abs((oiAgg[i]?.oiC || 0) - (oiAgg[i]?.oiO || 0));
  }
  const vP = rollingPercentiles(uv, lb, 50, 95);
  const rP = rollingPercentiles(rng, lb, 50, 95);
  const oP = rollingPercentiles(oid, lb, 50, 95);
  for (let i = lb + 1; i < n; i++) {
    const vT = vP.hi[i] - vP.med[i];
    const rT = rP.hi[i] - rP.med[i];
    const oT = oP.hi[i] - oP.med[i];
    const vR = vT > 0 && uv[i - 1] - vP.med[i - 1] > vT && uv[i] - vP.med[i] <= vT;
    const rR = rT > 0 && rng[i - 1] - rP.med[i - 1] > rT && rng[i] - rP.med[i] <= rT;
    const oR = oT > 0 && oid[i - 1] - oP.med[i - 1] > oT && oid[i] - oP.med[i] <= oT;
    if (vR || rR || oR)
      sig[i] = { dir: shown[i].c >= shown[i].o ? 'up' : 'down', vol: vR, rng: rR, oi: oR };
  }
  return sig;
}

/** Mean reversion: |vol×close| crosses back under rolling p95, RSI 30/70, cooldown per side. */
export function computeReversionScreener(
  bars,
  rsiArr,
  lb = SNIPER_LB,
  cooldown = REVERSION_COOLDOWN_BARS
) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (n <= lb + 1) return out;
  const uv = new Float64Array(n);
  for (let i = 0; i < n; i++) uv[i] = Math.abs(bars[i].v * bars[i].c);
  const vP = rollingPercentiles(uv, lb, 50, 95);
  let lastLong = -Infinity;
  let lastShort = -Infinity;
  for (let i = lb + 1; i < n; i++) {
    const hi = vP.hi[i];
    const hiP = vP.hi[i - 1];
    if (
      !(uv[i - 1] > hiP && uv[i] <= hi) ||
      !(hi > 0 && hiP > 0)
    )
      continue;
    const rsi = rsiArr[i];
    if (typeof rsi !== 'number' || Number.isNaN(rsi)) continue;
    if (rsi < RSI_REV_LONG && i - lastLong > cooldown) {
      out[i] = 'long';
      lastLong = i;
    } else if (rsi > RSI_REV_SHORT && i - lastShort > cooldown) {
      out[i] = 'short';
      lastShort = i;
    }
  }
  return out;
}

/**
 * Main-chart arrows when OSC panel is on: oscillator crosses back under its rolling p95, RSI 30/70, cooldown per side.
 */
export function computeOscCrossP95Arrows(osc, p95, rsiArr, cooldown = REVERSION_COOLDOWN_BARS) {
  const n = osc.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;
  let lastLong = -Infinity;
  let lastShort = -Infinity;
  for (let i = 1; i < n; i++) {
    const o = osc[i];
    const op = osc[i - 1];
    const pv = p95[i];
    const pvp = p95[i - 1];
    if (
      typeof o !== 'number' ||
      Number.isNaN(o) ||
      typeof op !== 'number' ||
      Number.isNaN(op) ||
      typeof pv !== 'number' ||
      Number.isNaN(pv) ||
      typeof pvp !== 'number' ||
      Number.isNaN(pvp)
    )
      continue;
    if (!(op > pvp && o <= pv)) continue;
    const rsi = rsiArr[i];
    if (typeof rsi !== 'number' || Number.isNaN(rsi)) continue;
    if (rsi < RSI_REV_LONG && i - lastLong > cooldown) {
      out[i] = 'long';
      lastLong = i;
    } else if (rsi > RSI_REV_SHORT && i - lastShort > cooldown) {
      out[i] = 'short';
      lastShort = i;
    }
  }
  return out;
}

/** Range % (H−L)/L vs rolling median/p99; spike crossover + RSI 30/70. */
export function computeVolRangeSniper(bars, rsiArr, lb = SNIPER_LB) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (n <= lb + 1) return out;
  const r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const low = Math.max(bars[i].l, 1e-12);
    r[i] = Math.abs((bars[i].h - bars[i].l) / low);
  }
  const vP = rollingPercentiles(r, lb, 50, 99);
  for (let i = lb + 1; i < n; i++) {
    const spike = r[i] - vP.med[i];
    const line = vP.hi[i];
    const spPrev = r[i - 1] - vP.med[i - 1];
    const linePrev = vP.hi[i - 1];
    if (!(spPrev <= linePrev && spike > line)) continue;
    const rsi = rsiArr[i];
    if (typeof rsi !== 'number' || Number.isNaN(rsi)) continue;
    if (rsi < 30) out[i] = 'long';
    else if (rsi > 70) out[i] = 'short';
  }
  return out;
}
