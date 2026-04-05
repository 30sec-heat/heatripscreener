import { bulkUpsertBars, pool } from './db.js';
import type { Bar } from '../shared/types.js';
import { fetchVelo, sleep, ALL_EXCHANGES } from '../shared/velo.js';
import type { VeloBar } from '../shared/velo.js';

const EXCHANGES = ALL_EXCHANGES;

function tfToVeloRes(tf: number): number {
  if (tf <= 60) return 1;
  if (tf <= 300) return 5;
  if (tf <= 900) return 15;
  return 60;
}

function maxRangeMs(resolution: number): number {
  if (resolution === 1) return 7 * 3600_000;
  if (resolution === 5) return 24 * 3600_000;
  return 72 * 3600_000;
}

function oiSymbol(symbol: string, exchange: string): string {
  return `${symbol}#${exchange}#open_interest#aggregated#USD#Candles`;
}

// Fetch OI for each exchange, compute per-exchange net L/S using inter-bar deltas, then sum
async function fetchAndComputeNetLS(
  symbol: string, resolution: number, begin: number, end: number, priceBars: VeloBar[]
): Promise<{ netLongs: number[]; netShorts: number[]; oiValues: number[] }> {
  // Build price map by timestamp for quick lookup
  const priceByTs = new Map<number, { o: number; c: number }>();
  for (const p of priceBars) priceByTs.set(p.t, { o: p.o, c: p.c });
  const timestamps = priceBars.map(p => p.t);

  // Accumulate net L/S across all exchanges
  const totalLongs = new Array(timestamps.length).fill(0);
  const totalShorts = new Array(timestamps.length).fill(0);
  const totalOI = new Array(timestamps.length).fill(0);

  for (const exchange of EXCHANGES) {
    const oiSym = oiSymbol(symbol, exchange);
    let oiBars: VeloBar[];
    try {
      oiBars = await fetchVelo(oiSym, resolution, begin, end);
    } catch { continue; }
    if (!oiBars.length) continue;
    await sleep(200);

    // Map OI values by timestamp
    const oiByTs = new Map<number, number>();
    for (const oi of oiBars) {
      // Velo OI: open==close, so just use close. Value is in coins.
      oiByTs.set(oi.t, oi.c);
    }

    // Compute per-exchange net L/S using inter-bar OI delta
    let cumLongs = 0, cumShorts = 0;
    let lastDayStart = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const price = priceByTs.get(ts);
      const curOI = oiByTs.get(ts);
      if (!price || curOI === undefined) continue;

      // Add to total OI (in coins * price for USD)
      totalOI[i] += curOI * price.c;

      if (i === 0) continue;

      const prevTs = timestamps[i - 1];
      const prevOI = oiByTs.get(prevTs);
      if (prevOI === undefined) continue;

      // OI delta in USD
      const oiDeltaUSD = (curOI * price.c) - (prevOI * priceByTs.get(prevTs)!.c);
      const priceChg = price.o - price.c; // positive = price went down

      // Reset daily
      const dayStart = Math.floor(ts / 86400000) * 86400000;
      if (dayStart !== lastDayStart) {
        cumLongs = 0; cumShorts = 0;
        lastDayStart = dayStart;
      }

      // Quadrants: price Δ vs OI Δ USD
      if (priceChg > 0 && oiDeltaUSD < 0) cumLongs += oiDeltaUSD;       // price down, OI down → longs closing
      else if (priceChg < 0 && oiDeltaUSD > 0) cumLongs += oiDeltaUSD;  // price up, OI up → longs opening
      else if (priceChg > 0 && oiDeltaUSD > 0) cumShorts += oiDeltaUSD;  // price down, OI up → shorts opening
      else if (priceChg < 0 && oiDeltaUSD < 0) cumShorts += oiDeltaUSD;  // price up, OI down → shorts closing

      totalLongs[i] += cumLongs;
      totalShorts[i] += cumShorts;
    }
  }

  return { netLongs: totalLongs, netShorts: totalShorts, oiValues: totalOI };
}

export async function backfillSymbol(symbol: string, tfSeconds: number, hoursBack: number) {
  const now = Date.now();
  const startTime = now - hoursBack * 3600_000;
  const resolution = tfToVeloRes(tfSeconds);
  const chunkMs = maxRangeMs(resolution);

  console.log(`[backfill] ${symbol} ${resolution}m via velo.xyz (${hoursBack}h)`);

  // Fetch price bars (paginated)
  let allPrice: VeloBar[] = [];
  for (let cursor = startTime; cursor < now; cursor += chunkMs) {
    const end = Math.min(cursor + chunkMs, now);
    const batch = await fetchVelo(symbol, resolution, cursor, end);
    allPrice.push(...batch);
    await sleep(300);
  }

  if (!allPrice.length) {
    console.log(`[backfill] ${symbol}: no price data`);
    return 0;
  }

  // Fetch per-exchange OI and compute aggregated net L/S
  const { netLongs, netShorts, oiValues } = await fetchAndComputeNetLS(
    symbol, resolution, startTime, now, allPrice
  );

  console.log(`[backfill] ${symbol}: ${allPrice.length} bars, computing net L/S across ${EXCHANGES.length} exchanges`);

  // Build bar rows
  const barRows: Bar[] = [];
  for (let i = 0; i < allPrice.length; i++) {
    const p = allPrice[i];
    barRows.push({
      ts: p.t, symbol, exchange: 'binance', tfSeconds,
      open: p.o, high: p.h, low: p.l, close: p.c,
      volume: p.v, buyVolume: p.v * 0.5, sellVolume: p.v * 0.5,
      tradeCount: 0, cvd: 0, vwap: (p.h + p.l + p.c) / 3,
      netLongs: netLongs[i], netShorts: netShorts[i],
      oiOpen: oiValues[i], oiClose: oiValues[i],
    });
  }

  // Bulk upsert
  for (let i = 0; i < barRows.length; i += 100) {
    await bulkUpsertBars(barRows.slice(i, i + 100));
  }

  const nlNonZero = barRows.filter(b => b.netLongs !== 0).length;
  const nsNonZero = barRows.filter(b => b.netShorts !== 0).length;
  console.log(`[backfill] ${symbol} ${resolution}m: ${barRows.length} bars, longs=${nlNonZero} shorts=${nsNonZero}`);
  return barRows.length;
}

// Track what's already been backfilled to avoid re-fetching
const backfilled = new Set<string>();

export async function backfillIfNeeded(symbol: string, tfSeconds: number) {
  const key = `${symbol}:${tfSeconds}`;
  if (backfilled.has(key)) return;
  backfilled.add(key);

  // Check if we have recent data
  const { rows } = await pool.query(
    `SELECT count(*) as cnt FROM bars WHERE symbol=$1 AND tf_seconds=$2 AND ts > NOW() - INTERVAL '1 hour'`,
    [symbol, tfSeconds]
  );
  if (parseInt(rows[0].cnt) > 30) return; // already have data

  try {
    await backfillSymbol(symbol, tfSeconds, 7);
  } catch (e: any) {
    console.error(`[backfill] ${symbol} tf=${tfSeconds} failed:`, e.message);
    backfilled.delete(key); // allow retry
  }
}

