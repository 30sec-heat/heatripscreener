export type SlimTicker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};

const UA = { 'User-Agent': 'heat.rip-markets/1 (+https://heat.rip)' };

const FETCH_MS = Math.max(5000, Number(process.env.BINANCE_FETCH_TIMEOUT_MS) || 25_000);

async function fetchBinance(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    return await fetch(url, { headers: UA, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function slimTickerRow(t: {
  symbol: string;
  lastPrice?: string | number;
  priceChangePercent?: string | number;
  quoteVolume?: string | number;
}): SlimTicker {
  return {
    symbol: t.symbol,
    lastPrice: String(t.lastPrice ?? 0),
    priceChangePercent: String(t.priceChangePercent ?? 0),
    quoteVolume: String(t.quoteVolume ?? 0),
  };
}

/** All Binance USDT-M perpetuals (TRADING), merged with 24h stats; missing tickers get zeros. Sorted by quote volume desc. */
export async function fetchPerpUsdtTickerRows(): Promise<SlimTicker[] | null> {
  try {
    const infoR = await fetchBinance('https://fapi.binance.com/fapi/v1/exchangeInfo');
    const info = await infoR.json();
    if (!info?.symbols?.length) return null;
    const syms: string[] = [];
    for (const s of info.symbols) {
      if (
        s.contractType === 'PERPETUAL' &&
        String(s.symbol).endsWith('USDT') &&
        s.status === 'TRADING'
      ) {
        syms.push(s.symbol);
      }
    }
    if (syms.length === 0) return null;

    const tickR = await fetchBinance('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const tick = await tickR.json();
    if (!Array.isArray(tick)) return null;
    const map = new Map<string, any>(tick.map((t: any) => [t.symbol, t]));
    const rows: SlimTicker[] = syms.map((symbol) => {
      const t = map.get(symbol);
      return t ? slimTickerRow(t) : slimTickerRow({ symbol });
    });
    rows.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
    return rows;
  } catch {
    return null;
  }
}
