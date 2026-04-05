import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TICKER_FALLBACK } from '../src/shared/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../app');
const DATA_DIR = path.resolve(__dirname, '../src/data');
const OUT_APP = path.join(APP_DIR, 'tickers.json');
const OUT_BUNDLED = path.join(DATA_DIR, 'tickers-fallback.json');
const UA = { 'User-Agent': 'heat.rip-prefetch/1 (+https://heat.rip)' };

function slim(t: any) {
  return {
    symbol: t.symbol,
    lastPrice: String(t.lastPrice ?? 0),
    priceChangePercent: String(t.priceChangePercent ?? 0),
    quoteVolume: String(t.quoteVolume ?? 0),
  };
}

function sortUsdtByVol(rows: any[]): any[] {
  return rows
    .filter((t: any) => t?.symbol?.endsWith?.('USDT'))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
}

function synthetic() {
  return TICKER_FALLBACK.map((symbol) => slim({ symbol, lastPrice: '0', priceChangePercent: '0', quoteVolume: '0' }));
}

async function main() {
  let rows: any[] | null = null;
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { headers: UA });
    const d = await r.json();
    if (Array.isArray(d) && d.length > 0) {
      const sorted = sortUsdtByVol(d);
      if (sorted.length > 0) rows = sorted.map(slim);
    }
  } catch {
    /* spot */
  }
  if (!rows) {
    try {
      const r2 = await fetch('https://api.binance.com/api/v3/ticker/24hr', { headers: UA });
      const d2 = await r2.json();
      if (Array.isArray(d2) && d2.length > 0) {
        const sorted = sortUsdtByVol(d2);
        if (sorted.length > 0) rows = sorted.map(slim);
      }
    } catch {
      /* synthetic */
    }
  }
  if (!rows || rows.length === 0) rows = synthetic();
  const payload = JSON.stringify(rows);
  fs.mkdirSync(path.dirname(OUT_APP), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_BUNDLED), { recursive: true });
  fs.writeFileSync(OUT_APP, payload);
  fs.writeFileSync(OUT_BUNDLED, payload);
  console.log(`[prefetch-tickers] wrote ${rows.length} rows -> ${OUT_APP} + ${OUT_BUNDLED}`);
}

await main();
