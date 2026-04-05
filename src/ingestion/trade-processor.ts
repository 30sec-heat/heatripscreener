import { WHALE_THRESHOLDS } from '../shared/config.js';
import { insertLargeTrade } from './db.js';
import type { RawTrade, LargeTrade } from '../shared/types.js';
import { EventEmitter } from 'events';

export const whaleEvents = new EventEmitter();

// TWAP detection: track recent trades per symbol+side
interface RecentFill { ts: number; qty: number; price: number; }
const recentFills = new Map<string, RecentFill[]>();
const TWAP_WINDOW = 30_000; // 30s
const TWAP_MIN_COUNT = 3;
const TWAP_QTY_TOLERANCE = 0.15; // 15% qty variance

export function classifyTrade(trade: RawTrade): LargeTrade | null {
  const notional = trade.price * trade.qty;
  const threshold = WHALE_THRESHOLDS[trade.symbol] ?? WHALE_THRESHOLDS.DEFAULT;

  if (notional < threshold) return null;

  // Check for TWAP pattern
  const sideKey = `${trade.symbol}:${trade.isBuyer ? 'buy' : 'sell'}`;
  let fills = recentFills.get(sideKey);
  if (!fills) { fills = []; recentFills.set(sideKey, fills); }

  // Prune old
  fills = fills.filter(f => trade.ts - f.ts < TWAP_WINDOW);
  fills.push({ ts: trade.ts, qty: trade.qty, price: trade.price });
  recentFills.set(sideKey, fills);

  let classification = 'whale';
  if (fills.length >= TWAP_MIN_COUNT) {
    const avgQty = fills.reduce((s, f) => s + f.qty, 0) / fills.length;
    const allSimilar = fills.every(f => Math.abs(f.qty - avgQty) / avgQty < TWAP_QTY_TOLERANCE);
    if (allSimilar) classification = 'twap_suspected';
  }

  const lt: LargeTrade = {
    ts: trade.ts,
    symbol: trade.symbol,
    exchange: trade.exchange,
    price: trade.price,
    qty: trade.qty,
    notional,
    isBuyer: trade.isBuyer,
    classification,
  };

  insertLargeTrade(lt).catch(e => console.error('large trade insert error:', e.message));
  whaleEvents.emit('whale', lt);
  return lt;
}
