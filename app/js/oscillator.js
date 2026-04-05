/** Rolling-window percentile (0–100) then blend; SMA(smooth) clamped to [1,100]. */

function pctRankInWindow(win, x) {
  if (win.length < 2) return 50;
  const sorted = [...win].sort((a, b) => a - b);
  let k = 0;
  while (k < sorted.length && sorted[k] < x) k++;
  return (k / (sorted.length - 1)) * 100;
}

export function computeOscillator(bars, lookback = 100, smaPeriod = 14) {
  const n = bars.length;
  const raw = new Array(n).fill(NaN);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - lookback + 1);
    const vols = [];
    const ranges = [];
    for (let j = i0; j <= i; j++) {
      vols.push(bars[j].v);
      ranges.push(bars[j].h - bars[j].l);
    }
    const v = bars[i].v;
    const rng = bars[i].h - bars[i].l;
    raw[i] = (pctRankInWindow(vols, v) + pctRankInWindow(ranges, rng)) / 2;
  }
  for (let i = 0; i < n; i++) {
    let ok = 0;
    let s = 0;
    for (let k = 0; k < smaPeriod && i - k >= 0; k++) {
      const r = raw[i - k];
      if (!Number.isNaN(r)) {
        s += r;
        ok++;
      }
    }
    if (ok === smaPeriod) {
      const m = s / smaPeriod;
      out[i] = Math.min(100, Math.max(1, m));
    }
  }
  return out;
}

/** Per index: q-quantile (e.g. 0.95) of finite values in osc[j..i], j = max(0, i - window + 1). */
export function rollingOscQuantile(osc, window = 1000, q = 0.95) {
  const n = osc.length;
  const out = new Array(n).fill(NaN);
  const MIN_SAMPLES = 30;
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - window + 1);
    const slice = [];
    for (let j = i0; j <= i; j++) {
      const v = osc[j];
      if (typeof v === 'number' && !Number.isNaN(v)) slice.push(v);
    }
    if (slice.length < MIN_SAMPLES) continue;
    slice.sort((a, b) => a - b);
    const idx = Math.min(slice.length - 1, Math.max(0, Math.floor(q * (slice.length - 1))));
    out[i] = slice[idx];
  }
  return out;
}
