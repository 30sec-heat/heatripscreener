import { GLOW, EMBER, MAX_BARS, EX_COLORS, EX_SHORT, SNIPER_MIN } from './constants.js';
import { chartTheme, setChartTheme } from './chart-theme.js';
import { fP, fN, fSignedN } from './format.js';
import { computeOIForSlice, oiAbsBoundsFromAgg } from './oi.js';
import { cumNetLS, cumNetLSMulti } from './net-ls.js';
import {
  computeSniper,
  computeReversionScreener,
  computeOscCrossP95Arrows,
  computeVolRangeSniper,
} from './sniper.js';
import { drawLine, drawOiCandlesPanel, linePanelScale, staggerEndLabelYs } from './draw.js';
import { computeOscillator, rollingOscQuantile } from './oscillator.js';
import { computeRSI } from './rsi.js';
import { aggregateOHLCVFrom1m, downsampleCumToTf, aggregatePerExOiToTf } from './timeframe.js';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
let W, H;

let rafDraw = 0;
function scheduleRedraw() {
  if (rafDraw) return;
  rafDraw = requestAnimationFrame(() => {
    rafDraw = 0;
    draw();
  });
}

/** WS tick updates can flood 50+/s; cap redraws for live price / forming candle. */
let liveRedrawTimer = null;
let liveRedrawT = 0;
function scheduleLiveRedraw() {
  const now = performance.now();
  const gap = 55;
  if (now - liveRedrawT >= gap) {
    liveRedrawT = now;
    scheduleRedraw();
    return;
  }
  if (liveRedrawTimer) return;
  liveRedrawTimer = setTimeout(() => {
    liveRedrawTimer = null;
    liveRedrawT = performance.now();
    scheduleRedraw();
  }, gap - (now - liveRedrawT));
}

function resize() {
  const r = devicePixelRatio || 1;
  const rc = cv.parentElement.getBoundingClientRect();
  W = rc.width;
  H = rc.height;
  cv.width = W * r;
  cv.height = H * r;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  scheduleRedraw();
}
resize();
window.addEventListener('resize', resize);

const THEME_KEY = 'heatrip-theme';

function syncThemeToggleLabel() {
  const btn = $('theme-toggle');
  if (!btn) return;
  const light = document.documentElement.dataset.theme === 'light';
  btn.textContent = light ? 'Dark' : 'Light';
  btn.setAttribute('aria-pressed', light ? 'true' : 'false');
  btn.title = light ? 'Use dark theme' : 'Use light theme';
}

function initTheme() {
  const light = localStorage.getItem(THEME_KEY) === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  setChartTheme(light);
  syncThemeToggleLabel();
}

function toggleTheme() {
  const nextLight = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = nextLight ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, nextLight ? 'light' : 'dark');
  setChartTheme(nextLight);
  syncThemeToggleLabel();
  scheduleRedraw();
}

const V_GRID_DIVS = 8;

function drawVerticalGrid(ctx, pL, xRight, yTop, yBot) {
  for (let g = 1; g < V_GRID_DIVS; g++) {
    const gx = pL + (g / V_GRID_DIVS) * (xRight - pL);
    const strong = g % 2 === 0;
    ctx.strokeStyle = strong ? chartTheme.grid : chartTheme.gridMinor;
    ctx.lineWidth = strong ? 0.7 : 0.45;
    ctx.beginPath();
    ctx.moveTo(gx, yTop);
    ctx.lineTo(gx, yBot);
    ctx.stroke();
  }
}

function drawHorizontalGridBands(ctx, pL, xRight, yTop, height, nMajor) {
  if (height <= 0) return;
  const n = Math.max(2, Math.min(4, nMajor | 0));
  for (let i = 0; i <= n; i++) {
    const y = yTop + (i / n) * height;
    ctx.strokeStyle = chartTheme.grid;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const y = yTop + ((i + 0.5) / n) * height;
    ctx.strokeStyle = chartTheme.gridMinor;
    ctx.lineWidth = 0.45;
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
}
window.addEventListener(
  'scroll',
  () => {
    window.scrollTo(0, 0);
  },
  true
);

/** OI + net L/S: 1m price + 1m OI from /api/chart. */
const ind = {
  netlongs: true,
  netshorts: true,
  oi: false,
  osc: true,
  sniper: true,
  rev: false,
  vrng: false,
  volume: false,
  split: false,
};
const PANEL_GAP = 4;
/** Min height for all indicator rows combined (drag OHLC vs stack divider). */
const MIN_IND_BLOCK_PER_ROW = 14;
const OHLC_FRAC_MIN = 0.38;
const OHLC_FRAC_MAX = 0.88;
let ohlcFrac = 0.64;
let panelFracs = [];
let lastLayout = null;
let resizeDrag = null;
const oscCache = { k: '', arr: [], p95: [], rsi: [], oscCrossSig: [] };
const exOn = new Set(['binance-futures', 'bybit', 'okex-swap', 'deribit', 'hyperliquid']);

let cacheKey = '';
let cachedOI = null;
let oiFullCacheKey = '';
let oiFullCached = null;

/** 1m (+ forming) price series → OI rows aligned to ext1m; cache invalidates on closed bars / venues / forming OHLC. */
function getOIFull1m(ext1m) {
  const nClosed = bars1m.length;
  const lc = bars1m[nClosed - 1];
  const f = curBar && ext1m.length > nClosed ? curBar : null;
  const k = `${nClosed}:${lc?.t ?? 0}:${f ? `${f.o},${f.h},${f.l},${f.c}` : '-'}:${[...exOn].join(',')}:${ind.split}`;
  if (k === oiFullCacheKey && oiFullCached) return oiFullCached;
  oiFullCacheKey = k;
  oiFullCached = computeOIForSlice(ext1m, oiRaw, exOn);
  return oiFullCached;
}

function sumPerExToAgg(perExDisp, activeEx, len) {
  const agg = [];
  for (let i = 0; i < len; i++) {
    let oiO = 0,
      oiC = 0,
      oiH = 0,
      oiL = 0;
    for (const ex of activeEx) {
      const r = perExDisp[ex]?.[i];
      if (!r) continue;
      oiO += r.oiO;
      oiC += r.oiC;
      oiH += r.oiH;
      oiL += r.oiL;
    }
    agg.push({ oiO, oiH, oiL, oiC, oi: oiC });
  }
  return agg;
}

function getOIDisplayTf(shownSlice, ext1m) {
  const full = getOIFull1m(ext1m);
  const perExDisp = aggregatePerExOiToTf(full.perEx, ext1m, shownSlice, full.activeEx, tf);
  const agg = sumPerExToAgg(perExDisp, full.activeEx, shownSlice.length);
  return { perEx: perExDisp, agg, activeEx: full.activeEx };
}
let sniperCache = { k: '', sig: [], extSt: 0 };
let revCache = { k: '', sig: [] };
let vrngCache = { k: '', sig: [], extSt: 0 };
let loadMoreTimer = null;
let panScrollSnap = 0;
let sbScrollSnap = 0;

function invalidateOISlice() {
  cacheKey = '';
  oiFullCacheKey = '';
  oiFullCached = null;
  sniperCache.k = '';
  revCache.k = '';
  vrngCache.k = '';
}

function invalidateOscDerived() {
  oscCache.k = '';
}

function invalidateOICaches() {
  invalidateOISlice();
  invalidateOscDerived();
}

document.querySelectorAll('input[data-ind]').forEach((inp) => {
  const k = inp.dataset.ind;
  if (ind[k] !== undefined) inp.checked = !!ind[k];
  inp.addEventListener('change', () => {
    const kk = inp.dataset.ind;
    ind[kk] = inp.checked;
    if (kk === 'split' && ind.split) {
      exOn.delete('deribit');
      document.querySelector('[data-ex="deribit"]')?.classList.remove('on');
    }
    invalidateOISlice();
    scheduleRedraw();
  });
});
document.querySelectorAll('[data-ex]').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.dataset.ex;
    if (exOn.has(k)) exOn.delete(k);
    else exOn.add(k);
    b.classList.toggle('on', exOn.has(k));
    invalidateOISlice();
    scheduleRedraw();
  });
});

