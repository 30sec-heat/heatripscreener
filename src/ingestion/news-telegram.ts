import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import bigInt from 'big-integer';

export type NewsItem = { t: number; title: string; url?: string; macro?: boolean; msgId?: number };

const TG_POLL_MS = Math.max(30_000, Number(process.env.TELEGRAM_NEWS_POLL_MS) || 90_000);
/** Rolling window of headlines we keep in memory / serve (default 7 days). */
const RETENTION_MS = Math.max(
  24 * 3600_000,
  Math.min(31 * 24 * 3600_000, Number(process.env.NEWS_RETENTION_MS) || 7 * 24 * 3600_000),
);
const TG_PAGE = Math.max(20, Math.min(200, Number(process.env.TELEGRAM_NEWS_PAGE) || 100));
const TG_MAX_PAGES = Math.max(10, Math.min(800, Number(process.env.TELEGRAM_NEWS_MAX_PAGES) || 400));
const WEB_MAX_PAGES = Math.max(1, Math.min(60, Number(process.env.TELEGRAM_WEB_PREVIEW_MAX_PAGES) || 28));
/** After AUTH_KEY_DUPLICATED, pause MTProto retries (session is invalid for concurrent use). */
const MTPROTO_BACKOFF_MS = Math.max(60_000, Number(process.env.TELEGRAM_MTPROTO_BACKOFF_MS) || 30 * 60_000);

/** Public “Market News Feed” — https://t.me/marketfeed (override only via env). */
const DEFAULT_NEWS_CHANNEL = 'marketfeed';

let cache: NewsItem[] = [];
let client: TelegramClient | null = null;
let warnedConfig = false;
let warnedAuthDup = false;
/** Skip MTProto polls until this time (Unix ms). */
let mtprotoBackoffUntil = 0;

/** Numeric id (e.g. -100…) or public @username without @. */
function channelPeer(): string | bigInt.BigInteger {
  const raw = (process.env.TELEGRAM_NEWS_CHANNEL_ID || DEFAULT_NEWS_CHANNEL).trim();
  if (/^-?\d+$/.test(raw)) return bigInt(raw);
  return raw.replace(/^@/, '');
}

/** Public https://t.me/s/username scrape only works for @username peers, not numeric channel ids. */
function channelUsernameForWeb(): string | null {
  const raw = (process.env.TELEGRAM_NEWS_CHANNEL_ID || DEFAULT_NEWS_CHANNEL).trim().replace(/^@/, '');
  if (!raw || /^-?\d+$/.test(raw)) return null;
  return raw;
}

function readConfig(): { apiId: number; apiHash: string; session: string } | null {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim();
  const session = process.env.TELEGRAM_SESSION_STRING?.trim();
  if (!apiId || !apiHash || !session) {
    if (!warnedConfig) {
      console.warn(
        '[news-tg] Set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING (Railway secrets). Default news source: @marketfeed; override TELEGRAM_NEWS_CHANNEL_ID only if needed.',
      );
    }
    warnedConfig = true;
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

/** GramJS returns TL objects with className; instanceof checks are brittle across builds. */
function telegramMessageId(raw: { id?: unknown }): number | undefined {
  const id = raw.id;
  if (id == null) return undefined;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'bigint') return Number(id);
  if (typeof id === 'object' && id !== null && 'valueOf' in id) {
    const v = Number((id as { valueOf: () => number }).valueOf());
    if (Number.isFinite(v)) return v;
  }
  const n = Number(id as number);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map one GramJS message row to NewsItem. Only channel text posts (`className === 'Message'`).
 */
function tgRowToNewsItem(raw: unknown): NewsItem | null {
  if (raw == null || typeof raw !== 'object') return null;
  const cn = (raw as { className?: string }).className;
  if (cn !== 'Message') return null;
  const m = raw as Api.Message;
  const text = (m.message || '').trim();
  if (text.length < 4) return null;
  const dateSec = Number(m.date);
  if (!Number.isFinite(dateSec)) return null;
  const msgId = telegramMessageId(m);
  if (msgId == null) return null;
  const t = dateSec * 1000;
  const url = firstUrlFromMessage(m.message || '', m.entities);
  return {
    msgId,
    t,
    title: text.slice(0, 500),
    url,
    macro: titleLooksMacro(text),
  };
}

/** Broad macro / geopolitical / rates bucket — chart badge only. */
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

function isAuthKeyDuplicated(err: unknown): boolean {
  if (err && typeof err === 'object' && 'errorMessage' in err) {
    return (err as { errorMessage?: string }).errorMessage === 'AUTH_KEY_DUPLICATED';
  }
  return String(err).includes('AUTH_KEY_DUPLICATED');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '\ufffd';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16);
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '\ufffd';
    });
}

function htmlToTitleText(html: string): string {
  const withNl = html.replace(/<br\s*\/?>/gi, '\n');
  const noTags = withNl.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(noTags).replace(/\s+/g, ' ').trim();
}

function firstHttpUrlInHtml(fragment: string): string | undefined {
  const m = fragment.match(/href="(https?:\/\/[^"]+)"/);
  if (!m) return undefined;
  return m[1].replace(/&amp;/g, '&');
}

/**
 * Fetch public channel posts via https://t.me/s/username (HTML preview). No MTProto session.
 * Used when MTProto fails (e.g. AUTH_KEY_DUPLICATED) or returns no items.
 */
