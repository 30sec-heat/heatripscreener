export function fP(p) {
  if (p == null) return '--';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

export function fN(n) {
  if (n == null || Number.isNaN(n)) return '--';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

/** Compact magnitude with explicit + for gains (OI Δ, PnL, etc.). */
export function fSignedN(n) {
  if (n == null || Number.isNaN(n)) return '--';
  if (n > 0) return '+' + fN(n);
  return fN(n);
}
