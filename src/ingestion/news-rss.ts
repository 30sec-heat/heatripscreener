import { fetchVelo, type VeloBar } from '../shared/velo.js';

export type NewsItem = { t: number; title: string; url?: string; macro?: boolean };

const UA = { 'User-Agent': 'heat.rip-news/1 (+https://heat.rip)' };

const BTC_SYM = 'BTCUSDT';
const REACT_WINDOW_MIN = Math.max(5, Math.min(45, Number(process.env.NEWS_REACT_WINDOW_MIN) || 15));
const REACT_MIN_RANGE = Math.max(
  0.0005,
  Math.min(0.02, Number(process.env.NEWS_REACT_MIN_RANGE) || 0.001),
);
const BTC_HISTORY_H = Math.max(24, Math.min(96, Number(process.env.NEWS_BTC_HISTORY_H) || 72));

/** Free RSS only (no X API). Override with NEWS_RSS_URLS=comma,separated. */
const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/business/rss.xml',
  'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en',
];

let cache: NewsItem[] = [];

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').trim();
}

function decodeXml(s: string): string {
  return stripCdata(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function extractLink(block: string): string {
  const m = block.match(/<link[^>]*>([^<]*)<\/link>/i);
  if (m) return decodeXml(m[1]);
  const m2 = block.match(/<link[^>]+href\s*=\s*["']([^"']+)["']/i);
  return m2 ? decodeXml(m2[1]) : '';
}

function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeXml(extractTag(block, 'title'));
    if (!title) continue;
    const pub = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'updated');
    const t = pub ? Date.parse(pub) : NaN;
    if (!Number.isFinite(t)) continue;
    const url = extractLink(block) || undefined;
    out.push({ t, title, url, macro: titleLooksMacro(title) });
  }
  return out;
}

/** Broad macro / geopolitical / rates bucket — used for labeling; reaction is always judged on BTC. */
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
    'default',
    'debt ceiling',
    'shutdown',
    'sovereign',
  ];
  return keys.some((k) => s.includes(k));
}

/** Map headline wall time → 1m bar index whose interval contains tMs. */
function barIndexContaining(bars: VeloBar[], tMs: number): number {
  const barMs = 60_000;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.t <= tMs && tMs < b.t + barMs) return i;
  }
  return -1;
}

/**
 * Require a real BTC tape move in the minutes after the headline. All stories use BTC as the
 * reaction benchmark (macro = crypto-beta anchor).
 */
function filterNewsByBtcReaction(items: NewsItem[], bars: VeloBar[]): NewsItem[] {
  if (!bars.length) return items;
  const barStep = Math.max(1, Math.round(REACT_WINDOW_MIN));
  const out: NewsItem[] = [];
  const tFirst = bars[0].t;
  const tLast = bars[bars.length - 1].t + 60_000;
  for (const it of items) {
    const tNews = it.t;
    if (tNews < tFirst || tNews >= tLast - barStep * 60_000) continue;
    const i = barIndexContaining(bars, tNews);
    if (i < 0) continue;
    if (i + barStep > bars.length) continue;
    const ref = Math.max(bars[i].c, 1e-12);
    let maxH = -Infinity;
    let minL = Infinity;
    for (let j = i; j < i + barStep && j < bars.length; j++) {
      maxH = Math.max(maxH, bars[j].h);
      minL = Math.min(minL, bars[j].l);
    }
    const rangeFrac = (maxH - minL) / ref;
    if (rangeFrac >= REACT_MIN_RANGE) out.push(it);
  }
  return out;
}

async function loadBtc1mRecent(): Promise<VeloBar[]> {
  const now = Date.now();
  const begin = now - BTC_HISTORY_H * 3600_000;
  const raw = await fetchVelo(BTC_SYM, 1, begin, now);
  return raw.sort((a, b) => a.t - b.t);
}

async function fetchFeed(url: string): Promise<NewsItem[]> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return [];
  const xml = await r.text();
  return parseRss(xml);
}

function mergeDedupe(batches: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const it of batches.sort((a, b) => b.t - a.t)) {
    const key = it.title.slice(0, 160).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
    if (merged.length >= 120) break;
  }
  return merged;
}

async function refreshLoop(): Promise<void> {
  const raw = process.env.NEWS_RSS_URLS || DEFAULT_FEEDS.join(',');
  const urls = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const acc: NewsItem[] = [];
  for (const u of urls) {
    try {
      acc.push(...(await fetchFeed(u)));
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  if (acc.length) {
    const merged = mergeDedupe(acc);
    try {
      const btc = await loadBtc1mRecent();
      cache = filterNewsByBtcReaction(merged, btc);
    } catch {
      cache = merged;
    }
  }
  setTimeout(() => void refreshLoop(), 90_000);
}

export function startNewsRssPoller(): void {
  void refreshLoop();
}

export function getNewsItems(): NewsItem[] {
  return cache;
}