async function fetchTmePublicChannelWeb(channelUser: string): Promise<NewsItem[]> {
  const sinceMs = Date.now() - RETENTION_MS;
  const byId = new Map<number, NewsItem>();
  let tmeSuffix: string | null = `/s/${encodeURIComponent(channelUser)}`;
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; heat.rip-news/1.0)' };

  for (let page = 0; page < WEB_MAX_PAGES && tmeSuffix; page++) {
    const pageUrl: string = `https://t.me${tmeSuffix}`;
    const res: globalThis.Response = await fetch(pageUrl, { headers });
    if (!res.ok) break;
    const html: string = await res.text();
    const prevM: RegExpMatchArray | null = html.match(/<link rel="prev" href="([^"]+)"/);
    const parts = html.split('tgme_widget_message_wrap');
    let oldestInPage = Infinity;
    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];
      const postM = chunk.match(/data-post="[^/]+\/(\d+)"/);
      const dateM = chunk.match(/datetime="([^"]+)"/);
      const textM = chunk.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!postM || !dateM || !textM) continue;
      const msgId = Number(postM[1]);
      const t = Date.parse(dateM[1]);
      if (!Number.isFinite(msgId) || !Number.isFinite(t)) continue;
      oldestInPage = Math.min(oldestInPage, t);
      if (t < sinceMs) continue;
      const title = htmlToTitleText(textM[1]).slice(0, 500);
      if (title.length < 4) continue;
      const urlOut = firstHttpUrlInHtml(textM[1]) ?? firstHttpUrlInHtml(chunk);
      byId.set(msgId, { msgId, t, title, url: urlOut, macro: titleLooksMacro(title) });
    }
    if (oldestInPage < sinceMs) break;
    tmeSuffix = prevM?.[1] ?? null;
  }

  return [...byId.values()].sort((a, b) => b.t - a.t);
}

/**
 * Walk channel history backward from the latest message until we pass the retention cutoff.
 * Dedupes by Telegram message id only (same post fetched on overlapping pages).
 */
async function fetchChannelMessagesRetained(
  c: TelegramClient,
  peer: string | bigInt.BigInteger,
): Promise<NewsItem[]> {
  const sinceSec = Math.floor((Date.now() - RETENTION_MS) / 1000);
  const byId = new Map<number, NewsItem>();
  let offsetId = 0;
  let totalRaw = 0;

  for (let page = 0; page < TG_MAX_PAGES; page++) {
    const batch = await c.getMessages(peer, {
      limit: TG_PAGE,
      ...(offsetId ? { offsetId } : {}),
    });
    if (!batch?.length) break;

    totalRaw += batch.length;
    let oldestSecInPage = Infinity;
    for (const raw of batch) {
      if (!raw || typeof raw !== 'object') continue;
      const ds = Number((raw as { date?: unknown }).date);
      if (Number.isFinite(ds)) oldestSecInPage = Math.min(oldestSecInPage, ds);
      if (ds < sinceSec) continue;
      const it = tgRowToNewsItem(raw);
      if (it && it.msgId != null) byId.set(it.msgId, it);
    }

    const last = batch[batch.length - 1] as { id?: unknown; className?: string } | undefined;
    if (!last) break;
    if (oldestSecInPage < sinceSec) break;

    const lastOff = telegramMessageId(last);
    if (lastOff == null) break;
    offsetId = lastOff;
    if (batch.length < TG_PAGE) break;
  }

  const out = [...byId.values()].sort((a, b) => b.t - a.t);
  if (!out.length && totalRaw > 0) {
    console.warn(
      '[news-tg] Telegram returned',
      totalRaw,
      'rows but parsed 0 text headlines — check channel posts or TELEGRAM_NEWS_CHANNEL_ID',
    );
  }
  return out;
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
    if (isAuthKeyDuplicated(e)) {
      if (!warnedAuthDup) {
        console.error(
          '[news-tg] AUTH_KEY_DUPLICATED — Telegram blocked this session (same key used from two places). Terminate other clients using TELEGRAM_SESSION_STRING, run npm run telegram:login, set a fresh string on Railway only, keep one replica. Using t.me public preview for @ channels until MTProto works.',
        );
        warnedAuthDup = true;
      }
      mtprotoBackoffUntil = Date.now() + MTPROTO_BACKOFF_MS;
    } else {
      console.warn('[news-tg] connect failed', e);
    }
    try {
      await c.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function refreshLoop(): Promise<void> {
  let nextMs = TG_POLL_MS;
  let items: NewsItem[] = [];
  const cfg = readConfig();

  if (cfg && Date.now() >= mtprotoBackoffUntil) {
    try {
      const c = await ensureTelegramClient();
      if (c) {
        const peer = channelPeer();
        items = await fetchChannelMessagesRetained(c, peer);
        if (items.length) console.log('[news-tg]', items.length, 'headlines via MTProto @', String(peer));
      }
    } catch (e) {
      console.warn('[news-tg] poll error', e);
      if (isAuthKeyDuplicated(e)) {
        mtprotoBackoffUntil = Date.now() + MTPROTO_BACKOFF_MS;
        if (!warnedAuthDup) {
          console.error(
            '[news-tg] AUTH_KEY_DUPLICATED during poll — see prior log. Falling back to t.me preview where possible.',
          );
          warnedAuthDup = true;
        }
        nextMs = Math.max(nextMs, 120_000);
      }
      try {
        if (client) await client.disconnect();
      } catch {
        /* ignore */
      }
      client = null;
    }
  }

  if (items.length === 0) {
    const u = channelUsernameForWeb();
    if (u) {
      try {
        const webItems = await fetchTmePublicChannelWeb(u);
        if (webItems.length) {
          items = webItems;
          console.log('[news-tg]', webItems.length, 'headlines via https://t.me/s/' + u + ' (public web preview)');
        }
      } catch (w) {
        console.warn('[news-tg] public web preview failed', w);
      }
    }
  }

  cache = items;
  setTimeout(() => void refreshLoop(), nextMs);
}

export function startNewsTelegramPoller(): void {
  void refreshLoop();
}

export function getNewsItems(): NewsItem[] {
  return cache;
}
