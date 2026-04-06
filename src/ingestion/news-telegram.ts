import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';
import { fetchVelo, type VeloBar } from '../shared/velo.js';

export type NewsItem = { t: number; title: string; url?: string; macro?: boolean };

const BTC_SYM = 'BTCUSDT';
const REACT_WINDOW_MIN = Math.max(1, Math.min(45, Number(process.env.NEWS_REACT_WINDOW_MIN) || 8));
/**
 * Relative gate: post-headline move must reach this quantile of *all* same-length
 * forward windows in recent BTC tape (adapts to vol regime). E.g. 0.87 ≈ top ~13%.
 * Override per-metric with NEWS_REACT_RANGE_Q / NEWS_REACT_NET_Q.
 */
const REACT_QUANTILE_SHARED = Number(process.env.NEWS_REACT_QUANTILE);
const REACT_RANGE_Q = Math.max(
  0.5,
  Math.min(0.995, Number(process.env.NEWS_REACT_RANGE_Q) || (Number.isFinite(REACT_QUANTILE_SHARED) ? REACT_QUANTILE_SHARED : 0.87)),
);
const REACT_NET_Q = Math.max(
  0.5,
  Math.min(0.995, Number(process.env.NEWS_REACT_NET_Q) || (Number.isFinite(REACT_QUANTILE_SHARED) ? REACT_QUANTILE_SHARED : 0.87)),
);
/** Hard floors (fraction of ref) when tape is dead or baseline sample is thin. */
const ABS_MIN_RANGE = Math.max(0, Math.min(0.05, Number(process.env.NEWS_REACT_ABS_MIN_RANGE) || 0.001));
const ABS_MIN_NET = Math.max(0, Math.min(0.05, Number(process.env.NEWS_REACT_ABS_MIN_NET) || 0.00065));
const BASELINE_MIN_WINDOWS = Math.max(24, Math.min(500, Number(process.env.NEWS_REACT_BASELINE_MIN_N) || 40));
const BTC_HISTORY_H = Math.max(24, Math.min(120, Number(process.env.NEWS_BTC_HISTORY_H) || 96));
const TG_POLL_MS = Math.max(30_000, Number(process.env.TELEGRAM_NEWS_POLL_MS) || 90_000);
/** Max headlines kept for /api/news and the chart (Telegram fetch targets this count). */
const HEADLINE_CAP = Math.max(20, Math.min(100, Number(process.env.TELEGRAM_NEWS_FETCH_LIMIT) || 50));

const DEFAULT_CHANNEL = '-1001263412188';

let cache: NewsItem[] = [];
let client: TelegramClient | null = null;
let warnedConfig = false;

function channelPeer() {
  const raw = (process.env.TELEGRAM_NEWS_CHANNEL_ID || DEFAULT_CHANNEL).trim();
  return bigInt(raw);
}

function readConfig(): { apiId: number; apiHash: string; session: string } | null {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  const session = process.env.TELEGRAM_SESSION_STRING?.trim();
  if (!apiId || !apiHash || !session) {
    if (!warnedConfig) {
      console.warn(
        '[news-tg] Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING (Railway secrets). Optional: TELEGRAM_NEWS_CHANNEL_ID',
      );
      warnedConfig = true;
    }
    return null;
  }
  return { apiId, apiHash, session };
}

function firstUrlFromMessage(text: string, entities?: Api.TypeMessageEntity[]): string | undefined {
  if (!text || !entities?.length) return undefined;
  for (const ent of entities) {
    if (ent instanceof Api.MessageEntityTextUrl) return ent.url;
    if (ent instanceof Api.MessageEntityUrl)
      return text.substring(ent.offset, ent.offset + ent.length);
  }
  return undefined;
}

/** Broad macro / geopolitical / rates bucket — reaction is always judged on BTC. */
function titleLooksMacro(title: string): boolean {
  const s = title.toLowerCase();
  const keys = [
    'iran',
    'israel',
    'gaza',
    'tehran',
    'jerusalem',
    'hamas',
    'hezbollah',
    'ukraine',
    'russia',
    'nato',
    'pentagon',
    'missile',
    'military',
    'war ',
    'war.',
    'ceasefire',
    'sanction',
    'nuclear',
    'opec',
    'brent',
    'crude',
    'oil price',
    'fed ',
    'fomc',
    'powell',
    'rate cut',
    'rate hike',
    'interest rate',
    'cpi ',
    'inflation',
    'pce ',
    'payroll',
    'jobs report',
    'treasury',
    'tariff',
    'trade war',
    'china',
    'trump',
    'biden',
    'white house',
    'state department',
    'middle east',
    'strait',
    'dollar',
    'yen',
    'euro zone',
    'ecb ',
    'bank of england',
    'debt ceiling',
    'shutdown',
    'sovereign',
  ];
  return keys.some((k) => s.includes(k));
}

function barIndexContaining(bars: VeloBar[], tMs: number): number {
  const barMs = 60_000;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.t <= tMs && tMs < b.t + barMs) return i;
  }
  return -1;
}

