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

function messageToItem(m: Api.Message): NewsItem | null {
  const text = (m.message || '').trim();
  if (text.length < 4) return null;
  const dateSec = Number(m.date);
  if (!Number.isFinite(dateSec)) return null;
  const t = dateSec * 1000;
  const url = firstUrlFromMessage(m.message || '', m.entities);
  const idNum = typeof m.id === 'bigint' ? Number(m.id) : Number(m.id);
  return {
    msgId: Number.isFinite(idNum) ? idNum : undefined,
    t,
    title: text.slice(0, 500),
    url,
    macro: titleLooksMacro(text),
  };
}

/**
 * Walk channel history backward from the latest message until we pass the retention cutoff.
 * Dedupes by Telegram message id only (same post fetched on overlapping pages).
 */
async function fetchChannelMessagesRetained(c: TelegramClient, peer: bigInt.BigInteger): Promise<NewsItem[]> {
  const sinceSec = Math.floor((Date.now() - RETENTION_MS) / 1000);
  const byId = new Map<number, NewsItem>();
  let offsetId = 0;

  for (let page = 0; page < TG_MAX_PAGES; page++) {
    const batch = await c.getMessages(peer, {
      limit: TG_PAGE,
      ...(offsetId ? { offsetId } : {}),
    });
    if (!batch?.length) break;

    let oldestSecInPage = Infinity;
    for (const raw of batch) {
      if (!raw || !(raw instanceof Api.Message)) continue;
      const ds = Number(raw.date);
      if (Number.isFinite(ds)) oldestSecInPage = Math.min(oldestSecInPage, ds);
      if (ds < sinceSec) continue;
      const it = messageToItem(raw);
      if (it?.msgId != null) byId.set(it.msgId, it);
    }

    const last = batch[batch.length - 1];
    if (!(last instanceof Api.Message)) break;
    if (oldestSecInPage < sinceSec) break;

    offsetId = typeof last.id === 'bigint' ? Number(last.id) : Number(last.id);
    if (!Number.isFinite(offsetId)) break;
    if (batch.length < TG_PAGE) break;
  }

  return [...byId.values()].sort((a, b) => b.t - a.t);
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

async function refreshLoop(): Promise<void> {
  const cfg = readConfig();
  if (cfg) {
    try {
      const c = await ensureTelegramClient();
      if (c) {
        const peer = channelPeer();
        cache = await fetchChannelMessagesRetained(c, peer);
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
