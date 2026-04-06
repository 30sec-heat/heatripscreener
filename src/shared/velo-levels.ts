import zlib from 'zlib';

const VELO_LEVELS = 'https://velo.xyz/api/l/levels';

const HEADERS = {
  Accept: 'application/octet-stream',
  'User-Agent': 'heat.rip-levels/1 (+https://heat.rip)',
};

function fetchSignal(): AbortSignal {
  const to = (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout;
  const ms = Math.max(8000, Number(process.env.VELO_FETCH_MS) || 40_000);
  if (typeof to === 'function') return to(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

export interface VeloLevelsParsed {
  version: number;
  meta: string;
  prices: number[];
  rowCount: number;
  subBytes: number;
  grid: Uint8Array;
}

/**
 * Velo `/api/l/levels` body (after optional gzip): u32 version, NUL meta string,
 * u32 priceCsvLen, ASCII price ladder (commas), opaque prefix whose length is
 * `remainder % nPrices`, then `rowCount * nPrices` uint8 liquidity/depth cells (row-major, time × price).
 * Format inferred only from live responses — not from third-party clients.
 */
export function parseVeloLevelsBinary(buf: Buffer): VeloLevelsParsed {
  let i = 0;
  if (buf.length < 16) throw new Error('levels too short');
  const version = buf.readUInt32LE(i);
  i += 4;
  let j = i;
  while (j < buf.length && buf[j] !== 0) j++;
  const meta = buf.slice(i, j).toString('utf8');
  i = j + 1;
  if (i + 4 > buf.length) throw new Error('levels truncated');
  const priceStrLen = buf.readUInt32LE(i);
  i += 4;
  if (i + priceStrLen > buf.length) throw new Error('levels bad price len');
  const priceStr = buf.slice(i, i + priceStrLen).toString('utf8');
  i += priceStrLen;
  const prices = priceStr.length
    ? priceStr.split(',').map((x) => Number(x)).filter((n) => Number.isFinite(n))
    : [];
  if (prices.length === 0) throw new Error('levels no prices');

  const remaining = buf.length - i;
  const subBytes = remaining % prices.length;
  const rowCount = (remaining - subBytes) / prices.length;
  if (!Number.isInteger(rowCount) || rowCount < 1) throw new Error('levels bad grid size');

  const gridOff = i + subBytes;
  const gridLen = rowCount * prices.length;
  if (gridOff + gridLen > buf.length) throw new Error('levels grid overflow');
  const grid = Uint8Array.from(buf.subarray(gridOff, gridOff + gridLen));
  return { version, meta, prices, rowCount, subBytes, grid };
}

export async function fetchVeloLevelsBuffer(
  symbol: string,
  begin: number,
  end: number,
  spread = 1,
): Promise<Buffer> {
  const u = new URL(VELO_LEVELS);
  u.searchParams.set('bin', '1');
  u.searchParams.set('exchange', 'binance-futures');
  u.searchParams.set('product', symbol);
  u.searchParams.set('begin', String(Math.floor(begin)));
  u.searchParams.set('end', String(Math.floor(end)));
  u.searchParams.set('reso', '1');
  u.searchParams.set('spread', String(Math.max(1, Math.min(50, spread | 0)) || 1));
  const res = await fetch(u.toString(), { headers: HEADERS, signal: fetchSignal() });
  if (!res.ok) throw new Error(`velo levels http ${res.status}`);
  let raw = Buffer.from(await res.arrayBuffer());
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  return raw;
}
