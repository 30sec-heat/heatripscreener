const VELO_API = 'https://velo.xyz/api/m/range';

export const ALL_EXCHANGES = ['binance-futures', 'bybit', 'okex-swap', 'deribit', 'hyperliquid'];

export interface VeloBar { t: number; o: number; h: number; l: number; c: number; v: number; }

export async function fetchVeloRaw(symbol: string, resolution: number, begin: number, end: number): Promise<number[][]> {
  const url = `${VELO_API}?exchange=binance-futures&symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&begin=${begin}&end=${end}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.arr ?? [];
}

export async function fetchVelo(symbol: string, resolution: number, begin: number, end: number): Promise<VeloBar[]> {
  const arr = await fetchVeloRaw(symbol, resolution, begin, end);
  return arr.map((r: number[]) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0 }));
}

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
