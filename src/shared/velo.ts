const VELO_API = 'https://velo.xyz/api/m/range';

export const ALL_EXCHANGES = ['binance-futures', 'bybit', 'okex-swap', 'deribit', 'hyperliquid'];

/**
 * Velo `symbol` for OI OHLC: `BASE#ex1#ex2#…#open_interest#aggregated#USD#Candles`.
 * - Several venues in the chain → **one** response row per minute (sum across those venues).
 * - **Per-venue series** → one `/api/m/range` call per venue with `exchanges.length === 1`.
 */
export function buildCompoundOISymbol(base: string, exchanges: readonly string[]): string {
  return `${base}#${exchanges.join('#')}#open_interest#aggregated#USD#Candles`;
}

/** Single-venue compound chain — split view uses one of these per exchange (parallel requests). */
export function buildPerVenueOISymbol(base: string, exchange: string): string {
  return buildCompoundOISymbol(base, [exchange]);
}

/** All tracked linear venues in one chain — aggregated OI (one HTTP request). */
export function buildAggregatedOISymbol(base: string): string {
  return buildCompoundOISymbol(base, ALL_EXCHANGES);
}

export interface VeloBar { t: number; o: number; h: number; l: number; c: number; v: number; }

const VELO_FETCH_MS = Math.max(8000, Number(process.env.VELO_FETCH_MS) || 40_000);

const VELO_FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'heat.rip-chart/1 (+https://heat.rip)',
};

function veloFetchSignal(): AbortSignal {
  const to = (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout;
  if (typeof to === 'function') return to(VELO_FETCH_MS);
  const c = new AbortController();
  setTimeout(() => c.abort(), VELO_FETCH_MS);
  return c.signal;
}

/**
 * Velo `/m/range` returns **400** (empty body) when `resolution=1` and the ms span is too large
 * (~≥460 minutes of 1m bars). Chunk and merge so long history works from any host (not a “cloud IP” issue).
 */
const DEFAULT_MAX_CHUNK_MS = 450 * 60 * 1000;
const VELO_MAX_CHUNK_MS = Math.max(120 * 60 * 1000, Number(process.env.VELO_MAX_CHUNK_MS) || DEFAULT_MAX_CHUNK_MS);

async function fetchVeloRawOnce(
  symbol: string,
  resolution: number,
  begin: number,
  end: number,
): Promise<number[][]> {
  const url = `${VELO_API}?exchange=binance-futures&symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&begin=${begin}&end=${end}`;
  try {
    const res = await fetch(url, {
      signal: veloFetchSignal(),
      headers: VELO_FETCH_HEADERS,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.arr ?? [];
  } catch {
    return [];
  }
}

export async function fetchVeloRaw(symbol: string, resolution: number, begin: number, end: number): Promise<number[][]> {
  if (end <= begin) return [];
  if (end - begin <= VELO_MAX_CHUNK_MS) return fetchVeloRawOnce(symbol, resolution, begin, end);

  const windows: { b: number; e: number }[] = [];
  for (let b = begin; b < end; b += VELO_MAX_CHUNK_MS) {
    windows.push({ b, e: Math.min(end, b + VELO_MAX_CHUNK_MS) });
  }
  const parts = await Promise.all(
    windows.map(({ b, e }) => fetchVeloRawOnce(symbol, resolution, b, e)),
  );
  const byOpenSec = new Map<number, number[]>();
  for (const rows of parts) {
    for (const row of rows) byOpenSec.set(row[0], row);
  }
  return [...byOpenSec.keys()].sort((a, b) => a - b).map((t) => byOpenSec.get(t)!);
}

export async function fetchVelo(symbol: string, resolution: number, begin: number, end: number): Promise<VeloBar[]> {
  const arr = await fetchVeloRaw(symbol, resolution, begin, end);
  return arr.map((r: number[]) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0 }));
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
