import WebSocket from 'ws';
import { processTrade } from './bar-aggregator.js';
import { classifyTrade } from './trade-processor.js';
import { updatePrice } from './oi-poller.js';
import type { RawTrade, BookUpdate } from '../shared/types.js';
import { EventEmitter } from 'events';

export const tradeEvents = new EventEmitter();
export const bookEvents = new EventEmitter();

export function startBinanceIngestion(symbols: string[]) {
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
      isBuyer: !d.m,
      tradeId: d.a,
    };

    processTrade(trade);
    classifyTrade(trade);
    updatePrice(trade.symbol, trade.price);
    tradeEvents.emit('trade', trade);
  });

  ws.on('close', () => {
    console.log(`[binance] aggTrade disconnected: ${symbol}, reconnecting...`);
    setTimeout(() => connectAggTrade(symbol), 2000);
  });
  ws.on('error', (e) => {
    console.error(`[binance] aggTrade error ${symbol}:`, e.message);
    ws.close();
  });
}

function connectBookTicker(symbol: string) {
  const url = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@bookTicker`;
  const ws = new WebSocket(url);

  ws.on('message', (raw: Buffer) => {
    const d = JSON.parse(raw.toString());
    const bid = parseFloat(d.b),
      ask = parseFloat(d.a);
    const bidSize = parseFloat(d.B),
      askSize = parseFloat(d.A);
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : 0;

    bookEvents.emit('book', { symbol: d.s, bid, ask, bidSize, askSize, spreadBps } as BookUpdate);
  });

  ws.on('close', () => {
    console.log(`[binance] bookTicker disconnected: ${symbol}, reconnecting...`);
    setTimeout(() => connectBookTicker(symbol), 2000);
  });
  ws.on('error', (e) => {
    console.error(`[binance] bookTicker error ${symbol}:`, e.message);
    ws.close();
  });
}
