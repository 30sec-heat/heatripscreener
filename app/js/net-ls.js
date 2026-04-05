/** Net long/short cumulative series from USD OI and price (1m Velo); oiDelta uses intrabar body or vs prior close. */
const PRICE_FLAT_EPS = 1e-12;
const OI_INTRABAR_EPS = 1e-6;
const OI_DELTA_ZERO = 1e-9;

function effectiveOiDelta(row, prevClose) {
  const intra = row.oiC - row.oiO;
  if (Math.abs(intra) > OI_INTRABAR_EPS) return intra;
  if (prevClose == null || !Number.isFinite(prevClose)) return 0;
  return row.oiC - prevClose;
}

export function cumNetLS(oiArr, bars, mode) {
  const out = [];
  let cum = 0;
  let prevOiC = null;
  for (let i = 0; i < bars.length; i++) {
    const oi = oiArr[i];
    if (!oi || oi.oiO == null || oi.oiC == null) {
      out.push(cum);
      continue;
    }
    const oiDelta = effectiveOiDelta(oi, prevOiC);
    prevOiC = oi.oiC;
    const pChg = bars[i].o - bars[i].c;
    if (Math.abs(pChg) < PRICE_FLAT_EPS || Math.abs(oiDelta) < OI_DELTA_ZERO) {
      out.push(cum);
      continue;
    }
    const prod = pChg * oiDelta;
    if (mode === 'longs' && prod < 0) cum += oiDelta;
    else if (mode === 'shorts' && prod > 0) cum += oiDelta;
    out.push(cum);
  }
  return out;
}

/** Sum per-venue bar increments on the same price bar, then cumulative (venue aggregation must not precede the quadrant test). */
export function cumNetLSMulti(perEx, activeEx, bars, mode) {
  const out = [];
  let cum = 0;
  for (let i = 0; i < bars.length; i++) {
    let step = 0;
    const pChg = bars[i].o - bars[i].c;
    if (Math.abs(pChg) < PRICE_FLAT_EPS) {
      out.push(cum);
      continue;
    }
    for (const ex of activeEx) {
      const row = perEx[ex]?.[i];
      if (!row || row.oiO == null || row.oiC == null) continue;
      const prev = i > 0 ? perEx[ex]?.[i - 1] : null;
      const prevC = prev && prev.oiC != null ? prev.oiC : null;
      const oiDelta = effectiveOiDelta(row, prevC);
      if (Math.abs(oiDelta) < OI_DELTA_ZERO) continue;
      const prod = pChg * oiDelta;
      if (mode === 'longs' && prod < 0) step += oiDelta;
      else if (mode === 'shorts' && prod > 0) step += oiDelta;
    }
    cum += step;
    out.push(cum);
  }
  return out;
}
