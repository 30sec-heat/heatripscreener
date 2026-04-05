import { fetchVeloRaw } from '../shared/velo.js';
import type { Bar } from '../shared/types.js';
import { barEvents } from './bar-aggregator.js';
import { updatePrice } from './oi-poller.js';

const PRICE_RES = 1;
const BUCKET_MS = 60_000;

/** How often to refetch the tail of 1m bars from Velo (forming candle = Velo’s last open bucket). */
export const VELO_LIVE_POLL_MS = Math.max(2000, Number(process.env.VELO_LIVE_POLL_MS) || 4000);
const LOOKBACK_MS = 3 * 3600000;

const pollSymbols = new Set<string>();
const lastClosedEmittedTs = new Map<string, number>();
const initDone = new Map<string, boolean>();
const formingCache = new Map<string, Bar | null>();

export function ensureVeloLiveSymbols(symbols: Iterable<string>) {
  for (const s of symbols) pollSymbols.add(s);
}

function rowToBar(symbol: string, row: number[]): Bar {
  const t = row[0] * 1000;
  const o = row[1],
    h = row[2],
    l = row[3],
    c = row[4];
  const v = row[5] ?? 0;
  return {
    ts: t,
    symbol,
    exchange: 'binance',
    tfSeconds: 60,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    buyVolume: 0,
    sellVolume: 0,
    tradeCount: 0,
    cvd: 0,
    vwap: c,
    netLongs: 0,
    netShorts: 0,
    oiOpen: 0,
    oiClose: 0,
  };
}

async function pollSymbol(symbol: string) {
  const now = Date.now();
  const raw = await fetchVeloRaw(symbol, PRICE_RES, now - LOOKBACK_MS, now);
  if (!raw.length) return;

  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  const currentBucketOpen = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const closedRows = sorted.filter((r) => r[0] * 1000 < currentBucketOpen);

  if (!initDone.get(symbol)) {
    initDone.set(symbol, true);
    if (closedRows.length)
      lastClosedEmittedTs.set(symbol, closedRows[closedRows.length - 1][0] * 1000);
    else lastClosedEmittedTs.set(symbol, 0);
  }

  let lastEm = lastClosedEmittedTs.get(symbol) ?? 0;
  for (const row of closedRows) {
    const tOpen = row[0] * 1000;
    if (tOpen > lastEm) {
      barEvents.emit('bar', rowToBar(symbol, row));
      lastEm = tOpen;
      lastClosedEmittedTs.set(symbol, tOpen);
    }
  }

  const formingRow = sorted.find((r) => r[0] * 1000 === currentBucketOpen);
  if (formingRow) {
    const b = rowToBar(symbol, formingRow);
    formingCache.set(symbol, b);
    updatePrice(symbol, b.close);
  } else {
    formingCache.set(symbol, null);
    if (closedRows.length) {
      const last = closedRows[closedRows.length - 1];
      updatePrice(symbol, last[4]);
    }
  }
}

/** Open 1m bar as Velo last returned it (same cadence as Velo updates). */
export function getVeloLiveFormingBar(symbol: string): Bar | null {
  return formingCache.get(symbol) ?? null;
}

export function startVeloLivePoller(initial: string[]) {
  ensureVeloLiveSymbols(initial);
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const s of pollSymbols) {
        try {
          await pollSymbol(s);
        } catch {}
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      running = false;
    }
    setTimeout(tick, VELO_LIVE_POLL_MS);
  }
  console.log(`[velo-live] 1m poller every ${VELO_LIVE_POLL_MS}ms (symbols grow with WS subscribe)`);
  tick();
}
