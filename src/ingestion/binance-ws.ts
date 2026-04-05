import WebSocket from 'ws';
import { BATCH_INSERT_INTERVAL, BATCH_INSERT_MAX, BOOK_SNAPSHOT_INTERVAL } from '../shared/config.js';
import { insertTrades, insertBookSnapshot } from './db.js';
import { processTrade } from './bar-aggregator.js';
import { classifyTrade } from './trade-processor.js';
import { updatePrice } from './oi-poller.js';
import type { RawTrade, BookUpdate } from '../shared/types.js';
import { EventEmitter } from 'events';

export const tradeEvents = new EventEmitter();
export const bookEvents = new EventEmitter();

let tradeBatch: RawTrade[] = [];
let batchTimer: ReturnType<typeof setInterval> | null = null;

function flushBatch() {
  if (!tradeBatch.length) return;
  const batch = tradeBatch;
  tradeBatch = [];
  insertTrades(batch).catch(e => console.error('batch insert error:', e.message));
}

export function startBinanceIngestion(symbols: string[]) {
  // Start batch flusher
  batchTimer = setInterval(flushBatch, BATCH_INSERT_INTERVAL);

  for (const symbol of symbols) {
    connectAggTrade(symbol);
    connectBookTicker(symbol);
  }
}

function connectAggTrade(symbol: string) {
  const url = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@aggTrade`;
  const ws = new WebSocket(url);

  ws.on('open', () => console.log(`[binance] aggTrade connected: ${symbol}`));

  ws.on('message', (raw: Buffer) => {
    const d = JSON.parse(raw.toString());
    const trade: RawTrade = {
      ts: d.T,
      symbol: d.s,
      exchange: 'binance',
      price: parseFloat(d.p),
      qty: parseFloat(d.q),
      isBuyer: !d.m, // m = is_buyer_maker, so buyer = !m
      tradeId: d.a,
    };

    // Buffer for batch DB insert
    tradeBatch.push(trade);
    if (tradeBatch.length >= BATCH_INSERT_MAX) flushBatch();

    // Real-time processing
    processTrade(trade);
    classifyTrade(trade);

    // Feed price to OI poller for USD conversion
    updatePrice(trade.symbol, trade.price);

    // Emit for WS relay
    tradeEvents.emit('trade', trade);
  });

  ws.on('close', () => {
    console.log(`[binance] aggTrade disconnected: ${symbol}, reconnecting...`);
    setTimeout(() => connectAggTrade(symbol), 2000);
  });
  ws.on('error', (e) => { console.error(`[binance] aggTrade error ${symbol}:`, e.message); ws.close(); });
}

// Book state per symbol for snapshot sampling
const bookState = new Map<string, { bid: number; ask: number; bidSize: number; askSize: number; lastSnapshot: number }>();

function connectBookTicker(symbol: string) {
  const url = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@bookTicker`;
  const ws = new WebSocket(url);

  ws.on('message', (raw: Buffer) => {
    const d = JSON.parse(raw.toString());
    const bid = parseFloat(d.b), ask = parseFloat(d.a);
    const bidSize = parseFloat(d.B), askSize = parseFloat(d.A);
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;

    const update: BookUpdate = { symbol: d.s, bid, ask, bidSize, askSize, spreadBps };
    bookEvents.emit('book', update);

    // Sample to DB
    let state = bookState.get(symbol);
    if (!state) { state = { bid, ask, bidSize, askSize, lastSnapshot: 0 }; bookState.set(symbol, state); }
    state.bid = bid; state.ask = ask; state.bidSize = bidSize; state.askSize = askSize;
    const now = Date.now();
    if (now - state.lastSnapshot >= BOOK_SNAPSHOT_INTERVAL) {
      state.lastSnapshot = now;
      insertBookSnapshot(now, symbol, bid, ask, spreadBps, bidSize, askSize).catch(() => {});
    }
  });

  ws.on('close', () => {
    console.log(`[binance] bookTicker disconnected: ${symbol}, reconnecting...`);
    setTimeout(() => connectBookTicker(symbol), 2000);
  });
  ws.on('error', (e) => { console.error(`[binance] bookTicker error ${symbol}:`, e.message); ws.close(); });
}
