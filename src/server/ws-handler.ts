import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { tradeEvents, bookEvents } from '../ingestion/binance-ws.js';
import { barEvents, getCurrentBar } from '../ingestion/bar-aggregator.js';
import { whaleEvents } from '../ingestion/trade-processor.js';
import type { RawTrade, Bar, BookUpdate, LargeTrade } from '../shared/types.js';

interface ClientState {
  symbols: Set<string>;
  timeframes: Set<number>;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    // Default: subscribe to everything
    clients.set(ws, { symbols: new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']), timeframes: new Set([15, 60]) });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const state = clients.get(ws);
        if (!state) return;
        if (msg.subscribe) state.symbols = new Set(msg.subscribe);
        if (msg.timeframes) state.timeframes = new Set(msg.timeframes);
      } catch {}
    });

    ws.on('close', () => clients.delete(ws));
  });

  // Relay events to subscribed clients
  function broadcast(symbol: string, data: any, tfFilter?: number) {
    const msg = JSON.stringify(data);
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!state.symbols.has(symbol)) continue;
      if (tfFilter !== undefined && !state.timeframes.has(tfFilter)) continue;
      ws.send(msg);
    }
  }

  tradeEvents.on('trade', (t: RawTrade) => {
    broadcast(t.symbol, { type: 'trade', symbol: t.symbol, price: t.price, qty: t.qty, isBuyer: t.isBuyer, ts: t.ts });
  });

  barEvents.on('bar', (b: Bar) => {
    broadcast(b.symbol, { type: 'bar', symbol: b.symbol, tf: b.tfSeconds, bar: b }, b.tfSeconds);
  });

  bookEvents.on('book', (u: BookUpdate) => {
    broadcast(u.symbol, { type: 'book', ...u });
  });

  whaleEvents.on('whale', (lt: LargeTrade) => {
    broadcast(lt.symbol, { type: 'whale', ...lt });
  });

  // Send current bar snapshots every second for open bars
  setInterval(() => {
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      for (const symbol of state.symbols) {
        for (const tf of state.timeframes) {
          const bar = getCurrentBar(symbol, tf);
          if (bar) ws.send(JSON.stringify({ type: 'bar_update', symbol, tf, bar }));
        }
      }
    }
  }, 1000);
}
