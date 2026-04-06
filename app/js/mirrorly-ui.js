import { chartTheme } from './chart-theme.js';
import { fP, fSignedN } from './format.js';

let mirrorlyRedraw = () => {};

/** Wire canvas redraw (called once from main after scheduleRedraw exists). */
export function registerMirrorlyRedraw(fn) {
  mirrorlyRedraw = fn;
}

let exchangeLogoManifest = null;
let exchangeLogoManifestPromise = null;

export function loadExchangeLogoManifest() {
  if (exchangeLogoManifest) return Promise.resolve(exchangeLogoManifest);
  if (!exchangeLogoManifestPromise) {
    exchangeLogoManifestPromise = fetch('/exchange-logos/manifest.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((j) => {
        exchangeLogoManifest = j && typeof j === 'object' ? j : {};
        mirrorlyRedraw();
        return exchangeLogoManifest;
      })
      .catch(() => {
        exchangeLogoManifest = {};
        return exchangeLogoManifest;
      });
  }
  return exchangeLogoManifestPromise;
}

export function mirrorlyExAbbrev(ref) {
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

export function mirrorlyExchangeSlug(ref) {
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
    img.onload = () => mirrorlyRedraw();
    img.onerror = () => {
      mirrorlyLogoImgCache.set(slug, 'err');
      mirrorlyRedraw();
    };
    img.src = url;
    mirrorlyLogoImgCache.set(slug, img);
    return null;
  }
  return null;
}

export function mirrorlyExchangeBrand(ref) {
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
export function drawMirrorlyExchangeDisc(ctx, cx, cy, exchangeRef, sideTint, isExit, R) {
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

export function mirrorlySidJit(key, salt) {
  let h = 0;
  const s = String(key) + String(salt);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (Math.abs(h) % 6) * 2;
}

export function pickMirrorlyHit(mx, my, hits) {
  const rad = 18;
  let best = null;
  let bestD = rad;
  for (const h of hits) {
    const d = Math.hypot(mx - h.cx, my - h.cy);
    if (d <= bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

export function mirrorlyHitKey(h) {
  if (!h?.row) return '';
  return `${h.row.positionId || ''}:${h.kind}`;
}

export function mirrorlyTipEl() {
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

export function showMirrorlyTip(row, kind, clientX, clientY) {
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
  pnlRow.className =
    'mirrorly-tip-pnl ' +
    (pnlOk && Number(pnlN) > 0 ? 'mirrorly-tip-pnl-pos' : pnlOk && Number(pnlN) < 0 ? 'mirrorly-tip-pnl-neg' : '');
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

export function hideMirrorlyTip() {
  const tip = mirrorlyTipEl();
  if (tip) tip.hidden = true;
}
