import pg from 'pg';
import { DB_CONFIG } from '../shared/config.js';
import type { RawTrade, Bar, LargeTrade } from '../shared/types.js';

function makePool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (url)
    return new pg.Pool({
      connectionString: url,
      max: 10,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  return new pg.Pool(DB_CONFIG);
}

const pool = makePool();

export async function insertTrades(trades: RawTrade[]) {
  if (!trades.length) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const t of trades) {
    placeholders.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6})`);
    values.push(new Date(t.ts), t.symbol, t.exchange, t.price, t.qty, t.isBuyer, t.tradeId);
    idx += 7;
  }
  await pool.query(
    `INSERT INTO trades (ts, symbol, exchange, price, qty, is_buyer, trade_id) VALUES ${placeholders.join(',')} ON CONFLICT DO NOTHING`,
    values
  );
}

export async function upsertBar(bar: Bar) {
  await pool.query(
    `INSERT INTO bars (ts, symbol, exchange, tf_seconds, open, high, low, close, volume, buy_volume, sell_volume, trade_count, cvd, vwap, net_longs, net_shorts, oi_open, oi_close)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (ts, symbol, tf_seconds) DO UPDATE SET
       high = GREATEST(bars.high, $6), low = LEAST(bars.low, $7),
       close = $8, volume = $9, buy_volume = $10, sell_volume = $11,
       trade_count = $12, cvd = $13, vwap = $14, net_longs = $15, net_shorts = $16, oi_open = $17, oi_close = $18`,
    [new Date(bar.ts), bar.symbol, bar.exchange, bar.tfSeconds,
     bar.open, bar.high, bar.low, bar.close,
     bar.volume, bar.buyVolume, bar.sellVolume, bar.tradeCount, bar.cvd, bar.vwap,
     bar.netLongs, bar.netShorts, bar.oiOpen, bar.oiClose]
  );
}

export async function insertLargeTrade(lt: LargeTrade) {
  await pool.query(
    `INSERT INTO large_trades (ts, symbol, exchange, price, qty, notional, is_buyer, classification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [new Date(lt.ts), lt.symbol, lt.exchange, lt.price, lt.qty, lt.notional, lt.isBuyer, lt.classification]
  );
}

export async function insertBookSnapshot(ts: number, symbol: string, bid: number, ask: number, spreadBps: number, bidSize: number, askSize: number) {
  await pool.query(
    `INSERT INTO book_snapshots (ts, symbol, bid, ask, spread_bps, bid_size, ask_size) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [new Date(ts), symbol, bid, ask, spreadBps, bidSize, askSize]
  );
}

export async function queryBars(symbol: string, tfSeconds: number, limit: number, before?: number) {
  const params: any[] = [symbol, tfSeconds, limit];
  let where = 'symbol = $1 AND tf_seconds = $2';
  if (before) { where += ' AND ts < $4'; params.push(new Date(before)); }
  const { rows } = await pool.query(
    `SELECT ts, open, high, low, close, volume, buy_volume, sell_volume, trade_count, cvd, vwap, net_longs, net_shorts, oi_open, oi_close FROM bars WHERE ${where} ORDER BY ts DESC LIMIT $3`,
    params
  );
  return rows.reverse();
}

export async function queryLargeTrades(symbol: string, since: number, limit = 200) {
  const { rows } = await pool.query(
    `SELECT ts, price, qty, notional, is_buyer, classification FROM large_trades WHERE symbol = $1 AND ts >= $2 ORDER BY ts DESC LIMIT $3`,
    [symbol, new Date(since), limit]
  );
  return rows;
}

export async function bulkUpsertBars(barRows: Bar[]) {
  if (!barRows.length) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const b of barRows) {
    placeholders.push(`($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7},$${idx+8},$${idx+9},$${idx+10},$${idx+11},$${idx+12},$${idx+13},$${idx+14},$${idx+15},$${idx+16},$${idx+17})`);
    values.push(new Date(b.ts), b.symbol, b.exchange, b.tfSeconds,
      b.open, b.high, b.low, b.close, b.volume, b.buyVolume, b.sellVolume,
      b.tradeCount, b.cvd, b.vwap, b.netLongs, b.netShorts, b.oiOpen, b.oiClose);
    idx += 18;
  }
  await pool.query(
    `INSERT INTO bars (ts, symbol, exchange, tf_seconds, open, high, low, close, volume, buy_volume, sell_volume, trade_count, cvd, vwap, net_longs, net_shorts, oi_open, oi_close)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (ts, symbol, tf_seconds) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
       volume = EXCLUDED.volume, buy_volume = EXCLUDED.buy_volume, sell_volume = EXCLUDED.sell_volume,
       trade_count = EXCLUDED.trade_count, cvd = EXCLUDED.cvd, vwap = EXCLUDED.vwap,
       net_longs = EXCLUDED.net_longs, net_shorts = EXCLUDED.net_shorts,
       oi_open = EXCLUDED.oi_open, oi_close = EXCLUDED.oi_close`,
    values
  );
}

export { pool };
