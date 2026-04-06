import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';
import { fetchVelo, type VeloBar } from '../shared/velo.js';

export type NewsItem = { t: number; title: string; url?: string; macro?: boolean };

const BTC_SYM = 'BTCUSDT';
const REACT_WINDOW_MIN = Math.max(5, Math.min(45, Number(process.env.NEWS_REACT_WINDOW_MIN) || 15));
const REACT_MIN_RANGE = Math.max(
  0.0005,
  Math.min(0.02, Number(process.env.NEWS_REACT_MIN_RANGE) || 0.001),
);
/** Min |close(N min after news) − close(headline bar)| / ref — proves price didn’t just chop in-place. */
const REACT_MIN_NET = Math.max(
  0,
  Math.min(0.02, Number(process.env.NEWS_REACT_MIN_NET) || REACT_MIN_RANGE * 0.35),
);
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

/**
 * Keep a headline only if BTC moved **after** the headline minute: we anchor on the 1m bar that
 * contains the post time, then measure only bars `i+1 … i+W` (no pre-news leakage into the tape).
 * Require enough post-window range *and* net displacement vs headline close (configurable via env).
 */
function filterNewsByPostHeadlineMove(items: NewsItem[], bars: VeloBar[]): NewsItem[] {
  if (!bars.length) return [];
  const barStep = Math.max(1, Math.round(REACT_WINDOW_MIN));
  const out: NewsItem[] = [];
  const tFirst = bars[0].t;
  const tLast = bars[bars.length - 1].t + 60_000;
  for (const it of items) {
    const tNews = it.t;
    if (tNews < tFirst || tNews >= tLast) continue;
    const i = barIndexContaining(bars, tNews);
    if (i < 0) continue;
    // Strictly *after* headline candle: need i+1 .. i+barStep inclusive
    if (i + barStep >= bars.length) continue;
    const ref = Math.max(bars[i].c, 1e-12);
    let maxH = -Infinity;
    let minL = Infinity;
    for (let j = i + 1; j <= i + barStep && j < bars.length; j++) {
      maxH = Math.max(maxH, bars[j].h);
      minL = Math.min(minL, bars[j].l);
    }
    if (!Number.isFinite(maxH) || !Number.isFinite(minL)) continue;
    const rangeFrac = (maxH - minL) / ref;
    const endClose = bars[i + barStep].c;
    const netFrac = Math.abs(endClose - ref) / ref;
    const rangeOk = rangeFrac >= REACT_MIN_RANGE;
    const netOk = REACT_MIN_NET <= 0 ? true : netFrac >= REACT_MIN_NET;
    if (rangeOk && netOk) out.push(it);
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
