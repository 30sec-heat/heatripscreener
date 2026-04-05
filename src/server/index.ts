import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SERVER_PORT, SYMBOLS, TIMEFRAMES } from '../shared/config.js';
import { setupWebSocket } from './ws-handler.js';
import { startOIPoller, isBanned, checkBanResponse } from '../ingestion/oi-poller.js';
import { startVeloLivePoller } from '../ingestion/velo-live-bars.js';
import { fetchVeloRaw, ALL_EXCHANGES } from '../shared/velo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../../app');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// 1m price + 1m OI (Velo)
const PRICE_RES = 1;
const OI_RES = 1;
const PRICE_CHUNK = 7 * 3600000;
const OI_CHUNK = 7 * 3600000;

async function fetchVelo(symbol: string, res: number, begin: number, end: number) {
  return fetchVeloRaw(symbol, res, begin, end);
}

/** Bounded parallel HTTP to Velo (sequential was ~30+ round-trips × latency). */
async function promisePool<T>(factories: Array<() => Promise<T>>, batchSize: number): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < factories.length; i += batchSize) {
    const slice = factories.slice(i, i + batchSize).map((fn) => fn());
    out.push(...(await Promise.all(slice)));
  }
  return out;
}

async function buildChartPayload(symbol: string, hours: number) {
  const now = Date.now();
  const begin = now - hours * 3600000;

  const priceTasks: Array<() => Promise<number[][]>> = [];
  for (let c = begin; c < now; c += PRICE_CHUNK) {
    const c0 = c;
    const c1 = Math.min(c + PRICE_CHUNK, now);
    priceTasks.push(() => fetchVelo(symbol, PRICE_RES, c0, c1));
  }

  type OiPart = { ex: string; rows: number[][] };
  const oiTasks: Array<() => Promise<OiPart>> = [];
  for (const ex of ALL_EXCHANGES) {
    const oiSym = `${symbol}#${ex}#open_interest#aggregated#USD#Candles`;
    for (let c = begin; c < now; c += OI_CHUNK) {
      const c0 = c;
      const c1 = Math.min(c + OI_CHUNK, now);
      oiTasks.push(async () => {
        try {
          const arr = await fetchVelo(oiSym, OI_RES, c0, c1);
          return { ex, rows: arr };
        } catch {
          return { ex, rows: [] };
        }
      });
    }
  }

  const [priceChunks, oiParts] = await Promise.all([
    promisePool(priceTasks, 8),
    promisePool(oiTasks, 10),
  ]);

  const priceBars: number[][] = [];
  for (const arr of priceChunks) priceBars.push(...arr);

  const oiByEx: Record<string, { t: number; o: number; h: number; l: number; c: number }[]> = {};
  for (const ex of ALL_EXCHANGES) oiByEx[ex] = [];

  for (const { ex, rows } of oiParts) {
    for (const r of rows)
      oiByEx[ex].push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] });
  }

  const bars = priceBars.map((r: number[]) => ({
    t: r[0] * 1000,
    o: r[1],
    h: r[2],
    l: r[3],
    c: r[4],
    v: r[5] ?? 0,
  }));

  return { bars, oiByEx };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${SERVER_PORT}`);

  // Returns { bars: [...], oiByEx: { "binance-futures": [{t,o,h,l,c},...], ... } }
  // Frontend computes net L/S, aggregated OI, and split views locally
  if (url.pathname === '/api/chart') {
    const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
    const hours = Math.min(parseFloat(url.searchParams.get('hours') ?? '34'), 72);

    try {
      const { bars, oiByEx } = await buildChartPayload(symbol, hours);

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ bars, oiByEx }));
    } catch (e: any) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  if (url.pathname === '/api/exchanges') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(ALL_EXCHANGES)); return;
  }
  if (url.pathname === '/api/symbols') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(SYMBOLS)); return;
  }
  if (url.pathname === '/api/tickers') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(tickerCache)); return;
  }

  let filePath = path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath);
  try { const data = fs.readFileSync(filePath); res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not Found'); }
});

let tickerCache: any[] = [];
async function refreshTickers() {
  if (!isBanned()) {
    try {
      const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
      const d = await r.json();
      if (Array.isArray(d)) tickerCache = d.filter((t: any) => t.symbol.endsWith('USDT')).sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
      else checkBanResponse(d);
    } catch {}
  }
  setTimeout(refreshTickers, 60000);
}
setTimeout(refreshTickers, 3000);

setupWebSocket(server);
startVeloLivePoller();
startOIPoller(TIMEFRAMES, 60000);

server.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[heat.rip] listening on :${SERVER_PORT}`);
});