let sym = 'BTCUSDT';
let tf = 60;
let vis = 1000;
let scrollOff = 0;
let autoScr = true;
let targetVis = 1000;
let loadedHours = 17;
let bars1m = [];
let oiRaw = {};
let curBar = null;
let lastP = null;
let isDrag = false;
let dragX0 = 0;
let dragOff0 = 0;
/** Live-edge overscroll + Alt/⌘ fine nudge: horizontal px shift for candle strip (±PLOT_SHIFT_MAX). */
let plotShiftX = 0;
const PLOT_SHIFT_MAX = 320;
let plotShiftDrag = false;
let plotShiftDragX0 = 0;
let plotShift0 = 0;
let plotShiftX0 = 0;
let annotDrawOn = false;
const annotStrokes = [];
let annotDrawing = null;
const ANNOT_MIN_DIST = 1.5;
let mouseX = -1;
let mouseY = -1;
let showXH = false;
let prevMouseCanvasX = NaN;
let prevMouseCanvasY = NaN;
let prevShowXH = false;
let panelDividerY = 0;

function ext1mSeries() {
  return curBar ? bars1m.concat([curBar]) : bars1m;
}

function displayAllFromExt(ext) {
  if (!ext.length) return [];
  return tf <= 60 ? ext : aggregateOHLCVFrom1m(ext, tf);
}

function displayBarCount() {
  return displayAllFromExt(ext1mSeries()).length;
}

function setTf(sec) {
  const n = Number(sec);
  if (n !== 60 && n !== 300) return;
  if (tf === n) return;
  tf = n;
  document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', Number(b.dataset.tf) === tf));
  invalidateOICaches();
  clamp();
  updSB();
  scheduleRedraw();
}

const $ = (id) => document.getElementById(id);
const $st = $('st'),
  $pl = $('pl'),
  $tl = $('tl'),
  $si = $('si'),
  $sbt = $('sbt'),
  $sbw = $('sbw');
const $zv = $('zv');

function syncVisLabel() {
  if ($zv) $zv.textContent = String(vis);
}

let ws = null;
function connectWS() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    $st.textContent = 'live';
    $st.className = 'status-pill live';
    ws.send(JSON.stringify({ subscribe: [sym], timeframes: [60] }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'trade' && m.symbol === sym) {
      lastP = m.price;
      scheduleLiveRedraw();
      return;
    }
    if (m.type === 'bar_update' && m.symbol === sym && m.tf === 60) {
      curBar = {
        t: m.bar.ts,
        o: m.bar.open,
        h: m.bar.high,
        l: m.bar.low,
        c: m.bar.close,
        v: m.bar.volume,
      };
      invalidateOISlice();
      scheduleLiveRedraw();
      return;
    }
    if (m.type === 'bar' && m.symbol === sym && m.tf === 60) {
      if (liveRedrawTimer) {
        clearTimeout(liveRedrawTimer);
        liveRedrawTimer = null;
      }
      bars1m.push({
        t: m.bar.ts,
        o: m.bar.open,
        h: m.bar.high,
        l: m.bar.low,
        c: m.bar.close,
        v: m.bar.volume,
      });
      if (bars1m.length > MAX_BARS) bars1m.shift();
      curBar = null;
      invalidateOICaches();
      if (autoScr) updSB();
      scheduleRedraw();
    }
  };
  ws.onclose = () => {
    $st.textContent = '…';
    $st.className = 'status-pill';
    setTimeout(connectWS, 2000);
  };
  ws.onerror = () => ws.close();
}
function resub() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ subscribe: [sym], timeframes: [60] }));
}

function clamp() {
  const t = displayBarCount();
  if (t <= 0) {
    scrollOff = 0;
    autoScr = true;
    return;
  }
  scrollOff = Math.max(0, Math.min(Math.max(0, t - vis), scrollOff));
  autoScr = scrollOff === 0 && plotShiftX === 0;
}

function setVis(v) {
  const total = displayBarCount() || 1;
  targetVis = Math.max(10, v);
  vis = Math.max(10, Math.min(total, v));
  scrollOff = 0;
  plotShiftX = 0;
  autoScr = true;
  syncVisLabel();
  updSB();
  invalidateOISlice();
  scheduleRedraw();
  if (vis >= total * 0.9 && loadedHours < 48) {
    loadedHours = Math.min(48, loadedHours + 7);
    loadMore();
  }
}

function zoomVis(v) {
  const total = displayBarCount() || 1;
  const newVis = Math.max(10, Math.min(total, v));
  targetVis = Math.max(10, v);
  const delta = newVis - vis;
  vis = newVis;
  plotShiftX = 0;
  if (!autoScr) scrollOff = Math.max(0, scrollOff - delta);
  clamp();
  syncVisLabel();
  updSB();
  invalidateOISlice();
  scheduleRedraw();
  if (vis >= total * 0.9 && loadedHours < 48) {
    clearTimeout(loadMoreTimer);
    loadMoreTimer = setTimeout(() => {
      loadedHours = Math.min(48, loadedHours + 7);
      loadMore();
    }, 300);
  }
}

cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      const step = Math.max(1, Math.round(vis * 0.05));
      const prevOff = scrollOff;
      scrollOff = scrollOff + Math.sign(e.deltaY) * step;
      autoScr = false;
      clamp();
      updSB();
      if (scrollOff !== prevOff) invalidateOISlice();
      scheduleRedraw();
    } else {
      zoomVis(vis + Math.sign(e.deltaY) * Math.max(2, Math.round(vis * 0.08)));
    }
  },
  { passive: false }
);
document.addEventListener(
  'wheel',
  (e) => {
    if (e.target.closest('#tl')) return;
    e.preventDefault();
  },
  { passive: false }
);

