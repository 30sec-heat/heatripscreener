import { GLOW, EMBER, MAX_BARS, EX_COLORS, EX_SHORT, SNIPER_MIN } from './constants.js';
import { chartTheme, setChartTheme } from './chart-theme.js';
import { fP, fN, fSignedN } from './format.js';
import { computeOIForSlice, oiAbsBoundsFromAgg } from './oi.js';
import { cumNetLS, cumNetLSMulti } from './net-ls.js';
import {
  computeSniper,
  computeReversionScreener,
  computeVolRangeSniper,
} from './sniper.js';
import { drawLine, drawOiCandlesPanel, linePanelScale, staggerEndLabelYs } from './draw.js';
import { aggregateOHLCVFrom1m, downsampleCumToTf, aggregatePerExOiToTf } from './timeframe.js';
import { drawVerticalGrid, drawHorizontalGridBands } from './chart-grid.js';
import { mirrorlyXAt, TIME_X_EXTRAP_BARS } from './chart-time-x.js';
import { mirrorlyBarForTime, mirrorlyPriceAtTime } from './mirrorly-geometry.js';
import {
  registerMirrorlyRedraw,
  loadExchangeLogoManifest,
  drawMirrorlyExchangeDisc,
  mirrorlySidJit,
  pickMirrorlyHit,
  mirrorlyHitKey,
  showMirrorlyTip,
  hideMirrorlyTip,
} from './mirrorly-ui.js';
import {
  newsItems,
  newsHits,
  newsHitKey,
  pickNewsHit,
  showNewsTip,
  hideNewsTip,
  fetchNews,
  clearNewsForToggle,
  registerNewsRedraw,
} from './news-ui.js';
import {
  oscCache,
  ensureOscDerived,
  invalidateOscDerived,
  drawOscPanel,
  drawPctArrows,
} from './chart-osc-panel.js';

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d', { alpha: false, colorSpace: 'srgb' });
let W, H;

let rafDraw = 0;
function scheduleRedraw() {
  if (rafDraw) return;
  rafDraw = requestAnimationFrame(() => {
    rafDraw = 0;
    draw();
  });
}

registerMirrorlyRedraw(scheduleRedraw);
registerNewsRedraw(scheduleRedraw);

/** WS tick updates can flood 50+/s; cap redraws for live price / forming candle. */
let liveRedrawTimer = null;
let liveRedrawT = 0;
function scheduleLiveRedraw() {
  const now = performance.now();
  const gap = 55;
  const flush = () => {
    liveRedrawTimer = null;
    liveRedrawT = performance.now();
    if (sym && lastP != null && Number.isFinite(lastP)) patchSidebarLivePrice(sym, lastP);
    scheduleRedraw();
  };
  if (now - liveRedrawT >= gap) {
    flush();
    return;
  }
  if (liveRedrawTimer) return;
  liveRedrawTimer = setTimeout(flush, gap - (now - liveRedrawT));
}

function resize() {
  const parent = cv.parentElement;
  if (!parent) return;
  const W0 = Math.max(1, Math.floor(parent.clientWidth || 0));
  const H0 = Math.max(1, Math.floor(parent.clientHeight || 0));
  W = W0;
  H = H0;
  const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  const bw = Math.max(1, Math.round(W * dpr));
  const bh = Math.max(1, Math.round(H * dpr));
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  cv.width = bw;
  cv.height = bh;
  ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
  ctx.imageSmoothingEnabled = true;
  scheduleRedraw();
}
resize();
window.addEventListener('resize', resize);
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
if (cv.parentElement && typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => resize());
  ro.observe(cv.parentElement);
}

const THEME_KEY = 'heatrip-theme';

function syncThemeToggleLabel() {
  const btn = $('theme-toggle');
  if (!btn) return;
  const light = document.documentElement.dataset.theme === 'light';
  btn.setAttribute('aria-pressed', light ? 'true' : 'false');
  const t = light ? 'Use dark theme' : 'Use light theme';
  btn.title = t;
  btn.setAttribute('aria-label', t);
  const sun = btn.querySelector('.theme-ico-sun');
  const moon = btn.querySelector('.theme-ico-moon');
  if (sun && moon) {
    sun.classList.toggle('hidden', light);
    moon.classList.toggle('hidden', !light);
  }
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
  headlines: false,
  mirrorly: false,
  obwalls: false,
};
const PANEL_GAP = 4;
/** Min height for all indicator rows combined (drag OHLC vs stack divider). */
const MIN_IND_BLOCK_PER_ROW = 14;
const OHLC_FRAC_MIN = 0.38;
const OHLC_FRAC_MAX = 0.88;
let ohlcFrac = 0.64;
/** >1 = more vertical padding (wider price range on screen); &lt;1 = tighter. Right-drag or Shift+drag on candles. */
let priceYZoom = 1;
let priceZoomDrag = null;
const PRICE_Y_ZOOM_MIN = 0.12;
const PRICE_Y_ZOOM_MAX = 52;
const PRICE_ZOOM_SENS = 0.0065;
let panelFracs = [];
let lastLayout = null;
let resizeDrag = null;
const exOn = new Set(['binance-futures', 'bybit', 'okex-swap', 'deribit', 'hyperliquid']);
const KNOWN_EX = ['binance-futures', 'bybit', 'okex-swap', 'deribit', 'hyperliquid'];

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

function invalidateOICaches() {
  invalidateOISlice();
  invalidateOscDerived();
}