/** Ascending-sorted sample: q in [0,1], value at or above ~q fraction of the mass. */
function ascendingQuantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return Infinity;
  const qq = Math.max(0, Math.min(1, q));
  const idx = Math.min(sortedAsc.length - 1, Math.floor(qq * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}

function forwardWindowMetrics(bars: VeloBar[], startIdx: number, W: number): { rangeFrac: number; netFrac: number } | null {
  if (startIdx < 0 || startIdx + W >= bars.length) return null;
  const ref = Math.max(bars[startIdx].c, 1e-12);
  let maxH = -Infinity;
  let minL = Infinity;
  for (let j = startIdx + 1; j <= startIdx + W; j++) {
    maxH = Math.max(maxH, bars[j].h);
    minL = Math.min(minL, bars[j].l);
  }
  if (!Number.isFinite(maxH) || !Number.isFinite(minL)) return null;
  const endClose = bars[startIdx + W].c;
  return {
    rangeFrac: (maxH - minL) / ref,
    netFrac: Math.abs(endClose - ref) / ref,
  };
}

/** One value per valid start index s: move over bars (s+1..s+W) vs ref at s.c */
function collectForwardBaseline(bars: VeloBar[], W: number): { ranges: number[]; nets: number[] } {
  const ranges: number[] = [];
  const nets: number[] = [];
  for (let s = 0; s + W < bars.length; s++) {
    const m = forwardWindowMetrics(bars, s, W);
    if (m) {
      ranges.push(m.rangeFrac);
      nets.push(m.netFrac);
    }
  }
  ranges.sort((a, b) => a - b);
  nets.sort((a, b) => a - b);
  return { ranges, nets };
}

/**
 * Keep a headline only if BTC’s *next* W 1m bars are unusually large vs the same
 * W-bar signature computed everywhere on the recent tape (quantile gates + abs floors).
 * NEWS_REACT_COMBINE=or → either range or net clears its bar (still vs distribution thresholds).
 */
function filterNewsByPostHeadlineMove(items: NewsItem[], bars: VeloBar[]): NewsItem[] {
  if (!bars.length) return [];
  const W = Math.max(1, Math.round(REACT_WINDOW_MIN));
  const { ranges: rangesAsc, nets: netsAsc } = collectForwardBaseline(bars, W);
  const useQuantile = rangesAsc.length >= BASELINE_MIN_WINDOWS;
  let rangeThr: number;
  let netThr: number;
  if (useQuantile) {
    rangeThr = Math.max(ABS_MIN_RANGE, ascendingQuantile(rangesAsc, REACT_RANGE_Q));
    netThr = Math.max(ABS_MIN_NET, ascendingQuantile(netsAsc, REACT_NET_Q));
  } else {
    rangeThr = ABS_MIN_RANGE;
    netThr = ABS_MIN_NET;
  }

  const out: NewsItem[] = [];
  const tFirst = bars[0].t;
  const tLast = bars[bars.length - 1].t + 60_000;
  for (const it of items) {
    const tNews = it.t;
    if (tNews < tFirst || tNews >= tLast) continue;
    const i = barIndexContaining(bars, tNews);
    if (i < 0 || i + W >= bars.length) continue;
    const m = forwardWindowMetrics(bars, i, W);
    if (!m) continue;
    const rangeOk = m.rangeFrac >= rangeThr;
    const netOk = m.netFrac >= netThr;
    const looseOr = process.env.NEWS_REACT_COMBINE === 'or';
    const pass = looseOr ? rangeOk || netOk : rangeOk && netOk;
    if (pass) out.push(it);
  }
  return out;
}

async function loadBtc1mRecent(): Promise<VeloBar[]> {
  const now = Date.now();
  const begin = now - BTC_HISTORY_H * 3600_000;
  const raw = await fetchVelo(BTC_SYM, 1, begin, now);
  return raw.sort((a, b) => a.t - b.t);
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const it of items.sort((a, b) => b.t - a.t)) {
    const key = it.title.slice(0, 160).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
    if (merged.length >= HEADLINE_CAP) break;
  }
  return merged;
}

async function ensureTelegramClient(): Promise<TelegramClient | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  if (client) {
    try {
      if (!client.connected) await client.connect();
      if (await client.checkAuthorization()) return client;
    } catch {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
      client = null;
    }
  }
  const c = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
  });
  try {
    await c.connect();
    if (!(await c.checkAuthorization())) {
      console.error('[news-tg] Session not authorized — run: npm run telegram:login');
      await c.disconnect();
      return null;
    }
    client = c;
    return c;
  } catch (e) {
    console.warn('[news-tg] connect failed', e);
    try {
      await c.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function fetchChannelMessages(): Promise<NewsItem[]> {
  const c = await ensureTelegramClient();
  if (!c) return [];
  const peer = channelPeer();
  const messages = await c.getMessages(peer, { limit: HEADLINE_CAP });
  const out: NewsItem[] = [];
  for (const m of messages) {
    if (!m || !(m instanceof Api.Message)) continue;
    const text = (m.message || '').trim();
    if (text.length < 4) continue;
    const t = Number(m.date) * 1000;
    if (!Number.isFinite(t)) continue;
    const url = firstUrlFromMessage(m.message || '', m.entities);
    out.push({
      t,
      title: text.slice(0, 500),
      url,
      macro: titleLooksMacro(text),
    });
  }
  return dedupeNews(out);
}

async function refreshLoop(): Promise<void> {
  const cfg = readConfig();
  if (cfg) {
    try {
      const merged = await fetchChannelMessages();
      if (merged.length) {
        try {
          const btc = await loadBtc1mRecent();
          const passed = filterNewsByPostHeadlineMove(merged, btc);
          cache = passed.sort((a, b) => b.t - a.t).slice(0, HEADLINE_CAP);
        } catch {
          cache = [];
        }
      } else {
        cache = [];
      }
    } catch (e) {
      console.warn('[news-tg] poll error', e);
      try {
        if (client) {
          await client.disconnect();
        }
      } catch {
        /* ignore */
      }
      client = null;
    }
  }
  setTimeout(() => void refreshLoop(), TG_POLL_MS);
}

export function startNewsTelegramPoller(): void {
  void refreshLoop();
}

export function getNewsItems(): NewsItem[] {
  return cache;
}
