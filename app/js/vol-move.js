/**
 * Flags bars where a recent cumulative move is large vs a volatility estimate.
 * Best-practice lite: log returns ~ stationary; cumulative move over W bars has
 * rough scale σ√W if σ is per-bar stdev of log returns (i.i.d. approx).
 *
 * σ is computed only from bars *before* the W-bar window (no leakage).
 * Significant if |ln(C_t / C_{t-W})| > z * σ * sqrt(W).
 */
export const MOVE_VOL_LOOKBACK = 120;
export const MOVE_WINDOW_BARS = 45;
export const MOVE_Z = 2;

export function computeSignificantMoves(
  bars,
  volLb = MOVE_VOL_LOOKBACK,
  moveWin = MOVE_WINDOW_BARS,
  z = MOVE_Z
) {
  const n = bars.length;
  const out = new Array(n).fill(false);
  const logRet = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = bars[i - 1].c;
    const b = bars[i].c;
    logRet[i] = a > 0 && b > 0 ? Math.log(b / a) : 0;
  }
  for (let i = volLb + moveWin + 1; i < n; i++) {
    const volEnd = i - moveWin - 1;
    const volStart = volEnd - volLb + 1;
    if (volStart < 1) continue;
    let sum = 0;
    let sumsq = 0;
    const cnt = volLb;
    for (let j = volStart; j <= volEnd; j++) {
      const r = logRet[j];
      sum += r;
      sumsq += r * r;
    }
    const mean = sum / cnt;
    const sig = Math.sqrt(Math.max(sumsq / cnt - mean * mean, 1e-20));

    const c0 = bars[i - moveWin].c;
    const c1 = bars[i].c;
    if (c0 <= 0 || c1 <= 0) continue;
    const cumLog = Math.log(c1 / c0);
    const threshold = z * sig * Math.sqrt(moveWin);
    if (Math.abs(cumLog) > threshold) out[i] = true;
  }
  return out;
}
