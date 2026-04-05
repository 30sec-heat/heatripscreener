import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { barEvents, getCurrentBar } from '../ingestion/bar-aggregator.js';
import { ensureVeloLiveSymbols, getVeloLiveFormingBar } from '../ingestion/velo-live-bars.js';
import type { Bar } from '../shared/types.js';

interface ClientState {
  symbols: Set<string>;
  timeframes: Set<number>;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.set(ws, { symbols: new Set(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']), timeframes: new Set([15, 60]) });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const state = clients.get(ws);
        if (!state) return;
        if (msg.subscribe) {
          state.symbols = new Set(msg.subscribe);
          ensureVeloLiveSymbols(msg.subscribe);
        }
        if (msg.timeframes) state.timeframes = new Set(msg.timeframes);
      } catch {}
    });

    ws.on('close', () => clients.delete(ws));
  });

  function broadcast(symbol: string, data: any, tfFilter?: number) {
    const msg = JSON.stringify(data);
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!state.symbols.has(symbol)) continue;
      if (tfFilter !== undefined && !state.timeframes.has(tfFilter)) continue;
      ws.send(msg);
    }
  }

  barEvents.on('bar', (b: Bar) => {
    broadcast(b.symbol, { type: 'bar', symbol: b.symbol, tf: b.tfSeconds, bar: b }, b.tfSeconds);
  });

  setInterval(() => {
    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      for (const symbol of state.symbols) {
        for (const tf of state.timeframes) {
          const bar = tf === 60 ? getVeloLiveFormingBar(symbol) : getCurrentBar(symbol, tf);
          if (bar) ws.send(JSON.stringify({ type: 'bar_update', symbol, tf, bar }));
        }
      }
    }
  }, 1000);
}