cv.addEventListener('mousedown', (e) => {
  if (e.button) return;
  const r = cv.getBoundingClientRect();
  const my = e.clientY - r.top;
  const mx = e.clientX - r.left;

  if (annotDrawOn && !(e.altKey || e.metaKey) && mx >= 0 && mx <= r.width && my >= 0 && my <= r.height) {
    annotDrawing = { points: [{ x: mx, y: my }] };
    e.preventDefault();
    return;
  }

  const totalH = H - pT - pB;
  const gap = 4;
  const n = lastLayout?.subsLen ?? 0;
  const minInd = n
    ? n * MIN_IND_BLOCK_PER_ROW + (n > 1 ? (n - 1) * PANEL_GAP : 0)
    : 0;

  if (lastLayout && n > 0) {
    if (Math.abs(my - lastLayout.ohlcBottom) < 6) {
      resizeDrag = { type: 'ohlc', sy: e.clientY, sFrac: ohlcFrac, totalH, minInd, n };
      e.preventDefault();
      return;
    }
    for (let i = 0; i < lastLayout.panelDividers.length; i++) {
      if (Math.abs(my - lastLayout.panelDividers[i]) < 5) {
        resizeDrag = {
          type: 'panel',
          sy: e.clientY,
          idx: i,
          f0: [...panelFracs],
          indBody: lastLayout.indBody,
        };
        e.preventDefault();
        return;
      }
    }
  }

  const ohlcBottom = lastLayout?.ohlcBottom ?? H;
  if (my < ohlcBottom - 4 && mx >= 0 && mx <= r.width) {
    if (e.altKey || e.metaKey) {
      plotShiftDrag = true;
      plotShiftDragX0 = e.clientX;
      plotShift0 = plotShiftX;
      cv.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    isDrag = true;
    dragX0 = e.clientX;
    dragOff0 = scrollOff;
    plotShiftX0 = plotShiftX;
    panScrollSnap = scrollOff;
    cv.style.cursor = 'grabbing';
  }
});
window.addEventListener('mousemove', (e) => {
  if (resizeDrag) {
    if (resizeDrag.type === 'ohlc') {
      const dy = e.clientY - resizeDrag.sy;
      let nf = resizeDrag.sFrac + dy / resizeDrag.totalH;
      nf = Math.max(OHLC_FRAC_MIN, Math.min(OHLC_FRAC_MAX, nf));
      let oH = resizeDrag.totalH * nf;
      let iB = resizeDrag.totalH - oH - PANEL_GAP;
      if (iB < resizeDrag.minInd) {
        iB = resizeDrag.minInd;
        oH = resizeDrag.totalH - PANEL_GAP - iB;
        nf = oH / resizeDrag.totalH;
      }
      ohlcFrac = nf;
    } else if (resizeDrag.type === 'panel' && resizeDrag.indBody > 0) {
      const dy = e.clientY - resizeDrag.sy;
      const d = dy / resizeDrag.indBody;
      const i = resizeDrag.idx;
      const f = [...resizeDrag.f0];
      const pair = f[i] + f[i + 1];
      const minf = 0.05;
      f[i] = Math.max(minf, Math.min(pair - minf, f[i] + d));
      f[i + 1] = pair - f[i];
      panelFracs = f;
    }
  } else if (plotShiftDrag) {
    plotShiftX = Math.max(
      -PLOT_SHIFT_MAX,
      Math.min(PLOT_SHIFT_MAX, plotShift0 + (e.clientX - plotShiftDragX0))
    );
    scheduleRedraw();
  } else if (isDrag) {
    const ppb = (W - pL - pR - CHART_PAD_R) / vis;
    const dx = e.clientX - dragX0;
    const virt = dragOff0 + dx / ppb;
    const t = displayBarCount();
    const maxS = Math.max(0, t - vis);
    if (virt < 0 && dragOff0 === 0) {
      scrollOff = 0;
      plotShiftX = Math.max(-PLOT_SHIFT_MAX, Math.min(PLOT_SHIFT_MAX, plotShiftX0 + dx));
    } else {
      scrollOff = Math.min(maxS, Math.max(0, Math.round(virt)));
      plotShiftX = 0;
    }
    clamp();
    updSB();
    if (scrollOff !== panScrollSnap) {
      panScrollSnap = scrollOff;
      invalidateOISlice();
    }
  }
  const r = cv.getBoundingClientRect();
  mouseX = e.clientX - r.left;
  mouseY = e.clientY - r.top;
  if (annotDrawing) {
    const pts = annotDrawing.points;
    const last = pts[pts.length - 1];
    if (Math.hypot(mouseX - last.x, mouseY - last.y) >= ANNOT_MIN_DIST) pts.push({ x: mouseX, y: mouseY });
  }
  showXH = mouseX >= 0 && mouseX <= r.width && mouseY >= 0 && mouseY <= r.height;
  if (!isDrag && !resizeDrag && !plotShiftDrag) {
    const my = e.clientY - r.top;
    if (lastLayout?.subsLen) {
      if (Math.abs(my - lastLayout.ohlcBottom) < 6) cv.style.cursor = 'ns-resize';
      else if (lastLayout.panelDividers.some((y) => Math.abs(my - y) < 5)) cv.style.cursor = 'ns-resize';
      else if (annotDrawOn) cv.style.cursor = 'crosshair';
      else if (my < lastLayout.ohlcBottom - 4)
        cv.style.cursor = e.altKey || e.metaKey ? 'grab' : 'crosshair';
      else cv.style.cursor = annotDrawOn ? 'crosshair' : 'default';
    } else cv.style.cursor = annotDrawOn ? 'crosshair' : e.altKey || e.metaKey ? 'grab' : 'crosshair';
  }
  const xhChanged = prevShowXH !== showXH;
  prevShowXH = showXH;
  const rx = Math.round(mouseX);
  const ry = Math.round(mouseY);
  const moved = rx !== prevMouseCanvasX || ry !== prevMouseCanvasY;
  if (moved) {
    prevMouseCanvasX = rx;
    prevMouseCanvasY = ry;
  }
  if (resizeDrag || isDrag || plotShiftDrag || annotDrawing) scheduleRedraw();
  else if (xhChanged) scheduleRedraw();
  else if (showXH && moved) scheduleRedraw();
});
window.addEventListener('mouseup', () => {
  if (annotDrawing) {
    const pts = annotDrawing.points;
    if (pts.length >= 2) annotStrokes.push({ points: pts.slice() });
    else if (pts.length === 1) {
      const p = pts[0];
      annotStrokes.push({ points: [p, { x: p.x + 1, y: p.y }] });
    }
    annotDrawing = null;
    scheduleRedraw();
  }
  if (resizeDrag || isDrag || plotShiftDrag) scheduleRedraw();
  if (resizeDrag) resizeDrag = null;
  if (plotShiftDrag) {
    plotShiftDrag = false;
    cv.style.cursor = 'crosshair';
  }
  if (isDrag) {
    isDrag = false;
    cv.style.cursor = 'crosshair';
  }
});
cv.addEventListener('dblclick', () => {
  scrollOff = 0;
  autoScr = true;
  vis = 1000;
  targetVis = 1000;
  plotShiftX = 0;
  syncVisLabel();
  updSB();
  invalidateOISlice();
  scheduleRedraw();
});
cv.addEventListener('mouseleave', () => {
  showXH = false;
  prevShowXH = false;
  if (annotDrawing) {
    annotDrawing = null;
    scheduleRedraw();
  } else scheduleRedraw();
});
cv.style.cursor = 'crosshair';

let sbD = false,
  sbX0 = 0,
  sbO0 = 0;
$sbt.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  sbD = true;
  sbX0 = e.clientX;
  sbO0 = scrollOff;
  sbScrollSnap = scrollOff;
});
window.addEventListener('mousemove', (e) => {
  if (!sbD) return;
  const t = displayBarCount();
  if (t <= vis) return;
  scrollOff = sbO0 - Math.round((e.clientX - sbX0) / ($sbw.clientWidth / (t - vis)));
  clamp();
  updSB();
  if (scrollOff !== sbScrollSnap) {
    sbScrollSnap = scrollOff;
    invalidateOISlice();
  }
  scheduleRedraw();
});
window.addEventListener('mouseup', () => {
  sbD = false;
});

