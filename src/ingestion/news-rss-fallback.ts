import type { NewsItem } from './news-telegram.js';

const DEFAULT_RSS =
  'https://www.coindesk.com/arc/outboundfeeds/rss?outputType=xml';

let cache: NewsItem[] = [];
let cacheAt = 0;
const TTL_MS = Math.max(60_000, Number(process.env.NEWS_RSS_TTL_MS) || 90_000);

function rssUrl(): string {
  const u = process.env.NEWS_RSS_URL?.trim();
  return u || DEFAULT_RSS;
}

function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  const itemRe = /<item[^>]*>[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[0];
    const pub = block.match(/<pubDate>([^<]+)<\/pubDate>/i);
    const titleC = block.match(/<title>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/title>/i);
    const titleP = block.match(/<title>([^<]+)<\/title>/i);
    const linkM = block.match(/<link>([^<]+)<\/link>/i);
    const titleRaw = (titleC?.[1] ?? titleP?.[1] ?? '').trim();
    if (titleRaw.length < 4) continue;
    let t = Date.now();
    if (pub?.[1]) {
      const p = Date.parse(pub[1].trim());
      if (Number.isFinite(p)) t = p;
    }
    const url = linkM?.[1]?.trim() || undefined;
    out.push({ t, title: titleRaw.slice(0, 500), url });
  }
  return out.slice(0, 100);
}

export async function getRssFallbackNews(): Promise<NewsItem[]> {
  if (process.env.NEWS_RSS_DISABLE === '1') return [];
  const now = Date.now();
  if (cache.length && now - cacheAt < TTL_MS) return cache;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(rssUrl(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'heat.rip-screener/1.0', Accept: 'application/rss+xml, application/xml, text/xml' },
      redirect: 'follow',
    });
    if (!r.ok) return cache;
    const xml = await r.text();
    const items = parseRss(xml);
    if (items.length) {
      cache = items;
      cacheAt = now;
      console.log(`[news-rss] ${items.length} items from ${rssUrl()}`);
    }
    return cache;
  } catch (e) {
    console.warn('[news-rss] fetch failed', e);
    return cache;
  } finally {
    clearTimeout(to);
  }
}
