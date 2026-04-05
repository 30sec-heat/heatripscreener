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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${SERVER_PORT}`);

  // Returns { bars: [...], oiByEx: { "binance-futures": [{t,o,h,l,c},...], ... } }
  // Frontend computes net L/S, aggregated OI, and split views locally
  if (url.pathname === '/api/chart') {
    const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
    const hours = Math.min(parseFloat(url.searchParams.get('hours') ?? '34'), 72);
    const now = Date.now();
    const begin = now - hours * 3600000;

    try {
      // Price bars (paginated)
      let priceBars: any[] = [];
      for (let c = begin; c < now; c += PRICE_CHUNK) {
        priceBars.push(...await fetchVelo(symbol, PRICE_RES, c, Math.min(c + PRICE_CHUNK, now)));
      }

      const oiByEx: Record<string, { t: number; o: number; h: number; l: number; c: number }[]> = {};
      for (const ex of ALL_EXCHANGES) {
        const points: { t: number; o: number; h: number; l: number; c: number }[] = [];
        const oiSym = `${symbol}#${ex}#open_interest#aggregated#USD#Candles`;
        for (let c = begin; c < now; c += OI_CHUNK) {
          try {
            const arr = await fetchVelo(oiSym, OI_RES, c, Math.min(c + OI_CHUNK, now));
            for (const r of arr)
              points.push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] });
          } catch {}
        }
        oiByEx[ex] = points;
      }

      // Price bars as compact arrays
      const bars = priceBars.map((r: number[]) => ({
        t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0
      }));

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
startVeloLivePoller(SYMBOLS);
startOIPoller(SYMBOLS, TIMEFRAMES, 60000);

server.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[heat.rip] listening on :${SERVER_PORT}`);
});
