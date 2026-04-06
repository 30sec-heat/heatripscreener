import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SERVER_PORT, SYMBOLS, TIMEFRAMES } from '../shared/config.js';
import { fetchPerpUsdtTickerRows } from '../shared/binance-markets.js';
import { BUNDLED_TICKERS } from '../data/bundled-tickers.gen.js';
import { setupWebSocket } from './ws-handler.js';
import { startOIPoller, isBanned, checkBanResponse } from '../ingestion/oi-poller.js';
import { startVeloLivePoller } from '../ingestion/velo-live-bars.js';
import { applyLiveTickerOverlay, startBinanceMiniTickerWs } from '../ingestion/binance-mini-ticker-ws.js';
import {
  fetchVeloRaw,
  ALL_EXCHANGES,
  buildAggregatedOISymbol,
  buildPerVenueOISymbol,
  sleep,
} from '../shared/velo.js';
import {
  startMirrorlyIngestion,
  getMirrorlyForChartSymbol,
  mirrorlyProfileUrl,
} from './mirrorly.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '../../app');

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// 1m price + 1m OI (Velo). One range call returns full granular candles; higher TFs re-aggregated in the client.
const PRICE_RES = 1;
const OI_RES = 1;

async function fetchVelo(symbol: string, res: number, begin: number, end: number) {
  return fetchVeloRaw(symbol, res, begin, end);
}

function pushOiRows(dst: { t: number; o: number; h: number; l: number; c: number }[], rows: number[][]) {
  for (const r of rows) dst.push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4] });
}

async function buildChartPayloadOnce(
  symbol: string,
  hours: number,
  perVenueOi: boolean,
  now: number,
) {
  const begin = now - hours * 3600000;

  const oiByEx: Record<string, { t: number; o: number; h: number; l: number; c: number }[]> = {};
  for (const ex of ALL_EXCHANGES) oiByEx[ex] = [];

  const priceP = fetchVelo(symbol, PRICE_RES, begin, now);
  const oiP = perVenueOi
    ? Promise.all(
        ALL_EXCHANGES.map(async (ex) => {
          try {
            const rows = await fetchVelo(buildPerVenueOISymbol(symbol, ex), OI_RES, begin, now);
            return { ex, rows } as const;
          } catch {
            return { ex, rows: [] as number[][] } as const;
          }
        }),
      )
    : fetchVelo(buildAggregatedOISymbol(symbol), OI_RES, begin, now).catch(() => [] as number[][]);

  const [priceArr, oiOut] = await Promise.all([priceP, oiP]);

  const priceBars = [...priceArr].sort((a, b) => a[0] - b[0]);

  if (perVenueOi) {
    for (const { ex, rows } of oiOut as { ex: string; rows: number[][] }[]) pushOiRows(oiByEx[ex], rows);
  } else {
    pushOiRows(oiByEx[ALL_EXCHANGES[0]], oiOut as number[][]);
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

/** Velo often times out or returns [] for long ranges from cloud IPs — retry with shorter windows. */
async function buildChartPayload(symbol: string, hours: number, perVenueOi: boolean) {
  const now = Date.now();
  const tiers = [hours, Math.min(hours, 8), Math.min(hours, 4), 2, 1];
  const tried = new Set<number>();
  let last: Awaited<ReturnType<typeof buildChartPayloadOnce>> | undefined;
  for (const h of tiers) {
    const hn = Math.max(1, Math.min(72, h));
    if (tried.has(hn)) continue;
    tried.add(hn);
    last = await buildChartPayloadOnce(symbol, hn, perVenueOi, now);
    if (last.bars.length > 0) return last;
    await sleep(250);
  }
  return last ?? buildChartPayloadOnce(symbol, 1, perVenueOi, now);
}

const TICKERS_SNAPSHOT = path.join(APP_DIR, 'tickers.json');

function readTickerSnapshot(): any[] {
  if (BUNDLED_TICKERS.length > 0) return BUNDLED_TICKERS.map((t) => ({ ...t }));
  try {
    const raw = fs.readFileSync(TICKERS_SNAPSHOT, 'utf8');
    const d = JSON.parse(raw);
    if (Array.isArray(d) && d.length > 0) return d;
  } catch {
    /* missing */
  }
  return [];
}

let tickerCache: any[] = readTickerSnapshot();

async function refreshTickers() {
  if (!isBanned()) {
    const rows = await fetchPerpUsdtTickerRows();
    if (rows && rows.length > 0) {
      tickerCache = rows;
      try {
        fs.mkdirSync(path.dirname(TICKERS_SNAPSHOT), { recursive: true });
        fs.writeFileSync(TICKERS_SNAPSHOT, JSON.stringify(tickerCache));
      } catch {
        /* read-only fs */
      }
    } else {
      try {
        const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        const d = await r.json();
        if (Array.isArray(d)) checkBanResponse(d);
      } catch {
        /* ignore */
      }
    }
  }

  setTimeout(refreshTickers, 12_000);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${SERVER_PORT}`);

  // Returns { bars: [...], oiByEx: { "binance-futures": [{t,o,h,l,c},...], ... } }
  // Frontend computes net L/S, aggregated OI, and split views locally
  if (url.pathname === '/api/chart') {
    const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
    const hours = Math.min(
      Math.max(1, parseFloat(url.searchParams.get('hours') ?? '34') || 34),
      72,
    );
    const perVenueOi = url.searchParams.get('perVenueOi') === '1';

    try {
      const { bars, oiByEx } = await buildChartPayload(symbol, hours, perVenueOi);

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
  if (url.pathname === '/api/tickers' || url.pathname === '/tickers.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=2',
    });
    res.end(JSON.stringify(applyLiveTickerOverlay(tickerCache)));
    return;
  }

  if (url.pathname === '/api/mirrorly') {
    const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
    const positions = getMirrorlyForChartSymbol(symbol).map((p) => ({
      positionId: p.positionId,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      firstEntryPrice: p.firstEntryPrice,
      exitPrice: p.exitPrice,
      notionalUsd: p.positionSize,
      name: p.name,
      opened: new Date(p.openedMs).toISOString(),
      closed: p.closedMs != null ? new Date(p.closedMs).toISOString() : null,
      exchangeRef: p.exchangeRef,
      exchangeIdentifier: p.exchangeIdentifier,
      unrealizedPnl: p.unrealizedPnl,
      realizedPnl: p.realizedPnl,
      profileUrl: mirrorlyProfileUrl(p.exchangeIdentifier),
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=8',
    });
    res.end(JSON.stringify({ positions }));
    return;
  }

  let filePath = path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  const ext = path.extname(filePath);
  try { const data = fs.readFileSync(filePath); res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }); res.end(data); }
  catch { res.writeHead(404); res.end('Not Found'); }
});

void refreshTickers();
startBinanceMiniTickerWs();
startMirrorlyIngestion();

setupWebSocket(server);
startVeloLivePoller();
startOIPoller(TIMEFRAMES, 60000);

server.listen(SERVER_PORT, '0.0.0.0', () => {
  console.log(`[heat.rip] listening on :${SERVER_PORT}`);
});
