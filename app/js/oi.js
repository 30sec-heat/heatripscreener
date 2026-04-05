function forwardFillOiBars(rows) {
  let lastOI = 0;
  let last = { oiO: 0, oiH: 0, oiL: 0, oiC: 0 };
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].oi > 0) {
      lastOI = rows[i].oi;
      last = { oiO: rows[i].oiO, oiH: rows[i].oiH, oiL: rows[i].oiL, oiC: rows[i].oiC };
    } else {
      rows[i].oi = lastOI;
      rows[i].oiO = last.oiO;
      rows[i].oiH = last.oiH;
      rows[i].oiL = last.oiL;
      rows[i].oiC = last.oiC;
    }
  }
}

/**
 * Map 1m OI OHLC onto 1m price bars. Server uses Velo `...#open_interest#aggregated#USD#Candles`
 * — values are already OI in USD; do **not** multiply by price (that couples ΔOI to price moves and
 * so pChg×oiDelta stays meaningful when OI USD is flat).
 * Per-venue rows are forward-filled, then summed to agg.
 */
export function computeOIForSlice(shown, oiRaw, exOn) {
  const activeEx = [...exOn];
  const perEx = {};
  const agg = shown.map(() => ({ oiO: 0, oiH: 0, oiL: 0, oiC: 0, oi: 0 }));

  for (const ex of activeEx) {
    const pts = oiRaw[ex] || [];
    if (!pts.length) {
      perEx[ex] = shown.map(() => ({ oiO: 0, oiH: 0, oiL: 0, oiC: 0, oi: 0 }));
      continue;
    }
    const exBars = [];
    let pi = 0;
    for (let i = 0; i < shown.length; i++) {
      const tsSec = shown[i].t / 1000;
      const bucket = Math.floor(tsSec / 60) * 60;
      while (pi < pts.length - 1 && pts[pi + 1].t <= bucket) pi++;
      const row = pts[pi];
      const o0 = row ? row.o : 0;
      const o1 = row ? row.c : 0;
      let oh = row && row.h != null ? row.h : Math.max(o0, o1);
      let ol = row && row.l != null ? row.l : Math.min(o0, o1);
      const oiO = o0;
      const oiH = oh;
      const oiL = ol;
      const oiC = o1;
      const oiVal = oiC;
      exBars.push({ oiO, oiH, oiL, oiC, oi: oiVal });
    }
    forwardFillOiBars(exBars);
    perEx[ex] = exBars;
  }

  for (let i = 0; i < shown.length; i++) {
    for (const ex of activeEx) {
      const r = perEx[ex][i];
      agg[i].oiO += r.oiO;
      agg[i].oiH += r.oiH;
      agg[i].oiL += r.oiL;
      agg[i].oiC += r.oiC;
      agg[i].oi += r.oi;
    }
  }
  forwardFillOiBars(agg);
  return { perEx, agg, activeEx };
}

/** Min/max absolute OI USD over all bars (for fixed Y scale while panning). */
export function oiAbsBoundsFromAgg(agg) {
  if (!agg?.length) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of agg) {
    hi = Math.max(hi, b.oiO, b.oiH, b.oiL, b.oiC);
    lo = Math.min(lo, b.oiO, b.oiH, b.oiL, b.oiC);
  }
  if (!isFinite(hi)) return null;
  const r = hi - lo || 1;
  hi += r * 0.06;
  lo -= r * 0.06;
  return { hi, lo };
}
