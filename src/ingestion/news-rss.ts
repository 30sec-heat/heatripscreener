export type NewsItem = { t: number; title: string; url?: string };

const UA = { 'User-Agent': 'heat.rip-news/1 (+https://heat.rip)' };

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
    out.push({ t, title, url });
  }
  return out;
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
  if (acc.length) cache = mergeDedupe(acc);
  setTimeout(() => void refreshLoop(), 90_000);
}

export function startNewsRssPoller(): void {
  void refreshLoop();
}

export function getNewsItems(): NewsItem[] {
  return cache;
}
