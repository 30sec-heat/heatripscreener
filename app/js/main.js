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

const V_GRID_DIVS = 8;

function drawVerticalGrid(ctx, pL, xRight, yTop, yBot) {
  for (let g = 1; g < V_GRID_DIVS; g++) {
    const gx = pL + (g / V_GRID_DIVS) * (xRight - pL);
    const strong = g % 2 === 0;
    ctx.strokeStyle = strong ? chartTheme.grid : chartTheme.gridMinor;
    ctx.lineWidth = strong ? 1 : 0.55;
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
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(xRight, y);
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const y = yTop + ((i + 0.5) / n) * height;
    ctx.strokeStyle = chartTheme.gridMinor;
    ctx.lineWidth = 0.55;
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
  mirrorly: false,
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

function invalidateOscDerived() {
  oscCache.k = '';
}

function invalidateOICaches() {
  invalidateOISlice();
  invalidateOscDerived();
}

document.querySelectorAll('input[data-ind]').forEach((inp) => {
  inp.addEventListener('change', () => {
    const kk = inp.dataset.ind;
    ind[kk] = inp.checked;
    if (kk === 'mirrorly') {
      if (ind.mirrorly) void refreshMirrorly();
      else {
        mirrorlyRows = [];
        hideMirrorlyTip();
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
/** Mirrorly overlay rows from GET /api/mirrorly (server-side aggregated). */
let mirrorlyRows = [];
/** Hit targets for hover: filled in draw() when Mirrorly is on. Canvas coords. */
let mirrorlyHits = [];
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

/** Map wall time to x in the visible slice (bar-open alignment + extrapolate past last close). */
function mirrorlyXAt(shown, tMs, toX, cw) {
  if (!shown.length || tMs == null || Number.isNaN(tMs)) return null;
  if (tMs < shown[0].t) return null;
  const last = shown[shown.length - 1];
  const barMs = tf * 1000;
  for (let i = 0; i < shown.length - 1; i++) {
    if (shown[i].t <= tMs && tMs < shown[i + 1].t) {
      const den = shown[i + 1].t - shown[i].t || 1;
      const frac = (tMs - shown[i].t) / den;
      return toX(i) + frac * (toX(i + 1) - toX(i));
    }
  }
  if (tMs >= last.t) {
    const frac = Math.min(2.5, (tMs - last.t) / barMs);
    return toX(shown.length - 1) + frac * cw;
  }
  return toX(shown.length - 1);
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

function mirrorlyExAbbrev(ref) {
  if (!ref) return '—';
  const k = ref.replace(/\s+/g, '').toLowerCase();
  const map = {
    hyperliquid: 'HL',
    bybit: 'By',
    binance: 'BN',
    okx: 'OK',
    deribit: 'Dr',
    bitget: 'BG',
    blofin: 'Bl',
  };
  if (map[k]) return map[k];
  const alnum = ref.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum.length >= 2) return alnum.slice(0, 2).toUpperCase();
  return ref.slice(0, 2).toUpperCase();
}

function mirrorlyPriceAtTime(shown, tMs) {
  if (!shown.length) return null;
  if (tMs < shown[0].t) return shown[0].c;
  for (let i = 0; i < shown.length - 1; i++) {
    if (shown[i].t <= tMs && tMs < shown[i + 1].t) return shown[i].c;
  }
  return shown[shown.length - 1].c;
}

/** Candle whose interval contains tMs (for anchoring markers below the wick low). */
function mirrorlyBarForTime(shown, tMs) {
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

let exchangeLogoManifest = null;
let exchangeLogoManifestPromise = null;

function loadExchangeLogoManifest() {
  if (exchangeLogoManifest) return Promise.resolve(exchangeLogoManifest);
  if (!exchangeLogoManifestPromise) {
    exchangeLogoManifestPromise = fetch('/exchange-logos/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        exchangeLogoManifest = j && typeof j === 'object' ? j : {};
        scheduleRedraw();
        return exchangeLogoManifest;
      })
      .catch(() => {
        exchangeLogoManifest = {};
        return exchangeLogoManifest;
      });
  }
  return exchangeLogoManifestPromise;
}

function mirrorlyExchangeSlug(ref) {
  const raw = String(ref || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const table = {
    binance: 'binance',
    binancefutures: 'binance',
    binanceus: 'binance',
    hyperliquid: 'hyperliquid',
    hl: 'hyperliquid',
    bybit: 'bybit',
    okx: 'okx',
    okex: 'okx',
    deribit: 'deribit',
    bitget: 'bitget',
    blofin: 'blofin',
    gate: 'gate',
    gateio: 'gate',
    mexc: 'mexc',
    kucoin: 'kucoin',
    coinbase: 'coinbase',
    kraken: 'kraken',
  };
  if (table[raw]) return table[raw];
  if (raw.includes('binance')) return 'binance';
  if (raw.includes('hyperliquid')) return 'hyperliquid';
  if (raw.includes('bybit')) return 'bybit';
  if (raw.includes('okx') || raw.includes('okex')) return 'okx';
  if (raw.includes('deribit')) return 'deribit';
  if (raw.includes('bitget')) return 'bitget';
  if (raw.includes('gate')) return 'gate';
  if (raw.includes('mexc')) return 'mexc';
  if (raw.includes('kucoin')) return 'kucoin';
  if (raw.includes('blofin')) return 'blofin';
  const slug = raw.replace(/[^a-z0-9]/g, '');
  return slug || 'unknown';
}

function mirrorlyLogoUrlForSlug(slug) {
  if (!slug || slug === 'unknown') return null;
  const f = exchangeLogoManifest && exchangeLogoManifest[slug];
  return f ? `/exchange-logos/${f}` : null;
}

const mirrorlyLogoImgCache = new Map();

function getMirrorlyLogoImg(slug) {
  const url = mirrorlyLogoUrlForSlug(slug);
  if (!url) return null;
  let rec = mirrorlyLogoImgCache.get(slug);
  if (rec === 'err') return null;
  if (rec instanceof Image && rec.complete && rec.naturalWidth) return rec;
  if (!rec) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => scheduleRedraw();
    img.onerror = () => {
      mirrorlyLogoImgCache.set(slug, 'err');
      scheduleRedraw();
    };
    img.src = url;
    mirrorlyLogoImgCache.set(slug, img);
    return null;
  }
  return null;
}

function mirrorlyExchangeBrand(ref) {
  const slug = mirrorlyExchangeSlug(ref);
  const map = {
    hyperliquid: { bg: '#152028', fg: '#5eead4', ring: '#34d399' },
    bybit: { bg: '#26150c', fg: '#ffb020', ring: '#ff8a3d' },
    binance: { bg: '#221c08', fg: '#f0b90b', ring: '#e8c547' },
    okx: { bg: '#10161c', fg: '#e8eaed', ring: '#ffffff' },
    deribit: { bg: '#1a1530', fg: '#c4b5fd', ring: '#a78bfa' },
    bitget: { bg: '#140f22', fg: '#22d3ee', ring: '#06b6d4' },
    blofin: { bg: '#121820', fg: '#93c5fd', ring: '#60a5fa' },
    gate: { bg: '#141a22', fg: '#4fc3f7', ring: '#29b6f6' },
    mexc: { bg: '#162018', fg: '#7ee787', ring: '#47d96a' },
    kucoin: { bg: '#181420', fg: '#9fa8ff', ring: '#7c83ff' },
    coinbase: { bg: '#161420', fg: '#a78bfa', ring: '#8b5cf6' },
    kraken: { bg: '#121824', fg: '#7dd3fc', ring: '#38bdf8' },
  };
  const label = mirrorlyExAbbrev(ref);
  if (map[slug]) return { ...map[slug], label };
  return {
    bg: chartTheme.mirrorlyIconFallbackBg,
    fg: chartTheme.mirrorlyIconFallbackFg,
    ring: chartTheme.mirrorlyIconFallbackRing,
    label,
  };
}

/** Small exchange disc (~24px) + optional logo; opacity from caller ctx.globalAlpha. */
function drawMirrorlyExchangeDisc(ctx, cx, cy, exchangeRef, sideTint, isExit, R) {
  const slug = mirrorlyExchangeSlug(exchangeRef);
  const img = getMirrorlyLogoImg(slug);
  const brand = mirrorlyExchangeBrand(exchangeRef);
  const ringCol = isExit ? chartTheme.mirrorlyExit : sideTint || brand.ring;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = brand.bg;
  ctx.fill();
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R - 1.25), 0, Math.PI * 2);
    ctx.clip();
    const pad = 1.5;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.min((2 * (R - pad)) / iw, (2 * (R - pad)) / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = brand.fg;
    ctx.font = `800 ${Math.max(6, Math.round(R * 0.55))}px 'DM Sans', 'IBM Plex Mono', sans-serif`;
    ctx.fillText(brand.label, cx, cy + 0.5);
  }
  ctx.strokeStyle = ringCol;
  ctx.lineWidth = isExit ? 1.35 : 1.6;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  if (isExit) {
    ctx.setLineDash([3, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else ctx.stroke();
}

function mirrorlySidJit(key, salt) {
  let h = 0;
  const s = String(key) + String(salt);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 6) * 2;
}

function pickMirrorlyHit(mx, my) {
  const rad = 18;
  let best = null;
  let bestD = rad;
  for (const h of mirrorlyHits) {
    const d = Math.hypot(mx - h.cx, my - h.cy);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

function mirrorlyTipEl() {
  return document.getElementById('mirrorly-tip');
}

function mirrorlyFmtUsd(n) {
  const x = Number(n);
  if (n == null || !Number.isFinite(x) || x <= 0) return '—';
  if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e5) return '$' + (x / 1e3).toFixed(0) + 'K';
  if (x >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
  return '$' + x.toFixed(0);
}

function showMirrorlyTip(row, kind, clientX, clientY) {
  const tip = mirrorlyTipEl();
  if (!tip) return;
  tip.hidden = false;
  tip.replaceChildren();
  const notional = row.notionalUsd ?? row.positionSize;
  const brand = mirrorlyExchangeBrand(row.exchangeRef);

  const card = document.createElement('div');
  card.className = 'mirrorly-tip-card';

  const head = document.createElement('div');
  head.className = 'mirrorly-tip-head';
  const icon = document.createElement('div');
  icon.className = 'mirrorly-tip-exicon';
  icon.style.background = brand.bg;
  icon.style.color = brand.fg;
  icon.style.setProperty('--mirrorly-ring', brand.ring);
  const logoTip = mirrorlyLogoUrlForSlug(mirrorlyExchangeSlug(row.exchangeRef));
  if (logoTip) {
    const im = document.createElement('img');
    im.className = 'mirrorly-tip-exicon-img';
    im.src = logoTip;
    im.alt = '';
    icon.appendChild(im);
  } else icon.textContent = mirrorlyExAbbrev(row.exchangeRef);

  const headText = document.createElement('div');
  headText.className = 'mirrorly-tip-headtext';
  const nameEl = document.createElement('div');
  nameEl.className = 'mirrorly-tip-name';
  nameEl.textContent = row.name || 'Trader';
  const exEl = document.createElement('div');
  exEl.className = 'mirrorly-tip-exchange';
  exEl.textContent = row.exchangeRef ? `${row.exchangeRef} · ${row.symbol || ''}` : row.symbol || '';
  headText.append(nameEl, exEl);

  const sidePill = document.createElement('span');
  const short = row.side === 'short';
  sidePill.className = 'mirrorly-tip-side ' + (short ? 'mirrorly-tip-side-short' : 'mirrorly-tip-side-long');
  sidePill.textContent = short ? 'Short' : 'Long';
  head.append(icon, headText, sidePill);

  const mark = document.createElement('div');
  mark.className = 'mirrorly-tip-mark';
  mark.textContent = kind === 'exit' ? 'Exit marker' : 'Entry marker';

  const stats = document.createElement('dl');
  stats.className = 'mirrorly-tip-stats';

  const addStat = (label, value) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    stats.append(dt, dd);
  };

  const firstPx =
    row.firstEntryPrice != null && Number.isFinite(Number(row.firstEntryPrice))
      ? Number(row.firstEntryPrice)
      : null;
  const avgPx = row.entryPrice > 0 ? row.entryPrice : null;
  if (firstPx != null && avgPx != null && Math.abs(firstPx - avgPx) > avgPx * 1e-6) {
    addStat('First fill', fP(firstPx));
    addStat('Avg entry', fP(avgPx));
  } else if (avgPx != null) {
    addStat('Avg entry', fP(avgPx));
  } else if (firstPx != null) {
    addStat('Entry', fP(firstPx));
  }

  if (kind === 'exit') {
    const exP = row.exitPrice != null && Number.isFinite(Number(row.exitPrice)) ? Number(row.exitPrice) : null;
    if (exP != null) addStat('Exit price', fP(exP));
  }

  addStat('Notional (USD)', mirrorlyFmtUsd(notional));

  const open = !row.closed;
  const pnlN = open ? row.unrealizedPnl : row.realizedPnl;
  const pnlOk = pnlN != null && Number.isFinite(Number(pnlN));
  const pnlRow = document.createElement('div');
  pnlRow.className = 'mirrorly-tip-pnl ' + (pnlOk && Number(pnlN) > 0 ? 'mirrorly-tip-pnl-pos' : pnlOk && Number(pnlN) < 0 ? 'mirrorly-tip-pnl-neg' : '');
  const pnlLab = document.createElement('span');
  pnlLab.className = 'mirrorly-tip-pnl-label';
  pnlLab.textContent = open ? 'Open uPnL' : 'Realized PnL';
  const pnlVal = document.createElement('span');
  pnlVal.className = 'mirrorly-tip-pnl-val';
  pnlVal.textContent = pnlOk ? fSignedN(Number(pnlN)) : '—';
  pnlRow.append(pnlLab, pnlVal);

  const a = document.createElement('a');
  a.className = 'mirrorly-tip-link';
  a.href = row.profileUrl || 'https://portal.mirrorly.xyz/';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Mirrorly profile';

  card.append(head, mark, stats, pnlRow, a);
  tip.appendChild(card);

  const pad = 12;
  const tw = 340;
  let left = clientX + 16;
  let top = clientY + 16;
  left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - 280));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideMirrorlyTip() {
  const tip = mirrorlyTipEl();
  if (tip) tip.hidden = true;
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
      zoomVis(vis + dir * step * mag);
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
    const mlOhlcTop = lastLayout?.ohlcTop ?? pT;
    const mlNear =
      ind.mirrorly &&
      lastLayout?.pL != null &&
      mouseX >= lastLayout.pL &&
      mouseX <= lastLayout.xRight &&
      my >= mlOhlcTop + 2 &&
      my <= lastLayout.ohlcBottom - 2 &&
      pickMirrorlyHit(mouseX, mouseY);
    if (lastLayout?.subsLen) {
      if (Math.abs(my - lastLayout.ohlcBottom) < 6) cv.style.cursor = 'ns-resize';
      else if (lastLayout.panelDividers.some((y) => Math.abs(my - y) < 5)) cv.style.cursor = 'ns-resize';
      else if (mlNear) cv.style.cursor = 'pointer';
      else if (annotDrawOn) cv.style.cursor = 'crosshair';
      else if (my < lastLayout.ohlcBottom - 4)
        cv.style.cursor = e.altKey || e.metaKey ? 'grab' : 'crosshair';
      else cv.style.cursor = annotDrawOn ? 'crosshair' : 'default';
    } else if (mlNear) cv.style.cursor = 'pointer';
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
    const mh = overOhlc && !isDrag && !resizeDrag && !plotShiftDrag ? pickMirrorlyHit(mouseX, mouseY) : null;
    if (overTip) {
      /* keep tooltip for link hover */
    } else if (mh) showMirrorlyTip(mh.row, mh.kind, e.clientX, e.clientY);
    else hideMirrorlyTip();
  } else if (!e.target?.closest?.('#mirrorly-tip')) hideMirrorlyTip();
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
  if (resizeDrag) scheduleSaveUiConfig();
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
  scheduleSaveUiConfig();
  scheduleRedraw();
});
cv.addEventListener('mouseleave', () => {
  showXH = false;
  prevShowXH = false;
  hideMirrorlyTip();
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

  let oiPanelHud = null;

  if (ind.osc || ind.rev || ind.vrng) ensureOscDerived(all);

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
  const bW = Math.max(1, Math.min(cw * 0.78, 15.5));
  const wkW = Math.max(1.2, Math.min(bW * 0.19, 2.35));
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(pL, pT, xRight - pL, ohlcH);
  ctx.clip();

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

  if (ind.mirrorly && mirrorlyRows.length) {
    mirrorlyHits.length = 0;
    const cw = (xRight - pL) / Math.max(1, v);
    const xFor = (tMs) => mirrorlyXAt(shown, tMs, toX, cw);
    const MR = 12;
    const bubGap = 5;
    const yClampM = (y) => Math.max(pT + MR + 5, Math.min(pT + priceOhlcH - MR - 5, y));
    ctx.save();
    ctx.globalAlpha = 0.4;
    for (const row of mirrorlyRows) {
      const sideTint = row.side === 'short' ? chartTheme.mirrorlyShort : chartTheme.mirrorlyLong;
      const openMs = Date.parse(row.opened);
      if (Number.isNaN(openMs)) continue;
      const xO = xFor(openMs);
      if (xO == null || xO < pL || xO > xRight) continue;
      const barE = mirrorlyBarForTime(shown, openMs);
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
            const barX = mirrorlyBarForTime(shown, closeMs);
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
  setInterval(fetchT, 60_000);
  setInterval(refreshChartSilent, 180_000);
  setInterval(() => {
    if (ind.mirrorly) void refreshMirrorly();
  }, 45_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    refreshChartSilent();
    ensureLiveWs();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      refreshChartSilent();
      ensureLiveWs();
    }
  });
})();