document.querySelectorAll('input[data-ind]').forEach((inp) => {
  inp.addEventListener('change', () => {
    const kk = inp.dataset.ind;
    ind[kk] = inp.checked;
    if (kk === 'headlines') {
      if (ind.headlines) void fetchNews(ind.headlines);
      else {
        clearNewsForToggle();
        newsTipPinned = false;
        newsTipPinnedKey = '';
        hideNewsTip();
      }
    }
    if (kk === 'mirrorly') {
      if (ind.mirrorly) void refreshMirrorly();
      else {
        mirrorlyRows = [];
        mirrorlyTipPinned = false;
        mirrorlyTipPinnedKey = '';
        hideMirrorlyTip();
      }
    }
    if (kk === 'obwalls' && !ind.obwalls) {
      tapeWallsLoadedKey = '';
      tapeWallsSegments.length = 0;
      tapeWallsFetchGen++;
      if (tapeWallsDeb) {
        clearTimeout(tapeWallsDeb);
        tapeWallsDeb = null;
      }
    }
    if (kk === 'split' && ind.split) {
      exOn.delete('deribit');
      document.querySelector('[data-ex="deribit"]')?.classList.remove('on');
    }
    invalidateOISlice();
    scheduleSaveUiConfig();
    if (kk === 'split') loadChart();
    else scheduleRedraw();
  });
});
document.querySelectorAll('[data-ex]').forEach((b) => {
  b.addEventListener('click', () => {
    const k = b.dataset.ex;
    if (exOn.has(k)) exOn.delete(k);
    else exOn.add(k);
    b.classList.toggle('on', exOn.has(k));
    invalidateOISlice();
    scheduleSaveUiConfig();
    scheduleRedraw();
  });
});

/** False until /api/chart finishes (empty response still counts). Used so canvas is not stuck on “Loading…” forever. */
let chartHistoryLoaded = false;

let sym = 'BTCUSDT';
/** TapeSurf OB wall segments from GET /api/tapesurf-walls (1m snapshots, Binance). */
let tapeWallsSegments = [];
let tapeWallsDeb = null;
let tapeWallsFetchGen = 0;
/** Last chart view for which we finished a fetch (avoid rescheduling every animation frame). */
let tapeWallsLoadedKey = '';

function scheduleTapeWallsFetch(shown) {
  if (!ind.obwalls || !shown.length) {
    tapeWallsLoadedKey = '';
    tapeWallsSegments.length = 0;
    tapeWallsFetchGen++;
    if (tapeWallsDeb) {
      clearTimeout(tapeWallsDeb);
      tapeWallsDeb = null;
    }
    return;
  }
  const fromMs = shown[0].t;
  const toMs = shown[shown.length - 1].t + tf * 1000;
  const key = `${sym}|${fromMs}|${toMs}`;
  if (key === tapeWallsLoadedKey) return;
  if (tapeWallsDeb) clearTimeout(tapeWallsDeb);
  tapeWallsDeb = setTimeout(() => {
    tapeWallsDeb = null;
    const gen = ++tapeWallsFetchGen;
    void (async () => {
      try {
        const r = await fetch(
          `/api/tapesurf-walls?symbol=${encodeURIComponent(sym)}&fromMs=${fromMs}&toMs=${toMs}`,
          { cache: 'no-store' },
        );
        const j = await r.json();
        if (gen !== tapeWallsFetchGen) return;
        if (!ind.obwalls) return;
        tapeWallsLoadedKey = key;
        tapeWallsSegments = Array.isArray(j.segments) ? j.segments : [];
        scheduleRedraw();
      } catch (_e) {
        if (gen === tapeWallsFetchGen && ind.obwalls) {
          tapeWallsLoadedKey = key;
          tapeWallsSegments = [];
          scheduleRedraw();
        }
      }
    })();
  }, 420);
}

/** Mirrorly overlay rows from GET /api/mirrorly (server-side aggregated). */
let mirrorlyRows = [];
/** Hit targets for hover: filled in draw() when Mirrorly is on. Canvas coords. */
let mirrorlyHits = [];
/** Tip stays open after bubble click until the same bubble is clicked again. */
let mirrorlyTipPinned = false;
let mirrorlyTipPinnedKey = '';
let newsTipPinned = false;
let newsTipPinnedKey = '';
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
  if (!chartHistoryLoaded) return bars1m;
  return curBar ? bars1m.concat([curBar]) : bars1m;
}

function displayAllFromExt(ext) {
  if (!ext.length) return [];
  return tf <= 60 ? ext : aggregateOHLCVFrom1m(ext, tf);
}

function displayBarCount() {
  return displayAllFromExt(ext1mSeries()).length;
}

async function refreshMirrorly() {
  if (!ind.mirrorly) return;
  void loadExchangeLogoManifest();
  try {
    const r = await fetch(`/api/mirrorly?symbol=${encodeURIComponent(sym)}`, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    mirrorlyRows = Array.isArray(j.positions) ? j.positions : [];
    scheduleRedraw();
  } catch (_e) {
    /* ignore */
  }
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
  scheduleSaveUiConfig();
  scheduleRedraw();
}

const $ = (id) => document.getElementById(id);
const DOC_TITLE_PAIR = (pair) => `${pair} · heat.rip`;
const $pl = $('pl'),
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
    ws.send(JSON.stringify({ subscribe: [sym], timeframes: [60] }));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (
      !chartHistoryLoaded &&
      m.symbol === sym &&
      (m.type === 'bar_update' || m.type === 'bar')
    ) {
      return;
    }
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
      lastP = m.bar.close;
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
      lastP = m.bar.close;
      patchSidebarLivePrice(sym, lastP);
      invalidateOICaches();
      if (autoScr) updSB();
      scheduleRedraw();
    }
  };
  ws.onclose = () => {
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
  scheduleSaveUiConfig();
}

/**
 * Change visible bar count while keeping the time slice under `canvasMouseX` stable
 * (same plot-X fraction before/after zoom).
 */
