/**
 * Download exchange logos into app/exchange-logos/ + manifest.json.
 * Tiers: Simple Icons (SVG) → CoinGecko static CDN → Google s2 favicon → DexScreener.
 *
 * Usage: npx tsx scripts/fetch-exchange-logos.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'app/exchange-logos');

const UA = 'Mozilla/5.0 (compatible; heat.rip/1; +https://heat.rip)';

const SIMPLE_ICONS = 'https://cdn.jsdelivr.net/npm/simple-icons/icons';

/** Full-color brand SVGs (monochrome glyph; client draws on dark bg). */
const SIMPLE_SLUGS: Record<string, string> = {
  binance: 'binance',
  okx: 'okx',
  kucoin: 'kucoin',
};

/** CoinGecko market icon CDN (verified 200, ~50×50). */
const COINGECKO: Record<string, string> = {
  bybit: 'https://coin-images.coingecko.com/markets/images/460/small/photo_2021-08-12_18-27-50.jpg?1706864447',
  deribit: 'https://coin-images.coingecko.com/markets/images/402/small/deribit-logo.jpg?1756650215',
  bitget: 'https://coin-images.coingecko.com/markets/images/540/small/2023-07-25_21.47.43.jpg?1706864507',
  binance: 'https://coin-images.coingecko.com/markets/images/52/small/binance.jpg?1706864274',
  okx: 'https://coin-images.coingecko.com/markets/images/96/small/WeChat_Image_20220117220452.png?1706864283',
  gate: 'https://coin-images.coingecko.com/markets/images/60/small/gate.png?1696484917',
};

const DEX_SCREENER = (slug: string) =>
  `https://dd.dexscreener.com/ds-data/dexes/${slug}.png`;

/** Favicon fallback (domain only). */
const FAV_DOMAIN: Record<string, string> = {
  mexc: 'mexc.com',
  blofin: 'blofin.com',
  coinbase: 'coinbase.com',
  kraken: 'kraken.com',
  kucoin: 'kucoin.com',
};

/** Every slug the Mirrorly chart+tip may request. */
const ALL_SLUGS = [
  'binance',
  'bybit',
  'okx',
  'deribit',
  'bitget',
  'hyperliquid',
  'gate',
  'kucoin',
  'mexc',
  'blofin',
  'coinbase',
  'kraken',
] as const;

function extFromCt(ct: string): string {
  const t = (ct || '').toLowerCase();
  if (t.includes('svg')) return 'svg';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  return 'bin';
}

async function trySave(url: string, slug: string, minBytes = 400): Promise<string | null> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) return null;
  const ext = extFromCt(res.headers.get('content-type') || '');
  const filename = `${slug}.${ext}`;
  fs.writeFileSync(path.join(OUT, filename), buf);
  return filename;
}

async function fetchLogo(slug: string): Promise<string | null> {
  const simple = SIMPLE_SLUGS[slug];
  if (simple) {
    const url = `${SIMPLE_ICONS}/${simple}.svg`;
    const name = await trySave(url, slug, 200);
    if (name) return name;
  }

  const cg = COINGECKO[slug];
  if (cg) {
    const name = await trySave(cg, slug, 400);
    if (name) return name;
  }

  if (slug === 'hyperliquid') {
    const name = await trySave(DEX_SCREENER('hyperliquid'), slug, 200);
    if (name) return name;
  }

  const dom = FAV_DOMAIN[slug];
  if (dom) {
    const url = `https://www.google.com/s2/favicons?domain=${dom}&sz=128`;
    const name = await trySave(url, slug, 100);
    if (name) return name;
  }

  const dex = await trySave(DEX_SCREENER(slug), slug, 600);
  if (dex) return dex;

  console.warn(`[logos] ${slug}: all sources failed`);
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const slug of ALL_SLUGS) {
    try {
      const f = await fetchLogo(slug);
      if (f) {
        manifest[slug] = f;
        console.log(`[logos] ${slug} -> ${f}`);
      }
    } catch (e) {
      console.warn(`[logos] ${slug}:`, e);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('[logos] manifest.json done, keys:', Object.keys(manifest).length);
}

main().catch(console.error);
