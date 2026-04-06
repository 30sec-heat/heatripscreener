/** Max bar widths to extrapolate time→x before first / after last candle (walls, headlines, mirrorly). */
export const TIME_X_EXTRAP_BARS = 2.5;

/** Map wall time to x in the visible slice (bar-open alignment + extrapolate past last close). */
export function mirrorlyXAt(tf, shown, tMs, toX, cw) {
  if (!shown.length || tMs == null || Number.isNaN(tMs)) return null;
  const last = shown[shown.length - 1];
  const barMs = tf * 1000;
  const first = shown[0];
  if (tMs < first.t) {
    const frac = Math.max(-TIME_X_EXTRAP_BARS, (tMs - first.t) / barMs);
    return toX(0) + frac * cw;
  }
  for (let i = 0; i < shown.length - 1; i++) {
    if (shown[i].t <= tMs && tMs < shown[i + 1].t) {
      const den = shown[i + 1].t - shown[i].t || 1;
      const frac = (tMs - shown[i].t) / den;
      return toX(i) + frac * (toX(i + 1) - toX(i));
    }
  }
  if (tMs >= last.t) {
    const frac = Math.min(TIME_X_EXTRAP_BARS, (tMs - last.t) / barMs);
    return toX(shown.length - 1) + frac * cw;
  }
  return toX(shown.length - 1);
}