function zoomVisAnchored(rawTargetVis, canvasMouseX) {
  const all = displayAllFromExt(ext1mSeries());
  const n = all.length;
  const total = Math.max(1, n);
  const newVis = Math.max(10, Math.min(total, Math.round(rawTargetVis)));
  targetVis = Math.max(10, rawTargetVis);

  if (n < 2) {
    vis = newVis;
    plotShiftX = 0;
    clamp();
    syncVisLabel();
    updSB();
    invalidateOISlice();
    scheduleRedraw();
    scheduleSaveUiConfig();
    return;
  }

  const vis0 = Math.min(n, vis);
  const end0 = n - scrollOff;
  const st0 = Math.max(0, end0 - vis0);

  const cW = W - pL - pR - CHART_PAD_R;
  if (cW <= 1) {
    zoomVis(rawTargetVis);
    return;
  }

  const mx = Math.max(pL, Math.min(pL + cW, canvasMouseX));
  const pFrac = Math.max(0, Math.min(1, (mx - pL - plotShiftX) / cW));
  const st1 = Math.round(st0 + pFrac * vis0 - pFrac * newVis);
  const stClamped = Math.max(0, Math.min(n - newVis, st1));

  vis = newVis;
  scrollOff = n - stClamped - newVis;
  plotShiftX = 0;
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
  scheduleSaveUiConfig();
}

/** Normalize wheel deltas to ~pixel units so LINE/PAGE devices match trackpads. */
function wheelPixelDeltas(e) {
  let dy = e.deltaY;
  let dx = e.deltaX;
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    dy *= 16;
    dx *= 16;
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    dy *= 400;
    dx *= 400;
  }
  return { dx, dy };
}

/** Let browser handle wheel when pointer is over a scrollable ancestor that can still move. */
function nativeWheelAllowed(e) {
  const { dx, dy } = wheelPixelDeltas(e);
  let el = e.target.nodeType === Node.ELEMENT_NODE ? e.target : e.target.parentElement;
  for (; el && el !== document.documentElement; el = el.parentElement) {
    const st = getComputedStyle(el);
    const oy = st.overflowY;
    const ox = st.overflowX;
    const yScroll =
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    const xScroll =
      (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
    if (yScroll && dy !== 0) {
      const maxY = el.scrollHeight - el.clientHeight;
      const top = el.scrollTop;
      if ((dy < 0 && top > 0.5) || (dy > 0 && top < maxY - 0.5)) return true;
    }
    if (xScroll && dx !== 0) {
      const maxX = el.scrollWidth - el.clientWidth;
      const left = el.scrollLeft;
      if ((dx < 0 && left > 0.5) || (dx > 0 && left < maxX - 0.5)) return true;
    }
  }
  return false;
}

cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const { dy } = wheelPixelDeltas(e);
    if (dy === 0 && !e.shiftKey) return;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left;
    if (e.shiftKey) {
      const step = Math.max(1, Math.round(vis * 0.05));
      const prevOff = scrollOff;
      const mag = Math.min(6, Math.max(1, Math.round(Math.abs(dy) / 50)));
      scrollOff = scrollOff + Math.sign(dy) * step * mag;
      autoScr = false;
      clamp();
      updSB();
      if (scrollOff !== prevOff) invalidateOISlice();
      scheduleRedraw();
    } else {
      const dir = Math.sign(dy);
      if (dir === 0) return;
      const mag = Math.min(8, Math.max(1, Math.round(Math.abs(dy) / 48)));
      const step = Math.max(2, Math.round(vis * 0.08));
      zoomVisAnchored(vis + dir * step * mag, mx);
    }
  },
  { passive: false }
);
document.addEventListener(
  'wheel',
  (e) => {
    if (nativeWheelAllowed(e)) return;
    e.preventDefault();
  },
  { passive: false }
);

cv.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