function updSB() {
  const t = displayBarCount();
  if (t <= vis) {
    $sbt.style.display = 'none';
    return;
  }
  $sbt.style.display = 'block';
  const ww = $sbw.clientWidth;
  const tw = Math.max(20, (vis / t) * ww);
  const ml = ww - tw;
  const mo = t - vis;
  $sbt.style.width = tw + 'px';
  $sbt.style.left = (mo > 0 ? (1 - scrollOff / mo) * ml : 0) + 'px';
}

function getOI(shown) {
  const key =
    shown.length +
    ':' +
    shown[0]?.t +
    ':' +
    scrollOff +
    ':' +
    [...exOn].join(',') +
    ':' +
    ind.split;
  if (key === cacheKey && cachedOI) return cachedOI;
  cacheKey = key;
  cachedOI = computeOIForSlice(shown, oiRaw, exOn);
  return cachedOI;
}

/** Right: price labels + gap so last candle / wick is not flush to the axis */
const pR = 64;
const CHART_PAD_R = 14;
const pL = 4;
const pT = 6;
const pB = 18;

function ensureOscDerived(all) {
  const k = all.length + ':' + tf + ':' + (all[all.length - 1]?.t ?? 0);
  if (k === oscCache.k) return;
  oscCache.k = k;
  oscCache.arr = computeOscillator(all, 100, 14);
  oscCache.p95 = rollingOscQuantile(oscCache.arr, 1000, 0.95);
  oscCache.rsi = computeRSI(all, 14);
  oscCache.oscCrossSig = computeOscCrossP95Arrows(
    oscCache.arr,
    oscCache.p95,
    oscCache.rsi
  );
}

