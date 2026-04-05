/** Build higher-TF OHLCV from 1m bars (open time t in ms). */
export function aggregateOHLCVFrom1m(bars1m, tfSec) {
  if (!bars1m.length || tfSec <= 60) return bars1m.slice();
  const tfMs = tfSec * 1000;
  const out = [];
  let cur = null;
  let bucket = null;
  for (const b of bars1m) {
    const bkt = Math.floor(b.t / tfMs) * tfMs;
    if (bucket !== bkt) {
      if (cur) out.push(cur);
      bucket = bkt;
      cur = {
        t: bkt,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v || 0,
      };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v = (cur.v || 0) + (b.v || 0);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Map cumulative 1m series to display bars: value after last 1m in each TF bucket. */
export function downsampleCumToTf(cum1m, bars1m, barsDisp, tfSec) {
  if (!barsDisp.length) return [];
  const tfMs = tfSec * 1000;
  if (tfSec <= 60) {
    const t0 = barsDisp[0].t;
    let i0 = 0;
    while (i0 < bars1m.length && bars1m[i0].t < t0) i0++;
    return barsDisp.map((_, j) => cum1m[Math.min(i0 + j, cum1m.length - 1)] ?? 0);
  }
  return barsDisp.map((bd) => {
    const tEnd = bd.t + tfMs - 1;
    let j = -1;
    for (let k = 0; k < bars1m.length; k++) {
      if (bars1m[k].t <= tEnd) j = k;
      else break;
    }
    return j >= 0 ? cum1m[j] : 0;
  });
}

/** Aggregate per-exchange OI rows (same length as bars1m) to TF buckets for each display bar. */
export function aggregatePerExOiToTf(perEx1m, bars1m, barsDisp, activeEx, tfSec) {
  const tfMs = tfSec * 1000;
  const perEx = {};
  if (tfSec <= 60) {
    const t0 = barsDisp[0]?.t ?? 0;
    let i0 = 0;
    while (i0 < bars1m.length && bars1m[i0].t < t0) i0++;
    for (const ex of activeEx) {
      const src = perEx1m[ex] || [];
      perEx[ex] = barsDisp.map((_, j) => {
        const row = src[i0 + j];
        return row
          ? { oiO: row.oiO, oiH: row.oiH, oiL: row.oiL, oiC: row.oiC, oi: row.oi }
          : { oiO: 0, oiH: 0, oiL: 0, oiC: 0, oi: 0 };
      });
    }
    return perEx;
  }
  for (const ex of activeEx) {
    const src = perEx1m[ex] || [];
    const rows = [];
    for (let i = 0; i < barsDisp.length; i++) {
      const td = barsDisp[i].t;
      const te = td + tfMs;
      let oiO = 0;
      let oiH = -Infinity;
      let oiL = Infinity;
      let oiC = 0;
      let any = false;
      for (let k = 0; k < bars1m.length; k++) {
        if (bars1m[k].t < td) continue;
        if (bars1m[k].t >= te) break;
        const r = src[k];
        if (!r) continue;
        if (!any) {
          oiO = r.oiO;
          any = true;
        }
        oiH = Math.max(oiH, r.oiH);
        oiL = Math.min(oiL, r.oiL);
        oiC = r.oiC;
      }
      if (!any) {
        oiO = oiH = oiL = oiC = 0;
      }
      if (!isFinite(oiH)) oiH = 0;
      if (!isFinite(oiL)) oiL = 0;
      rows.push({ oiO, oiH, oiL, oiC, oi: oiC });
    }
    perEx[ex] = rows;
  }
  return perEx;
}

export function aggregateAggOiToTf(agg1m, bars1m, barsDisp, tfSec) {
  const activeEx = ['_'];
  const wrap = { _: agg1m };
  const per = aggregatePerExOiToTf(wrap, bars1m, barsDisp, ['_'], tfSec);
  return per._ || [];
}