cv.addEventListener('mousedown', (e) => {
  const r = cv.getBoundingClientRect();
  const my = e.clientY - r.top;
  const mx = e.clientX - r.left;

  if (e.button === 2) {
    if (
      lastLayout &&
      mx >= lastLayout.pL &&
      mx <= lastLayout.xRight &&
      my > (lastLayout.ohlcTop ?? pT) + 4 &&
      my < lastLayout.ohlcBottom - 4
    ) {
      priceZoomDrag = { sy: e.clientY, z0: priceYZoom };
      e.preventDefault();
      cv.style.cursor = 'ns-resize';
    }
    return;
  }

  if (e.button) return;

  if (
    annotDrawOn &&
    !(e.altKey || e.metaKey) &&
    !e.shiftKey &&
    mx >= 0 &&
    mx <= r.width &&
    my >= 0 &&
    my <= r.height
  ) {
    annotDrawing = { points: [{ x: mx, y: my }] };
    e.preventDefault();
    return;
  }

  if (ind.mirrorly && lastLayout?.pL != null) {
    const otop = lastLayout.ohlcTop ?? pT;
    const overOhlc =
      mx >= lastLayout.pL &&
      mx <= lastLayout.xRight &&
      my >= otop + 2 &&
      my <= lastLayout.ohlcBottom - 2;
    const mh = overOhlc ? pickMirrorlyHit(mx, my, mirrorlyHits) : null;
    if (mh) {
      const k = mirrorlyHitKey(mh);
      if (mirrorlyTipPinned && mirrorlyTipPinnedKey === k) {
        mirrorlyTipPinned = false;
        mirrorlyTipPinnedKey = '';
        hideMirrorlyTip();
      } else {
        mirrorlyTipPinned = true;
        mirrorlyTipPinnedKey = k;
        newsTipPinned = false;
        newsTipPinnedKey = '';
        hideNewsTip();
        showMirrorlyTip(mh.row, mh.kind, e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }
  }

  if (ind.headlines && lastLayout?.pL != null) {
    const otop = lastLayout.ohlcTop ?? pT;
    const overOhlcNews =
      mx >= lastLayout.pL &&
      mx <= lastLayout.xRight &&
      my >= otop + 2 &&
      my <= lastLayout.ohlcBottom - 2;
    const nhDown = overOhlcNews ? pickNewsHit(mx, my, ind.headlines, lastLayout) : null;
    if (nhDown) {
      const nk = newsHitKey(nhDown);
      if (newsTipPinned && newsTipPinnedKey === nk) {
        newsTipPinned = false;
        newsTipPinnedKey = '';
        hideNewsTip();
      } else {
        newsTipPinned = true;
        newsTipPinnedKey = nk;
        mirrorlyTipPinned = false;
        mirrorlyTipPinnedKey = '';
        hideMirrorlyTip();
        showNewsTip(nhDown.title, nhDown.url, nhDown.macro, e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }
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
    const otop = lastLayout?.ohlcTop ?? pT;
    if (
      lastLayout &&
      mx > lastLayout.xRight &&
      mx <= r.width &&
      my > otop + 4 &&
      my < lastLayout.ohlcBottom - 4
    ) {
      priceZoomDrag = { sy: e.clientY, z0: priceYZoom };
      e.preventDefault();
      cv.style.cursor = 'ns-resize';
      return;
    }
    if (
      e.shiftKey &&
      lastLayout &&
      mx >= lastLayout.pL &&
      mx <= lastLayout.xRight &&
      my > otop + 4 &&
      my < lastLayout.ohlcBottom - 4
    ) {
      priceZoomDrag = { sy: e.clientY, z0: priceYZoom };
      e.preventDefault();
      cv.style.cursor = 'ns-resize';
      return;
    }
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
  if (priceZoomDrag) {
    const dy = e.clientY - priceZoomDrag.sy;
    let z = priceZoomDrag.z0 * Math.exp(dy * PRICE_ZOOM_SENS);
    priceYZoom = Math.max(PRICE_Y_ZOOM_MIN, Math.min(PRICE_Y_ZOOM_MAX, z));
    scheduleRedraw();
  } else if (resizeDrag) {
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
  if (!isDrag && !resizeDrag && !plotShiftDrag && !priceZoomDrag) {
    const my = e.clientY - r.top;
    const onPriceRuler =
      lastLayout &&
      mouseX > lastLayout.xRight &&
      mouseX <= r.width &&
      my > (lastLayout.ohlcTop ?? pT) + 4 &&
      my < lastLayout.ohlcBottom - 4;
    const mlOhlcTop = lastLayout?.ohlcTop ?? pT;
    const mlNear =
      ind.mirrorly &&
      lastLayout?.pL != null &&
      mouseX >= lastLayout.pL &&
      mouseX <= lastLayout.xRight &&
      my >= mlOhlcTop + 2 &&
      my <= lastLayout.ohlcBottom - 2 &&
      pickMirrorlyHit(mouseX, mouseY, mirrorlyHits);
    const nhNear =
      ind.headlines &&
      lastLayout?.pL != null &&
      mouseX >= lastLayout.pL &&
      mouseX <= lastLayout.xRight &&
      my >= mlOhlcTop + 2 &&
      my <= lastLayout.ohlcBottom - 2 &&
      pickNewsHit(mouseX, my, ind.headlines, lastLayout);
    if (lastLayout?.subsLen) {
      if (Math.abs(my - lastLayout.ohlcBottom) < 6) cv.style.cursor = 'ns-resize';
      else if (lastLayout.panelDividers.some((y) => Math.abs(my - y) < 5)) cv.style.cursor = 'ns-resize';
      else if (mlNear || nhNear) cv.style.cursor = 'pointer';
      else if (annotDrawOn) cv.style.cursor = 'crosshair';
      else if (onPriceRuler) cv.style.cursor = 'ns-resize';
      else if (
        e.shiftKey &&
        my > (lastLayout.ohlcTop ?? pT) + 4 &&
        my < lastLayout.ohlcBottom - 4 &&
        mouseX >= lastLayout.pL &&
        mouseX <= lastLayout.xRight
      )
        cv.style.cursor = 'ns-resize';
      else if (my < lastLayout.ohlcBottom - 4)
        cv.style.cursor = e.altKey || e.metaKey ? 'grab' : 'crosshair';
      else cv.style.cursor = annotDrawOn ? 'crosshair' : 'default';
    } else if (mlNear || nhNear) cv.style.cursor = 'pointer';
    else if (onPriceRuler) cv.style.cursor = 'ns-resize';
    else if (
      lastLayout &&
      e.shiftKey &&
      my > (lastLayout.ohlcTop ?? pT) + 4 &&
      my < lastLayout.ohlcBottom - 4 &&
      mouseX >= lastLayout.pL &&
      mouseX <= lastLayout.xRight
    )
      cv.style.cursor = 'ns-resize';
    else cv.style.cursor = annotDrawOn ? 'crosshair' : e.altKey || e.metaKey ? 'grab' : 'crosshair';
  }

  if (ind.mirrorly && lastLayout?.pL != null) {
    const my2 = mouseY;
    const otop = lastLayout.ohlcTop ?? pT;
    const overOhlc =
      mouseX >= lastLayout.pL &&
      mouseX <= lastLayout.xRight &&
      my2 >= otop + 2 &&
      my2 <= lastLayout.ohlcBottom - 2;
    const overTip = e.target?.closest?.('#mirrorly-tip');
    const overNewsTip = e.target?.closest?.('#news-tip');
    const mh =
      overOhlc && !isDrag && !resizeDrag && !plotShiftDrag && !priceZoomDrag
        ? pickMirrorlyHit(mouseX, mouseY, mirrorlyHits)
        : null;
    const nh =
      ind.headlines && overOhlc && !isDrag && !resizeDrag && !plotShiftDrag && !priceZoomDrag && !mh
        ? pickNewsHit(mouseX, my2, ind.headlines, lastLayout)
        : null;
    if (!mirrorlyTipPinned) {
      if (overTip) {
        /* keep tooltip for link hover */
      } else if (overNewsTip) {
        hideMirrorlyTip();
      } else if (mh) {
        if (!newsTipPinned) hideNewsTip();
        showMirrorlyTip(mh.row, mh.kind, e.clientX, e.clientY);
      } else if (nh) {
        hideMirrorlyTip();
        if (!newsTipPinned) showNewsTip(nh.title, nh.url, nh.macro, e.clientX, e.clientY);
      } else {
        hideMirrorlyTip();
        if (!newsTipPinned) hideNewsTip();
      }
    }
  } else {
    mirrorlyTipPinned = false;
    mirrorlyTipPinnedKey = '';
    if (!e.target?.closest?.('#mirrorly-tip')) hideMirrorlyTip();
    if (ind.headlines && lastLayout?.pL != null) {
      const my3 = mouseY;
      const otop = lastLayout.ohlcTop ?? pT;
      const overOhlc =
        mouseX >= lastLayout.pL &&
        mouseX <= lastLayout.xRight &&
        my3 >= otop + 2 &&
        my3 <= lastLayout.ohlcBottom - 2;
      const overNewsTip = e.target?.closest?.('#news-tip');
      if (overOhlc && !isDrag && !resizeDrag && !plotShiftDrag && !priceZoomDrag) {
        const nh = pickNewsHit(mouseX, my3, ind.headlines, lastLayout);
        if (overNewsTip) {
          /* keep */
        } else if (nh) {
          if (!newsTipPinned) showNewsTip(nh.title, nh.url, nh.macro, e.clientX, e.clientY);
        } else if (!newsTipPinned) hideNewsTip();
      } else if (!overNewsTip && !newsTipPinned) hideNewsTip();
    } else if (!e.target?.closest?.('#news-tip') && !newsTipPinned) hideNewsTip();
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
  if (resizeDrag || isDrag || plotShiftDrag || priceZoomDrag || annotDrawing) scheduleRedraw();
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
  if (resizeDrag) scheduleSaveUiConfig();
  if (resizeDrag || isDrag || plotShiftDrag || priceZoomDrag) scheduleRedraw();
  if (resizeDrag) resizeDrag = null;
  if (priceZoomDrag) {
    priceZoomDrag = null;
    scheduleSaveUiConfig();
    cv.style.cursor = 'crosshair';
  }
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
  priceYZoom = 1;
  newsTipPinned = false;
  newsTipPinnedKey = '';
  hideNewsTip();
  syncVisLabel();
  updSB();
  invalidateOISlice();
  scheduleSaveUiConfig();
  scheduleRedraw();
});
cv.addEventListener('mouseleave', () => {
  showXH = false;
  prevShowXH = false;
  if (!mirrorlyTipPinned) hideMirrorlyTip();
  if (!newsTipPinned) hideNewsTip();
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

function draw() {
  ctx.fillStyle = chartTheme.bg;
  ctx.fillRect(0, 0, W, H);
  const ext1m = ext1mSeries();
  const all = displayAllFromExt(ext1m);
  if (!all.length) {
    ctx.fillStyle = chartTheme.loading;
    ctx.font = "500 12px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = 'center';
    const wsOpen = ws && ws.readyState === 1;
    let msg;
    if (!chartHistoryLoaded) msg = 'Loading history…';
    else if (!wsOpen) msg = 'Connecting WebSocket…';
    else msg = 'No history from API — waiting for live bars';
    ctx.fillText(msg, W / 2, H / 2);
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

  scheduleTapeWallsFetch(shown);

  let oiPanelHud = null;

  if (ind.osc || ind.rev || ind.vrng) ensureOscDerived(all, tf);

  const oiFull1m = getOIFull1m(ext1m);
  const oiData = tf <= 60 ? getOI(shown) : getOIDisplayTf(shown, ext1m);
  const xRight = W - pR - CHART_PAD_R;
  /** Clip width for stacked indicators: includes right gutter so drawLine hi/lo labels survive clipping. */
  const indClipW = W - pL - 2;

  let hi = -Infinity;
  let lo = Infinity;
  for (const c of shown) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
  }
  const rn = hi - lo || hi * 0.001 || 1;
  const mg = rn * 0.05 * priceYZoom;
  hi += mg;
  lo -= mg;
  const pRn = hi - lo;
  const cW = xRight - pL;
  const cw = cW / v;
  const bW = Math.max(1, Math.min(cw * 0.78, 15.5));
  const wkW = Math.max(1.2, Math.min(bW * 0.19, 2.35));
  const toX = (i) => pL + i * cw + cw / 2 + plotShiftX;
  const toY = (p) => pT + (1 - (p - lo) / pRn) * ohlcH;

  drawHorizontalGridBands(ctx, pL, xRight, pT, ohlcH, 4);
  for (let i = 0; i <= 4; i++) {
    const y = pT + (i / 4) * ohlcH;
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(pL, pT, xRight - pL, ohlcH);
  ctx.clip();

  if (ind.volume && ohlcH > 24) {
    let mx = 0;
    for (const c of shown) mx = Math.max(mx, c.v || 0);
    if (mx > 0) {
      const volDepth = Math.min(Math.max(ohlcH * 0.24, 10), ohlcH * 0.4);
      ctx.save();
      ctx.globalAlpha = 0.38;
      for (let i = 0; i < shown.length; i++) {
        const c = shown[i];
        const x = toX(i);
        const vv = c.v || 0;
        const volH = (vv / mx) * volDepth;
        ctx.fillStyle = c.c >= c.o ? chartTheme.volBarBull : chartTheme.volBarBear;
        ctx.fillRect(x - bW / 2, pT + ohlcH - volH, bW, volH);
      }
      ctx.restore();
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

  newsHits.length = 0;
  if (ind.headlines && newsItems.length) {
    ctx.strokeStyle = chartTheme.newsLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    const yTickTop = pT + 2;
    const yBotLn = pT + ohlcH - 2;
    const barMs = tf * 1000;
    const lastT = shown[shown.length - 1].t;
    const tLo = shown[0].t - barMs * TIME_X_EXTRAP_BARS;
    /** Wall-clock ceiling so Telegram “now” is not dropped when the last bar open lags real time. */
    const tHi = Math.max(lastT + barMs * TIME_X_EXTRAP_BARS, Date.now() + 60_000);
    for (const it of newsItems) {
      const tMs = Number(it.t);
      if (!Number.isFinite(tMs) || tMs < tLo || tMs > tHi) continue;
      const title = typeof it.title === 'string' ? it.title : '';
      if (!title) continue;
      const xU = mirrorlyXAt(tf, shown, tMs, toX, cw);
      if (xU == null) continue;
      const x = Math.max(pL, Math.min(xRight, xU));
      ctx.beginPath();
      ctx.moveTo(x, yTickTop);
      ctx.lineTo(x, yBotLn);
      ctx.stroke();
      ctx.fillStyle = chartTheme.newsTick;
      ctx.beginPath();
      ctx.moveTo(x - 3, yTickTop);
      ctx.lineTo(x + 3, yTickTop);
      ctx.lineTo(x, yTickTop + 5);
      ctx.closePath();
      ctx.fill();
      const url = typeof it.url === 'string' ? it.url : '';
      newsHits.push({
        t: tMs,
        x,
        title,
        url: url || undefined,
        macro: !!it.macro,
        msgId: it.msgId,
      });
    }
    ctx.setLineDash([]);
  }

  if (ind.mirrorly && mirrorlyRows.length) {
    mirrorlyHits.length = 0;
    const cw = (xRight - pL) / Math.max(1, v);
    const xFor = (tMs) => mirrorlyXAt(tf, shown, tMs, toX, cw);
    const MR = 12;
    const bubGap = 5;
    const yClampM = (y) => Math.max(pT + MR + 5, Math.min(pT + ohlcH - MR - 5, y));
    ctx.save();
    ctx.globalAlpha = 0.62;
    for (const row of mirrorlyRows) {
      const sideTint = row.side === 'short' ? chartTheme.mirrorlyShort : chartTheme.mirrorlyLong;
      const openMs = Date.parse(row.opened);
      if (Number.isNaN(openMs)) continue;
      const xO = xFor(openMs);
      if (xO == null || xO < pL || xO > xRight) continue;
      const barE = mirrorlyBarForTime(tf, shown, openMs);
      const yPriceE = toY(row.entryPrice);
      const yLowE = barE ? toY(barE.l) : yPriceE;
      const yE = yClampM(yLowE + MR + bubGap + mirrorlySidJit(row.positionId, 'en') * 0.35);
      ctx.strokeStyle = chartTheme.mirrorlyStem;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xO, yE);
      ctx.lineTo(xO, yClampM(yLowE));
      ctx.stroke();
      drawMirrorlyExchangeDisc(ctx, xO, yE, row.exchangeRef, sideTint, false, MR);
      mirrorlyHits.push({ cx: xO, cy: yE, row, kind: 'entry' });

      if (row.closed) {
        const closeMs = Date.parse(row.closed);
        if (!Number.isNaN(closeMs)) {
          const xC = xFor(closeMs);
          if (xC != null && xC >= pL && xC <= xRight) {
            const pxC = mirrorlyPriceAtTime(shown, closeMs);
            const yPriceX = pxC != null ? toY(pxC) : yPriceE;
            const barX = mirrorlyBarForTime(tf, shown, closeMs);
            const yLowX = barX ? toY(barX.l) : yPriceX;
            let yX = yClampM(yLowX + MR + bubGap + mirrorlySidJit(row.positionId, 'ex') * 0.35);
            if (Math.abs(xO - xC) < 22 && Math.abs(yE - yX) < 12) yX = yClampM(yX + 14);
            ctx.strokeStyle = chartTheme.mirrorlyStem;
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(xC, yX);
            ctx.lineTo(xC, yClampM(yLowX));
            ctx.stroke();
            ctx.setLineDash([]);
            drawMirrorlyExchangeDisc(ctx, xC, yX, row.exchangeRef, chartTheme.mirrorlyExit, true, MR);
            mirrorlyHits.push({ cx: xC, cy: yX, row, kind: 'exit' });
          }
        }
      }
    }
    ctx.restore();
  } else {
    mirrorlyHits.length = 0;
  }

  if (ind.obwalls && tapeWallsSegments.length) {
    const barMs = tf * 1000;
    const cwBar = (xRight - pL) / Math.max(1, v);
    ctx.save();
    ctx.lineCap = 'round';
    for (const seg of tapeWallsSegments) {
      if (
        seg.t1 < shown[0].t - barMs * TIME_X_EXTRAP_BARS ||
        seg.t0 > shown[shown.length - 1].t + barMs * TIME_X_EXTRAP_BARS
      )
        continue;
      const y = toY(seg.price);
      if (y < pT - 4 || y > pT + ohlcH + 4) continue;
      const tA = Math.max(seg.t0, shown[0].t);
      const tB = Math.min(seg.t1, shown[shown.length - 1].t + barMs);
      let x0 = mirrorlyXAt(tf, shown, tA, toX, cwBar);
      let x1 = mirrorlyXAt(tf, shown, tB, toX, cwBar);
      if (x0 == null) x0 = pL;
      if (x1 == null) x1 = xRight;
      x0 = Math.max(pL, Math.min(xRight, x0));
      x1 = Math.max(pL, Math.min(xRight, x1));
      if (x1 <= x0 + 0.25) continue;
      ctx.strokeStyle = seg.side === 'bid' ? chartTheme.wallBid : chartTheme.wallAsk;
      ctx.lineWidth = 1.85;
      ctx.globalAlpha = 0.76;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.restore();

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

      ctx.save();
      ctx.beginPath();
      ctx.rect(pL, dT, indClipW, pH);
      ctx.clip();

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
      ctx.restore();
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
      ctx.save();
      ctx.beginPath();
      ctx.rect(pL, dT, indClipW, pH);
      ctx.clip();
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
      ctx.restore();
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
      ctx.save();
      ctx.beginPath();
      ctx.rect(pL, dT, indClipW, pH);
      ctx.clip();
      drawOscPanel(ctx, oscVals, p95Vals, dT, pH, pL, xRight, toX);
      ctx.restore();
    }

    py += rowH + gap;
    if (idx < subs.length - 1) panelDividersY.push(py - gap / 2);
  }

  lastLayout = {
    ohlcTop: pT,
    ohlcBottom: pT + ohlcH,
    pL,
    xRight,
    priceOhlcH: ohlcH,
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

function chartFetchHours() {
  return loadedHours + Math.ceil((1000 * 60) / 3600);
}

async function fetchChartPayload() {
  const pv = ind.split ? '1' : '0';
  const res = await fetch(
    `/api/chart?symbol=${encodeURIComponent(sym)}&tf=60&hours=${chartFetchHours()}&perVenueOi=${pv}`,
  );
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** Re-pull Velo bars + OI while staying on the same symbol (WS only updates price; OI/net L−S go stale without this). */
async function refreshChartSilent() {
  if (document.visibilityState !== 'visible') return;
  try {
    const data = await fetchChartPayload();
    bars1m = data.bars || [];
    oiRaw = data.oiByEx || {};
    if (bars1m.length > 0) lastP = bars1m[bars1m.length - 1].c;
    invalidateOICaches();
    if (lastP != null) patchSidebarLivePrice(sym, lastP);
    updSB();
    scheduleRedraw();
  } catch (e) {
    console.warn('chart refresh', e);
  }
}

function ensureLiveWs() {
  if (document.visibilityState !== 'visible') return;
  if (!ws || ws.readyState === WebSocket.CLOSED) connectWS();
}

async function loadChart() {
  chartHistoryLoaded = false;
  scheduleRedraw();
  try {
    const data = await fetchChartPayload();
    bars1m = data.bars || [];
    oiRaw = data.oiByEx || {};
    if (bars1m.length > 0) lastP = bars1m[bars1m.length - 1].c;
    invalidateOICaches();
  } catch (e) {
    console.error(e);
  } finally {
    chartHistoryLoaded = true;
  }
  if (bars1m.length > 0 && lastP != null) patchSidebarLivePrice(sym, lastP);
  updSB();
  scheduleRedraw();
}

async function loadMore() {
  try {
    const data = await fetchChartPayload();
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
    invalidateOICaches();
    if (lastP != null) patchSidebarLivePrice(sym, lastP);
  } catch (e) {
    console.error(e);
  }
  updSB();
  scheduleRedraw();
  scheduleSaveUiConfig();
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
  mirrorlyTipPinned = false;
  mirrorlyTipPinnedKey = '';
  hideMirrorlyTip();
  newsTipPinned = false;
  newsTipPinnedKey = '';
  hideNewsTip();
  tapeWallsLoadedKey = '';
  tapeWallsSegments = [];
  tapeWallsFetchGen++;
  if (tapeWallsDeb) {
    clearTimeout(tapeWallsDeb);
    tapeWallsDeb = null;
  }
  priceYZoom = 1;
  priceZoomDrag = null;
  $pl.textContent = s.replace('USDT', '/USDT');
  document.title = DOC_TITLE_PAIR($pl.textContent);
  hlT(s);
  resub();
  await loadChart();
  if (ind.mirrorly) void refreshMirrorly();
  updSB();
  scheduleSaveUiConfig();
}

let tickers = [];
let tF = '';
let tSort = 'vol';

const UI_CONFIG_KEY = 'heatrip-ui-v1';

function saveUiConfig() {
  try {
    const payload = {
      ind: { ...ind },
      exOn: [...exOn].sort(),
      tf,
      sym,
      vis,
      targetVis,
      ohlcFrac,
      priceYZoom,
      panelFracs: [...panelFracs],
      tSort,
      tF,
      loadedHours: Math.min(72, Math.max(1, loadedHours | 0)),
    };
    localStorage.setItem(UI_CONFIG_KEY, JSON.stringify(payload));
  } catch (_e) {
    /* quota / private mode */
  }
}

let saveUiTimer = null;
function scheduleSaveUiConfig() {
  if (saveUiTimer) clearTimeout(saveUiTimer);
  saveUiTimer = setTimeout(() => {
    saveUiTimer = null;
    saveUiConfig();
  }, 200);
}

function loadUiConfig() {
  try {
    const raw = localStorage.getItem(UI_CONFIG_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object') return;
    if (c.ind && typeof c.ind === 'object') {
      for (const key of Object.keys(ind)) {
        if (typeof c.ind[key] === 'boolean') ind[key] = c.ind[key];
      }
    }
    if (Array.isArray(c.exOn) && c.exOn.length > 0) {
      const next = new Set();
      for (const x of c.exOn) {
        if (KNOWN_EX.includes(x)) next.add(x);
      }
      if (next.size > 0) {
        exOn.clear();
        for (const x of next) exOn.add(x);
      }
    }
    if (c.tf === 60 || c.tf === 300) tf = c.tf;
    if (typeof c.sym === 'string' && /^[A-Z0-9]{2,20}USDT$/i.test(c.sym)) sym = c.sym.toUpperCase();
    if (typeof c.vis === 'number' && c.vis >= 10 && c.vis <= MAX_BARS) {
      vis = c.vis | 0;
      targetVis =
        typeof c.targetVis === 'number'
          ? Math.min(MAX_BARS, Math.max(10, c.targetVis | 0))
          : vis;
    }
    if (
      typeof c.ohlcFrac === 'number' &&
      c.ohlcFrac >= OHLC_FRAC_MIN &&
      c.ohlcFrac <= OHLC_FRAC_MAX
    )
      ohlcFrac = c.ohlcFrac;
    if (
      typeof c.priceYZoom === 'number' &&
      Number.isFinite(c.priceYZoom) &&
      c.priceYZoom >= PRICE_Y_ZOOM_MIN &&
      c.priceYZoom <= PRICE_Y_ZOOM_MAX
    )
      priceYZoom = c.priceYZoom;
    if (Array.isArray(c.panelFracs)) {
      const ok = c.panelFracs.filter((n) => typeof n === 'number' && n > 0 && Number.isFinite(n));
      if (ok.length > 0) panelFracs = ok;
    }
    if (c.tSort === 'vol' || c.tSort === 'chg' || c.tSort === 'alpha') tSort = c.tSort;
    if (typeof c.tF === 'string' && c.tF.length <= 160) tF = c.tF;
    if (typeof c.loadedHours === 'number' && c.loadedHours >= 1 && c.loadedHours <= 72)
      loadedHours = Math.floor(c.loadedHours);
    if (ind.split) {
      exOn.delete('deribit');
    }
  } catch (_e) {
    /* corrupt */
  }
}

function syncToolbarFromState() {
  document.querySelectorAll('input[data-ind]').forEach((inp) => {
    const k = inp.dataset.ind;
    if (ind[k] !== undefined) inp.checked = !!ind[k];
  });
  document.querySelectorAll('[data-ex]').forEach((b) => b.classList.toggle('on', exOn.has(b.dataset.ex)));
  document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', Number(b.dataset.tf) === tf));
  const sortRoot = document.getElementById('sort-exg');
  if (sortRoot) {
    sortRoot.querySelectorAll('[data-tsort]').forEach((b) =>
      b.classList.toggle('on', b.dataset.tsort === tSort),
    );
  }
  const si = document.getElementById('si');
  if (si) si.value = tF;
  if ($pl) {
    $pl.textContent = sym.replace('USDT', '/USDT');
    document.title = DOC_TITLE_PAIR($pl.textContent);
  }
  syncVisLabel();
}
async function fetchT() {
  try {
    const r = await fetch('/api/tickers', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('tickers');
    tickers = j;
    renT();
  } catch (e) {}
}
function orderedFl(list) {
  const a = [...list];
  if (tSort === 'alpha') a.sort((x, y) => x.symbol.localeCompare(y.symbol));
  else if (tSort === 'chg')
    a.sort((x, y) => parseFloat(y.priceChangePercent) - parseFloat(x.priceChangePercent));
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
    h += `<div class="ti-row ${a}" data-sym="${t.symbol}" title="${t.symbol}"><span class="ti-sym">${t.symbol.replace('USDT', '')}</span><span class="ti-price">${fP(parseFloat(t.lastPrice))}</span><span class="ti-ch" style="color:${col}">${s}${ch.toFixed(2)}%</span></div>`;
  }
  $tl.innerHTML = h;
  // List rebuild uses Binance snapshot; chart lastP from Velo WS is fresher for the open symbol.
  if (sym && lastP != null && Number.isFinite(Number(lastP))) patchSidebarLivePrice(sym, lastP);
}

/** Keep sidebar row in sync with live trades / forming bar for the active chart symbol. */
function patchSidebarLivePrice(symbol, price) {
  if (!symbol || price == null || !Number.isFinite(Number(price))) return;
  const n = Number(price);
  const t = tickers.find((x) => x.symbol === symbol);
  if (t) t.lastPrice = String(n);
  const row = $tl?.querySelector(`.ti-row[data-sym="${symbol}"]`);
  const prEl = row?.querySelector('.ti-price');
  if (prEl) prEl.textContent = fP(n);
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
  scheduleSaveUiConfig();
  renT();
});

const $sortExg = $('sort-exg');
$sortExg?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tsort]');
  if (!b) return;
  tSort = b.dataset.tsort;
  $sortExg.querySelectorAll('[data-tsort]').forEach((x) => x.classList.toggle('on', x === b));
  scheduleSaveUiConfig();
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

const CHART_COPY_TITLE = 'Copy chart as PNG to clipboard';
const $chartCopy = $('chart-copy');
$chartCopy?.addEventListener('click', async () => {
  let blob;
  try {
    blob = await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png', 1);
    });
  } catch (e) {
    console.error(e);
    $chartCopy.title = 'Could not create PNG';
    setTimeout(() => {
      $chartCopy.title = CHART_COPY_TITLE;
    }, 2200);
    return;
  }
  const png =
    blob.type === 'image/png'
      ? blob
      : new Blob([await blob.arrayBuffer()], { type: 'image/png' });

  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('clipboard unsupported');
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': Promise.resolve(png),
      }),
    ]);
    $chartCopy.title = 'Copied PNG';
    setTimeout(() => {
      $chartCopy.title = CHART_COPY_TITLE;
    }, 1600);
  } catch (e) {
    console.warn('clipboard:', e);
    $chartCopy.title = 'Clipboard blocked';
    setTimeout(() => {
      $chartCopy.title = CHART_COPY_TITLE;
    }, 2200);
  }
});

(async () => {
  initTheme();
  loadUiConfig();
  syncToolbarFromState();
  $('theme-toggle')?.addEventListener('click', toggleTheme);
  $('tf-exg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]');
    if (!b) return;
    setTf(Number(b.dataset.tf));
  });
  connectWS();
  await Promise.all([loadExchangeLogoManifest(), fetchT(), loadChart()]);
  updSB();
  scheduleRedraw();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void fetchT();
  }, 2000);
  setInterval(refreshChartSilent, 180_000);
  setInterval(() => {
    if (ind.mirrorly) void refreshMirrorly();
  }, 45_000);
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (ind.headlines) void fetchNews(ind.headlines);
  }, 120_000);
  if (ind.headlines) void fetchNews(ind.headlines);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void fetchT();
    if (ind.headlines) void fetchNews(ind.headlines);
    refreshChartSilent();
    ensureLiveWs();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      void fetchT();
      refreshChartSilent();
      ensureLiveWs();
    }
  });
})();
