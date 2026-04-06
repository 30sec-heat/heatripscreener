export function mirrorlyPriceAtTime(shown, tMs) {
  if (!shown.length) return null;
  if (tMs < shown[0].t) return shown[0].c;
  for (let i = 0; i < shown.length - 1; i++) {
    if (shown[i].t <= tMs && tMs < shown[i + 1].t) return shown[i].c;
  }
  return shown[shown.length - 1].c;
}

/** Candle whose interval contains tMs (for anchoring markers below the wick low). */
export function mirrorlyBarForTime(tf, shown, tMs) {
  if (!shown.length || tMs < shown[0].t) return null;
  const last = shown[shown.length - 1];
  const barMs = tf * 1000;
  for (let i = 0; i < shown.length; i++) {
    const b = shown[i];
    const nextT = i + 1 < shown.length ? shown[i + 1].t : b.t + barMs;
    if (b.t <= tMs && tMs < nextT) return b;
  }
  if (tMs >= last.t) return last;
  return null;
}
