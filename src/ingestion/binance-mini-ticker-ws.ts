import WebSocket from 'ws';
import type { SlimTicker } from '../shared/binance-markets.js';

const MINI_URL = 'wss://fstream.binance.com/ws/!miniTicker@arr';

type Live = { c: number; o: number; q: number };
const bySym = new Map<string, Live>();

/** Merge live all-markets mini tickers into REST snapshot rows (prices + 24h % from o/c + quote vol). */
export function applyLiveTickerOverlay(rows: SlimTicker[]): SlimTicker[] {
  return rows.map((r) => {
    const L = bySym.get(r.symbol);
    if (!L || !Number.isFinite(L.c)) return r;
    const pct =
      L.o && L.o !== 0 ? ((L.c - L.o) / L.o) * 100 : parseFloat(r.priceChangePercent) || 0;
    return {
      ...r,
      lastPrice: String(L.c),
      priceChangePercent: String(pct),
      quoteVolume:
        Number.isFinite(L.q) && L.q >= 0 ? String(L.q) : r.quoteVolume,
    };
  });
}

export function startBinanceMiniTickerWs() {
  function connect() {
    const ws = new WebSocket(MINI_URL);
    ws.on('message', (buf) => {
      try {
        const arr = JSON.parse(buf.toString());
        if (!Array.isArray(arr)) return;
        for (const x of arr) {
          if (!x?.s || x.c == null || x.o == null) continue;
          const c = parseFloat(String(x.c));
          const o = parseFloat(String(x.o));
          const q = x.q != null ? parseFloat(String(x.q)) : NaN;
          if (!Number.isFinite(c)) continue;
          bySym.set(String(x.s).toUpperCase(), {
            c,
            o: Number.isFinite(o) ? o : c,
            q: Number.isFinite(q) ? q : 0,
          });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => setTimeout(connect, 2500));
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  connect();
  console.log('[binance-mini] !miniTicker@arr → live sidebar prices');
}