function drawOscPanel(ctx, vals, p95Vals, dT, pH, pL, xRight, toX, lineFill = null) {
  const lineC = lineFill?.line ?? chartTheme.oscLine;
  const fillC = lineFill?.fill ?? chartTheme.oscFill;
  const lo = 1;
  const hi = 100;
  const toYv = (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return dT + pH * 0.5;
    const t = (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo);
    return dT + pH - t * pH;
  };
  ctx.strokeStyle = chartTheme.oscMid;
  ctx.lineWidth = 0.5;
  for (const pv of [25, 50, 75]) {
    const y = toYv(pv);
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  const pts = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (typeof v === 'number' && !Number.isNaN(v)) pts.push({ i, y: toYv(v) });
  }
  if (pts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(toX(pts[0].i), pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(toX(pts[k].i), pts[k].y);
    ctx.strokeStyle = lineC;
    ctx.lineWidth = 1.15;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX(pts[0].i), dT + pH);
    for (let k = 0; k < pts.length; k++) ctx.lineTo(toX(pts[k].i), pts[k].y);
    ctx.lineTo(toX(pts[pts.length - 1].i), dT + pH);
    ctx.closePath();
    ctx.fillStyle = fillC;
    ctx.fill();
  }

  if (p95Vals && p95Vals.length === vals.length) {
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vals.length; i++) {
      const pv = p95Vals[i];
      if (typeof pv !== 'number' || Number.isNaN(pv)) {
        started = false;
        continue;
      }
      const x = toX(i);
      const y = toYv(pv);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (started) {
      ctx.strokeStyle = chartTheme.oscP95;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawPctArrows(ctx, shown, st, toX, toY) {
  const crossSig = oscCache.oscCrossSig;
  if (!crossSig.length) return;
  const h = 6;
  const w = 5;
  const off = 11;
  const sw = chartTheme.rsiArrowStrokeW;
  for (let i = 0; i < shown.length; i++) {
    const gi = st + i;
    const d = crossSig[gi];
    if (!d) continue;
    const x = toX(i);
    const c = shown[i];
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (d === 'long') {
      const y = toY(c.l) + off;
      ctx.beginPath();
      ctx.moveTo(x, y - h);
      ctx.lineTo(x - w, y);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fillStyle = chartTheme.rsiArrowBelowFill;
      ctx.fill();
      ctx.strokeStyle = chartTheme.rsiArrowBelowStroke;
      ctx.lineWidth = sw;
      ctx.stroke();
    } else {
      const y = toY(c.h) - off;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x - w, y);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fillStyle = chartTheme.rsiArrowAboveFill;
      ctx.fill();
      ctx.strokeStyle = chartTheme.rsiArrowAboveStroke;
      ctx.lineWidth = sw;
      ctx.stroke();
    }
  }
}

function draw() {
  ctx.fillStyle = chartTheme.bg;
  ctx.fillRect(0, 0, W, H);
  const ext1m = ext1mSeries();
  const all = displayAllFromExt(ext1m);
  if (!all.length) {
    ctx.fillStyle = chartTheme.loading;
    ctx.font = "500 12px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('Loading…', W / 2, H / 2);
    return;
  }

  const totalH = H - pT - pB;
  const subs = [];
  if (ind.netlongs) subs.push('netlongs');
  if (ind.netshorts) subs.push('netshorts');
  if (ind.oi) subs.push('oi');
  if (ind.osc) subs.push('osc');
  const gap = PANEL_GAP;
  const nSub = subs.length;
  let ohlcH = nSub ? totalH * ohlcFrac : totalH;
  let indBlock = nSub ? totalH - ohlcH - gap : 0;
  const minInd = nSub
    ? nSub * MIN_IND_BLOCK_PER_ROW + (nSub > 1 ? (nSub - 1) * gap : 0)
    : 0;
  if (nSub && indBlock < minInd) {
    indBlock = minInd;
    ohlcH = totalH - gap - indBlock;
    ohlcFrac = ohlcH / totalH;
  }
  const indBody = nSub ? indBlock - (nSub > 1 ? (nSub - 1) * gap : 0) : 0;
  if (panelFracs.length !== nSub) {
    panelFracs = Array.from({ length: nSub }, () => (nSub ? 1 / nSub : 1));
  }
  const sumF = panelFracs.reduce((a, b) => a + b, 0) || 1;
  const normF = panelFracs.map((f) => f / sumF);
  let eachHeights = normF.map((f) => f * indBody);
  const totRows = eachHeights.reduce((a, b) => a + b, 0);
  if (totRows > 0 && indBody > 0) eachHeights = eachHeights.map((h) => (h / totRows) * indBody);
  panelDividerY = pT + ohlcH;

  const v = Math.min(all.length, vis);
  let end = all.length - scrollOff;
  if (end < 1) end = all.length;
  const st = Math.max(0, end - v);
  const shown = all.slice(st, end);
  if (!shown.length) {
    return;
  }

  let oiPanelHud = null;

  if (ind.osc || ind.rev || ind.vrng) ensureOscDerived(all);

  const oiFull1m = getOIFull1m(ext1m);
  const oiData = tf <= 60 ? getOI(shown) : getOIDisplayTf(shown, ext1m);
  const xRight = W - pR - CHART_PAD_R;

  let hi = -Infinity;
  let lo = Infinity;
  for (const c of shown) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  const rn = hi - lo || hi * 0.001 || 1;
  const mg = rn * 0.05;
  hi += mg;
  lo -= mg;
  const pRn = hi - lo;
  const volGutter =
    ind.volume && ohlcH > 36
      ? Math.min(ohlcH - 28, Math.max(12, ohlcH * 0.26))
      : 0;
  const priceOhlcH = ohlcH - volGutter;
  const cW = xRight - pL;
  const cw = cW / v;
  const bW = Math.max(1, Math.min(cw * 0.72, 14));
  const wkW = Math.max(1.15, Math.min(bW * 0.18, 2.15));
  const toX = (i) => pL + i * cw + cw / 2 + plotShiftX;
  const toY = (p) => pT + (1 - (p - lo) / pRn) * priceOhlcH;

  drawHorizontalGridBands(ctx, pL, xRight, pT, priceOhlcH, 4);
  for (let i = 0; i <= 4; i++) {
    const y = pT + (i / 4) * priceOhlcH;
    ctx.fillStyle = chartTheme.gridText;
    ctx.font = "9px 'IBM Plex Mono',monospace";
    ctx.textAlign = 'left';
    ctx.fillText(fP(hi - (i / 4) * pRn), xRight + 3, y + 3);
  }
  drawVerticalGrid(ctx, pL, xRight, pT, pT + ohlcH);

  ctx.fillStyle = chartTheme.gridText;
  ctx.font = "9px 'IBM Plex Mono',monospace";
  ctx.textAlign = 'center';
  let lastLabel = -1;
  for (let i = 0; i < shown.length; i++) {
    const d = new Date(shown[i].t);
    const h = d.getHours();
    const m = d.getMinutes();
    const interval = tf >= 300 ? 360 : tf >= 60 ? 120 : 30;
    const totalMin = h * 60 + m;
    const slot = Math.floor(totalMin / interval);
    if (slot === lastLabel) continue;
    if (tf >= 300) {
      if (m % 30 !== 0) continue;
    } else if (tf >= 60) {
      if (m >= 5) continue;
    } else if (m >= 1) continue;
    lastLabel = slot;
    const lbl = h === 0 && m < 5 ? `${d.getMonth() + 1}/${d.getDate()}` : `${h}`.padStart(2, '0') + ':00';
    ctx.fillText(lbl, toX(i), H - pB + 10);
  }

  if (volGutter > 0) {
    const volTop = pT + priceOhlcH;
    ctx.strokeStyle = chartTheme.panelRule;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pL, volTop + 0.5);
    ctx.lineTo(xRight, volTop + 0.5);
    ctx.stroke();
    let mx = 0;
    for (const c of shown) mx = Math.max(mx, c.v || 0);
    if (mx > 0) {
      const volDepth = volGutter - 3;
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i];
        const x = toX(i);
        const vv = c.v || 0;
        const volH = (vv / mx) * volDepth;
        ctx.fillStyle = c.c >= c.o ? chartTheme.volBarBull : chartTheme.volBarBear;
        ctx.fillRect(x - bW / 2, pT + ohlcH - volH, bW, volH);
      }
    }
  }

  ctx.lineCap = 'round';
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    const x = toX(i);
    ctx.strokeStyle = c.c >= c.o ? chartTheme.wickBull : chartTheme.wickBear;
    ctx.lineWidth = wkW;
    ctx.beginPath();
    ctx.moveTo(x, toY(c.h));
    ctx.lineTo(x, toY(c.l));
    ctx.stroke();
  }

  ctx.fillStyle = chartTheme.bear;
  ctx.beginPath();
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    if (c.c >= c.o) continue;
    const x = toX(i);
    const top = toY(c.o);
    const bot = toY(c.c);
    ctx.rect(x - bW / 2, top, bW, Math.max(bot - top, 1));
  }
  ctx.fill();
  ctx.strokeStyle = chartTheme.bearBorder;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    if (c.c >= c.o) continue;
    const x = toX(i);
    const top = toY(c.o);
    const bot = toY(c.c);
    ctx.strokeRect(x - bW / 2 + 0.5, top + 0.5, bW - 1, Math.max(bot - top - 1, 1));
  }

  ctx.fillStyle = chartTheme.bull;
  ctx.beginPath();
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    if (c.c < c.o) continue;
    const x = toX(i);
    const top = toY(c.c);
    const bot = toY(c.o);
    ctx.rect(x - bW / 2, top, bW, Math.max(bot - top, 1));
  }
  ctx.fill();

  ctx.strokeStyle = chartTheme.bodyLine;
  ctx.lineWidth = 1.05;
  ctx.beginPath();
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    if (c.c < c.o) continue;
    const x = toX(i);
    const top = toY(c.c);
    const bot = toY(c.o);
    ctx.rect(x - bW / 2 + 0.5, top + 0.5, bW - 1, Math.max(bot - top - 1, 0.5));
  }
  ctx.stroke();

  if (ind.osc) drawPctArrows(ctx, shown, st, toX, toY);

  if (ind.sniper)
    try {
      const extNeed = Math.min(all.length, Math.max(SNIPER_MIN, v));
      const extSt = Math.max(0, end - extNeed);
      const sniperBars = all.slice(extSt, end);
      if (sniperBars.length >= SNIPER_MIN) {
        const sk = 'sn:' + tf + ':' + extSt + ':' + end + ':' + scrollOff + ':' + (sniperBars[0]?.t || 0);
        if (sk !== sniperCache.k) {
          const oiS =
            tf <= 60
              ? computeOIForSlice(sniperBars, oiRaw, exOn)
              : getOIDisplayTf(sniperBars, ext1m);
          sniperCache.k = sk;
          sniperCache.sig = computeSniper(sniperBars, oiS.agg);
          sniperCache.extSt = extSt;
        }
        const sig = sniperCache.sig;
        const off = st - sniperCache.extSt;
        const sC = chartTheme.sniper;
        for (let i = 0; i < shown.length; i++) {
          const s = sig[i + off];
          if (!s) continue;
          const bar = shown[i];
          const x = toX(i);
          const types = [];
          if (s.vol) types.push('vol');
          if (s.rng) types.push('rng');
          if (s.oi) types.push('oi');
          for (let j = 0; j < types.length; j++) {
            const col = sC[types[j]];
            const rad = Math.max(3, Math.min(7, cw * 1.2));
            const sp = rad * 2.5;
            const ar = rad * 0.55;
            if (s.dir === 'up') {
              const y = toY(bar.l) + rad * 2.2 + j * sp;
              ctx.fillStyle = col;
              ctx.beginPath();
              ctx.arc(x, y, rad, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = chartTheme.sniperGlyph;
              ctx.beginPath();
              ctx.moveTo(x, y - ar);
              ctx.lineTo(x - ar, y + ar * 0.5);
              ctx.lineTo(x + ar, y + ar * 0.5);
              ctx.closePath();
              ctx.fill();
            } else {
              const y = toY(bar.h) - rad * 2.2 - j * sp;
              ctx.fillStyle = col;
              ctx.beginPath();
              ctx.arc(x, y, rad, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = chartTheme.sniperGlyph;
              ctx.beginPath();
              ctx.moveTo(x, y + ar);
              ctx.lineTo(x - ar, y - ar * 0.5);
              ctx.lineTo(x + ar, y - ar * 0.5);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
      }
    } catch (_e) {}

  if (ind.rev)
    try {
      if (all.length >= SNIPER_MIN && oscCache.rsi.length === all.length) {
        const rk = 'rev:' + tf + ':' + all.length + ':' + (all[all.length - 1]?.t || 0);
        if (rk !== revCache.k) {
          revCache.k = rk;
          revCache.sig = computeReversionScreener(all, oscCache.rsi);
        }
        const sig = revCache.sig;
        const rad = Math.max(3, Math.min(6, cw * 1.0));
        const ar = rad * 0.9;
        for (let i = 0; i < shown.length; i++) {
          const gi = st + i;
          const d = sig[gi];
          if (!d) continue;
          const bar = shown[i];
          const x = toX(i);
          if (d === 'long') {
            const y = toY(bar.l) + rad * 2;
            ctx.fillStyle = chartTheme.revLong;
            ctx.beginPath();
            ctx.moveTo(x, y - ar);
            ctx.lineTo(x - ar, y + ar * 0.45);
            ctx.lineTo(x + ar, y + ar * 0.45);
            ctx.closePath();
            ctx.fill();
          } else {
            const y = toY(bar.h) - rad * 2;
            ctx.fillStyle = chartTheme.revShort;
            ctx.beginPath();
            ctx.moveTo(x, y + ar);
            ctx.lineTo(x - ar, y - ar * 0.45);
            ctx.lineTo(x + ar, y - ar * 0.45);
            ctx.closePath();
            ctx.fill();
          }
        }
      }
    } catch (_e) {}

  if (ind.vrng)
    try {
      const extNeed = Math.min(all.length, Math.max(SNIPER_MIN, v));
      const extSt = Math.max(0, end - extNeed);
      const sliceBars = all.slice(extSt, end);
      if (
        sliceBars.length >= SNIPER_MIN &&
        oscCache.rsi.length === all.length
      ) {
        const sk =
          'vr:' + tf + ':' + extSt + ':' + end + ':' + scrollOff + ':' + (sliceBars[0]?.t || 0);
        if (sk !== vrngCache.k) {
          vrngCache.k = sk;
          const rsiLoc = oscCache.rsi.slice(extSt, end);
          vrngCache.sig = computeVolRangeSniper(sliceBars, rsiLoc);
          vrngCache.extSt = extSt;
        }
        const sig = vrngCache.sig;
        const off = st - vrngCache.extSt;
        const rad = Math.max(2.5, Math.min(5.5, cw * 0.95));
        for (let i = 0; i < shown.length; i++) {
          const d = sig[i + off];
          if (!d) continue;
          const bar = shown[i];
          const x = toX(i);
          ctx.fillStyle = d === 'long' ? chartTheme.vrngLong : chartTheme.vrngShort;
          ctx.beginPath();
          if (d === 'long') ctx.arc(x, toY(bar.l) + rad * 2.2, rad * 0.85, 0, Math.PI * 2);
          else ctx.arc(x, toY(bar.h) - rad * 2.2, rad * 0.85, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } catch (_e) {}

  if (lastP != null && lastP >= lo && lastP <= hi) {
    const y = toY(lastP);
    ctx.strokeStyle = chartTheme.priceLine;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const tw = ctx.measureText(fP(lastP)).width + 6;
    ctx.fillStyle = chartTheme.priceTagBg;
    ctx.fillRect(xRight, y - 6, tw + 3, 12);
    ctx.fillStyle = chartTheme.priceTagText;
    ctx.font = "bold 8px 'IBM Plex Mono',monospace";
    ctx.textAlign = 'left';
    ctx.fillText(fP(lastP), xRight + 2, y + 3);
  }

  const oscFull = ind.osc ? oscCache.arr : null;
  let py = pT + ohlcH + gap;
  const panelDividersY = [];
  for (let idx = 0; idx < subs.length; idx++) {
    const s = subs[idx];
    const rowH = eachHeights[idx];
    ctx.strokeStyle = chartTheme.panelRule;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pL, py - 1);
    ctx.lineTo(xRight, py - 1);
    ctx.stroke();
    const topPad = s === 'oi' ? 2 : 9;
    const pH = Math.max(s === 'oi' ? 4 : 6, rowH - topPad);
    const dT = py + topPad;

    drawVerticalGrid(ctx, pL, xRight, dT, dT + pH);
    drawHorizontalGridBands(ctx, pL, xRight, dT, pH, pH < 32 ? 2 : 3);

    if (s === 'netlongs' || s === 'netshorts') {
      const mode = s === 'netlongs' ? 'longs' : 'shorts';
      const col = s === 'netlongs' ? GLOW : EMBER;
      const fill = s === 'netlongs' ? chartTheme.longFill : chartTheme.shortFill;
      ctx.fillStyle = col;
      ctx.font = "600 7px 'IBM Plex Mono',monospace";
      ctx.textAlign = 'left';
      ctx.fillText(s === 'netlongs' ? 'NET LONGS' : 'NET SHORTS', pL + 3, py + 7);

      if (ind.split) {
        const series = [];
        for (const ex of oiFull1m.activeEx) {
          const exOi = oiFull1m.perEx[ex];
          if (!exOi) continue;
          const cum1m = cumNetLS(exOi, ext1m, mode);
          const vals = downsampleCumToTf(cum1m, ext1m, shown, tf);
          const { toY: ty, last: lst } = linePanelScale(vals, dT, pH);
          let ly = Math.max(dT + 8, Math.min(dT + pH - 2, ty(lst) + 3));
          series.push({ ex, vals, ly });
        }
        const fixed = staggerEndLabelYs(
          series.map((r) => r.ly),
          dT,
          pH
        );
        for (let i = 0; i < series.length; i++) {
          const m = series[i];
          drawLine(
            ctx,
            m.vals,
            dT,
            pH,
            pL,
            xRight,
            toX,
            EX_COLORS[m.ex] || chartTheme.splitMuted,
            'transparent',
            0.75,
            EX_SHORT[m.ex] || m.ex,
            fixed[i]
          );
        }
      } else {
        const cum1m = cumNetLSMulti(oiFull1m.perEx, oiFull1m.activeEx, ext1m, mode);
        const vals = downsampleCumToTf(cum1m, ext1m, shown, tf);
        drawLine(ctx, vals, dT, pH, pL, xRight, toX, col, fill, 0.8);
      }
    }

    if (s === 'oi') {
      let gBounds;
      let perExForBounds;
      if (tf <= 60) {
        gBounds = oiAbsBoundsFromAgg(oiFull1m.agg);
        perExForBounds = oiFull1m.perEx;
      } else {
        const perExDispAll = aggregatePerExOiToTf(
          oiFull1m.perEx,
          ext1m,
          all,
          oiFull1m.activeEx,
          tf
        );
        const aggAll = sumPerExToAgg(perExDispAll, oiFull1m.activeEx, all.length);
        gBounds = oiAbsBoundsFromAgg(aggAll);
        perExForBounds = perExDispAll;
      }
      if (gBounds)
        oiPanelHud = { dT, pH, base: 0, hi: gBounds.hi, lo: gBounds.lo, agg: oiData.agg };
      if (ind.split) {
        const series = [];
        for (const ex of oiData.activeEx) {
          const exOi = oiData.perEx[ex];
          if (!exOi) continue;
          const col = EX_COLORS[ex] || chartTheme.splitMuted;
          series.push({ exOi, ex, col });
        }
        const nex = series.length;
        const obW = Math.max(1, Math.min(bW * 0.55, cw / Math.max(nex + 1.2, 2)));
        const owk = Math.max(1, Math.min(obW * 0.22, 2.1));
        for (let ei = 0; ei < series.length; ei++) {
          const m = series[ei];
          const xOff = (ei - (nex - 1) / 2) * Math.min(9, cw * 0.11);
          const toXEx = (i) => toX(i) + xOff;
          const boundsEx = oiAbsBoundsFromAgg(perExForBounds[m.ex]);
          drawOiCandlesPanel(
            ctx,
            m.exOi,
            dT,
            pH,
            pL,
            xRight,
            toXEx,
            obW,
            owk,
            0,
            {
              wickBull: m.col,
              wickBear: m.col,
              bull: m.col,
              bear: chartTheme.bear,
              bodyLine: m.col,
              bearBorder: chartTheme.bearBorder,
            },
            '',
            undefined,
            ei === nex - 1,
            boundsEx || undefined,
            false
          );
        }
      } else {
        drawOiCandlesPanel(
          ctx,
          oiData.agg,
          dT,
          pH,
          pL,
          xRight,
          toX,
          bW,
          wkW,
          0,
          null,
          '',
          undefined,
          true,
          gBounds || undefined,
          false
        );
      }
    }

    if (s === 'osc' && oscFull) {
      ctx.fillStyle = chartTheme.oscLine;
      ctx.font = "600 7px 'IBM Plex Mono',monospace";
      ctx.textAlign = 'left';
      ctx.fillText('PCT', pL + 3, py + 7);
      const oscVals = [];
      const p95Vals = [];
      for (let i = 0; i < shown.length; i++) {
        const gi = st + i;
        oscVals.push(oscFull[gi]);
        p95Vals.push(oscCache.p95[gi]);
      }
      drawOscPanel(ctx, oscVals, p95Vals, dT, pH, pL, xRight, toX);
    }

    py += rowH + gap;
    if (idx < subs.length - 1) panelDividersY.push(py - gap / 2);
  }

  lastLayout = {
    ohlcBottom: pT + ohlcH,
    priceOhlcH,
    panelDividers: panelDividersY,
    indBody,
    subsLen: subs.length,
    oiPanel: oiPanelHud,
  };

  if (showXH && !isDrag && mouseX >= pL && mouseX <= xRight) {
    ctx.strokeStyle = chartTheme.crosshair;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(mouseX, pT);
    ctx.lineTo(mouseX, H - pB);
    ctx.stroke();
    if (mouseY >= pT && mouseY <= pT + ohlcH) {
      ctx.beginPath();
      ctx.moveTo(pL, mouseY);
      ctx.lineTo(xRight, mouseY);
      ctx.stroke();
      const poh = lastLayout.priceOhlcH;
      if (mouseY <= pT + poh) {
        const pr = hi - ((mouseY - pT) / poh) * pRn;
        ctx.fillStyle = chartTheme.crosshairLabelBg;
        ctx.fillRect(xRight, mouseY - 6, pR, 12);
        ctx.fillStyle = chartTheme.crosshairLabelText;
        ctx.font = "8px 'IBM Plex Mono',monospace";
        ctx.textAlign = 'left';
        ctx.fillText(fP(pr), xRight + 3, mouseY + 3);
      }
    }
    const opHud = lastLayout.oiPanel;
    if (
      opHud &&
      ind.oi &&
      mouseY >= opHud.dT &&
      mouseY <= opHud.dT + opHud.pH &&
      mouseX >= pL &&
      mouseX <= xRight
    ) {
      ctx.beginPath();
      ctx.moveTo(pL, mouseY);
      ctx.lineTo(xRight, mouseY);
      ctx.stroke();
      const t = (mouseY - opHud.dT) / opHud.pH;
      const vDelta = opHud.hi - t * (opHud.hi - opHud.lo);
      const vAbs = vDelta + opHud.base;
      ctx.fillStyle = chartTheme.crosshairLabelBg;
      ctx.fillRect(xRight, mouseY - 6, pR, 12);
      ctx.fillStyle = chartTheme.crosshairLabelText;
      ctx.font = "8px 'IBM Plex Mono',monospace";
      ctx.textAlign = 'left';
      ctx.fillText(fN(vAbs), xRight + 3, mouseY + 3);
    }
    const ci = Math.floor((mouseX - pL - plotShiftX) / cw);
    if (ci >= 0 && ci < shown.length) {
      const d = new Date(shown[ci].t);
      let tl =
        d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
      if (tf < 60) tl += ':' + d.getSeconds().toString().padStart(2, '0');
      const tw2 = ctx.measureText(tl).width + 6;
      ctx.fillStyle = chartTheme.crosshairLabelBg;
      ctx.fillRect(mouseX - tw2 / 2, H - pB - 1, tw2, 11);
      ctx.fillStyle = chartTheme.crosshairLabelText;
      ctx.font = "8px 'IBM Plex Mono',monospace";
      ctx.textAlign = 'center';
      ctx.fillText(tl, mouseX, H - pB + 7);
      const c = shown[ci];
      ctx.font = "8px 'IBM Plex Mono',monospace";
      ctx.textAlign = 'left';
      const info = `O ${fP(c.o)} H ${fP(c.h)} L ${fP(c.l)} C ${fP(c.c)}`;
      let oiHud = '';
      const opX = lastLayout.oiPanel;
      if (
        opX &&
        ind.oi &&
        mouseY >= opX.dT &&
        mouseY <= opX.dT + opX.pH
      ) {
        const ob = opX.agg[ci];
        if (ob) {
          const dBody = ob.oiC - ob.oiO;
          oiHud = `OI O ${fN(ob.oiO)} H ${fN(ob.oiH)} L ${fN(ob.oiL)} C ${fN(ob.oiC)}  ${fSignedN(dBody)} vs open`;
        }
      }
      const iw = Math.max(
        ctx.measureText(info).width + 8,
        oiHud ? ctx.measureText(oiHud).width + 8 : 0
      );
      const ih = oiHud ? 24 : 12;
      ctx.fillStyle = chartTheme.hudBg;
      ctx.fillRect(pL + 2, pT, iw, ih);
      ctx.fillStyle = chartTheme.hudText;
      ctx.fillText(info, pL + 6, pT + 9);
      if (oiHud) ctx.fillText(oiHud, pL + 6, pT + 21);
    }
  }

  drawAnnotOverlay(ctx);
}

function drawAnnotOverlay(ctx) {
  if (!annotStrokes.length && !annotDrawing) return;
  ctx.strokeStyle = chartTheme.annotStroke;
  ctx.lineWidth = 1.65;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const paint = (pts) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  };
  for (const s of annotStrokes) paint(s.points);
  if (annotDrawing) paint(annotDrawing.points);
}

async function loadChart() {
  $st.textContent = 'Loading…';
  $st.className = 'status-pill';
  try {
    const extraH = Math.ceil((1000 * 60) / 3600);
    const res = await fetch(`/api/chart?symbol=${sym}&tf=60&hours=${loadedHours + extraH}`);
    const data = await res.json();
    bars1m = data.bars || [];
    oiRaw = data.oiByEx || {};
    if (bars1m.length > 0) lastP = bars1m[bars1m.length - 1].c;
    $st.textContent = bars1m.length + ' bars';
    $st.className = 'status-pill live';
    invalidateOICaches();
  } catch (e) {
    console.error(e);
    $st.textContent = 'error';
    $st.className = 'status-pill status-err';
  }
  updSB();
  scheduleRedraw();
}

async function loadMore() {
  $st.textContent = 'Loading…';
  $st.className = 'status-pill';
  try {
    const extraH = Math.ceil((1000 * 60) / 3600);
    const res = await fetch(`/api/chart?symbol=${sym}&tf=60&hours=${loadedHours + extraH}`);
    const data = await res.json();
    const newBars = data.bars || [];
    if (newBars.length > 0) {
      const oldStart = bars1m.length ? bars1m[0].t : Infinity;
      const newStart = newBars[0].t;
      if (newBars.length > bars1m.length || newStart < oldStart) {
        bars1m = newBars;
        oiRaw = data.oiByEx || {};
      }
    }
    if (bars1m.length > 0) lastP = bars1m[bars1m.length - 1].c;
    const total = displayBarCount() || 1;
    if (targetVis > vis) {
      vis = Math.min(total, targetVis);
      syncVisLabel();
    }
    $st.textContent = bars1m.length + ' bars';
    $st.className = 'status-pill live';
    invalidateOICaches();
  } catch (e) {
    $st.textContent = 'error';
    $st.className = 'status-pill status-err';
  }
  updSB();
  scheduleRedraw();
}

async function switchSym(s) {
  bars1m = [];
  oiRaw = {};
  curBar = null;
  lastP = null;
  annotStrokes.length = 0;
  annotDrawing = null;
  plotShiftX = 0;
  scrollOff = 0;
  autoScr = true;
  vis = 1000;
  targetVis = 1000;
  loadedHours = 17;
  invalidateOICaches();
  sym = s;
  $pl.textContent = s.replace('USDT', '/USDT');
  document.title = 'heat.rip — ' + s.replace('USDT', '/USDT');
  hlT(s);
  await loadChart();
  resub();
  updSB();
}

let tickers = [];
let tF = '';
let tSort = 'vol';
async function fetchT() {
  try {
    tickers = await (await fetch('/api/tickers')).json();
    renT();
  } catch (e) {}
}
function orderedFl(list) {
  const a = [...list];
  if (tSort === 'alpha') a.sort((x, y) => x.symbol.localeCompare(y.symbol));
  else a.sort((x, y) => parseFloat(y.quoteVolume) - parseFloat(x.quoteVolume));
  return a;
}
function renT() {
  const f = tF.toUpperCase();
  const base = f ? tickers.filter((t) => t.symbol.includes(f)) : tickers;
  const fl = orderedFl(base);
  let h = '';
  for (const t of fl) {
    const ch = parseFloat(t.priceChangePercent);
    const col = ch >= 0 ? GLOW : EMBER;
    const s = ch >= 0 ? '+' : '';
    const a = t.symbol === sym ? 'active' : '';
    h += `<div class="ti-row ${a}" data-sym="${t.symbol}"><span class="ti-sym">${t.symbol.replace('USDT', '')}</span><span class="ti-price">${fP(parseFloat(t.lastPrice))}</span><span class="ti-ch" style="color:${col}">${s}${ch.toFixed(2)}%</span></div>`;
  }
  $tl.innerHTML = h;
}
function hlT(s) {
  document.querySelectorAll('.ti-row').forEach((el) => el.classList.toggle('active', el.dataset.sym === s));
}
$tl.addEventListener('click', (e) => {
  const it = e.target.closest('.ti-row');
  if (it) switchSym(it.dataset.sym);
});
$si.addEventListener('input', (e) => {
  tF = e.target.value;
  renT();
});

const $sortExg = $('sort-exg');
$sortExg?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tsort]');
  if (!b) return;
  tSort = b.dataset.tsort;
  $sortExg.querySelectorAll('[data-tsort]').forEach((x) => x.classList.toggle('on', x === b));
  renT();
});

const $annotToggle = $('annot-toggle');
const $annotClear = $('annot-clear');
$annotToggle.addEventListener('click', () => {
  annotDrawOn = !annotDrawOn;
  $annotToggle.classList.toggle('on', annotDrawOn);
  $annotToggle.setAttribute('aria-pressed', annotDrawOn ? 'true' : 'false');
});
$annotClear.addEventListener('click', (e) => {
  e.stopPropagation();
  annotStrokes.length = 0;
  annotDrawing = null;
  scheduleRedraw();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && annotDrawing) {
    annotDrawing = null;
    scheduleRedraw();
  }
});

function downloadChartPngBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heatrip-${sym}-${Date.now()}.png`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

const $chartCopy = $('chart-copy');
$chartCopy.addEventListener('click', async () => {
  let blob;
  try {
    blob = await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png', 1);
    });
  } catch (e) {
    console.error(e);
    $st.textContent = 'png error';
    $st.className = 'status-pill status-err';
    return;
  }
  const prev = $st.textContent;
  const prevC = $st.className;
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      $st.textContent = 'copied PNG';
      $st.className = 'status-pill live';
      setTimeout(() => {
        $st.textContent = prev;
        $st.className = prevC;
      }, 1600);
      return;
    }
    throw new Error('clipboard unsupported');
  } catch (e) {
    console.warn('clipboard:', e);
    downloadChartPngBlob(blob);
    $st.textContent = 'saved PNG (open Downloads if clipboard blocked)';
    $st.className = 'status-pill live';
    setTimeout(() => {
      $st.textContent = prev;
      $st.className = prevC;
    }, 2200);
  }
});

(async () => {
  initTheme();
  $('theme-toggle')?.addEventListener('click', toggleTheme);
  $('tf-exg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    setTf(Number(b.dataset.tf));
  });
  await fetchT();
  await loadChart();
  connectWS();
  updSB();
  scheduleRedraw();
  setInterval(fetchT, 60000);
})();
