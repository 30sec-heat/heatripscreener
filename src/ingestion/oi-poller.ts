const BINANCE_FAPI = 'https://fapi.binance.com';

// Shared ban state
export let bannedUntil = 0;

export function checkBanResponse(body: any): boolean {
  if (body?.code === -1003) {
    const match = String(body.msg ?? '').match(/until (\d+)/);
    if (match) {
      bannedUntil = parseInt(match[1]);
      console.log(`[ban] Binance REST banned until ${new Date(bannedUntil).toISOString()}`);
      return true;
    }
  }
  return false;
}

export function isBanned(): boolean {
  return Date.now() < bannedUntil;
}

// In-memory OI state for real-time bar aggregator access
const latestOI = new Map<string, number>(); // symbol -> OI in contracts
const latestOIValue = new Map<string, number>(); // symbol -> OI in USD

export function getLatestOI(symbol: string): number {
  return latestOIValue.get(symbol) ?? 0;
}

// OI OHLC aggregation per symbol per bar bucket
// key = "symbol:tfMs:bucketTs"
interface OIBar { open: number; high: number; low: number; close: number; }
const oiBars = new Map<string, OIBar>();

export function getOIBar(symbol: string, tfMs: number, bucketTs: number): OIBar | null {
  return oiBars.get(`${symbol}:${tfMs}:${bucketTs}`) ?? null;
}

let lastPrune = 0;

export function feedOISample(symbol: string, oiValue: number, ts: number, timeframes: number[]) {
  for (const tf of timeframes) {
    const tfMs = tf * 1000;
    const bucket = Math.floor(ts / tfMs) * tfMs;
    const key = `${symbol}:${tfMs}:${bucket}`;
    const existing = oiBars.get(key);
    if (existing) {
      existing.high = Math.max(existing.high, oiValue);
      existing.low = Math.min(existing.low, oiValue);
      existing.close = oiValue;
    } else {
      oiBars.set(key, { open: oiValue, high: oiValue, low: oiValue, close: oiValue });
    }
  }
  // Prune old entries at most once per minute
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  const cutoff = now - 2 * 3600_000;
  for (const [k] of oiBars) {
    const parts = k.split(':');
    const bts = parseInt(parts[2]);
    if (bts < cutoff) oiBars.delete(k);
  }
}

export function startOIPoller(symbols: string[], timeframes: number[], intervalMs = 5000) {
  async function poll() {
    if (isBanned()) {
      setTimeout(poll, Math.min(bannedUntil - Date.now() + 2000, 60000));
      return;
    }
    const now = Date.now();
    for (const symbol of symbols) {
      try {
        const res = await fetch(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${symbol}`);
        const data = await res.json();
        if (checkBanResponse(data)) break;
        if (data.openInterest) {
          const oi = parseFloat(data.openInterest);
          // Get price to compute USD value
          const price = latestPrice.get(symbol) ?? 0;
          const oiValue = oi * price;

          latestOI.set(symbol, oi);
          latestOIValue.set(symbol, oiValue);

          // Feed into OI OHLC bars
          feedOISample(symbol, oiValue, now, timeframes);
        }
      } catch {}
    }
    setTimeout(poll, isBanned() ? 60000 : intervalMs);
  }

  setTimeout(poll, 2000);
  console.log(`[oi-poller] Polling OI for ${symbols.join(', ')} every ${intervalMs / 1000}s`);
}

// Price feed from aggTrade WS for OI USD conversion
const latestPrice = new Map<string, number>();
export function updatePrice(symbol: string, price: number) {
  latestPrice.set(symbol, price);
}
