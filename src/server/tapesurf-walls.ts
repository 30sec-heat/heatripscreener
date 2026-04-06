/**
 * TapeSurf order-book snapshots → dominant bid/ask “walls” as short horizontal segments
 * for chart overlay (no heatmap).
 */
import avro from 'avsc';
import { Readable } from 'stream';

const TAPESURF_BASE = 'https://api.tapesurf.com/series/order-book';
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_SPAN_MS = 6 * 3600_000;
const CHUNK_MS = 3 * 3600_000;

export type WallSegment = {
  t0: number;
  t1: number;
  price: number;
  side: 'bid' | 'ask';
  usd: number;
};

function floorUtcHourMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0);
}

/**
 * TapeSurf rejects `from` unless it is on a UTC hour boundary.
 * Prefer the right side of the visible window: fetch up to MAX_SPAN_MS ending at `toMs`.
 */
export function alignTapeSurfWindow(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  const end = Math.max(toMs, fromMs + DEFAULT_INTERVAL_MS);
  let start = Math.min(fromMs, end - DEFAULT_INTERVAL_MS);
  start = Math.max(start, end - MAX_SPAN_MS);
  const lo = floorUtcHourMs(start);
  return { fromMs: lo, toMs: end };
}

async function fetchOrderBookAvro(bytes: {
  exchange: string;
  symbol: string;
  fromIso: string;
  toIso: string;
  intervalMs: number;
  step: number;
}): Promise<Buffer> {
  const u = new URL(TAPESURF_BASE);
  u.searchParams.set('exchange', bytes.exchange);
  u.searchParams.set('symbol', bytes.symbol);
  u.searchParams.set('interval', String(bytes.intervalMs));
  u.searchParams.set('step', String(bytes.step));
  u.searchParams.set('from', bytes.fromIso);
  u.searchParams.set('to', bytes.toIso);
  const r = await fetch(u.toString(), {
    headers: { Accept: 'application/json, application/octet-stream, */*' },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`TapeSurf ${r.status}: ${t.slice(0, 200)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function decodeAll(buf: Buffer): Promise<unknown[]> {
  const dec = new avro.streams.BlockDecoder();
  const rows: unknown[] = [];
  dec.on('data', (v: unknown) => rows.push(v));
  return new Promise((resolve, reject) => {
    dec.on('error', reject);
    dec.on('end', () => resolve(rows));
    Readable.from([buf]).pipe(dec);
  });
}

type Level = { price: number; amount: number };

function unwrapBookChange(row: unknown): {
  timestamp: number;
  bids: Level[];
  asks: Level[];
} | null {
  if (!row || typeof row !== 'object') return null;
  const rec = (row as Record<string, unknown>)['com.okotoki.model.BookChange'];
  if (!rec || typeof rec !== 'object') return null;
  const o = rec as Record<string, unknown>;
  const ts = o.timestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const bids = Array.isArray(o.bids) ? (o.bids as Level[]) : [];
  const asks = Array.isArray(o.asks) ? (o.asks as Level[]) : [];
  return { timestamp: ts, bids, asks };
}

function topLevels(levels: Level[], topN: number, minUsd: number): { price: number; usd: number }[] {
  const scored = levels
    .filter((l) => l && l.amount > 0 && Number.isFinite(l.price) && l.price > 0)
    .map((l) => ({ price: l.price, usd: l.price * l.amount }))
    .filter((x) => x.usd >= minUsd)
    .sort((a, b) => b.usd - a.usd);
  const out: { price: number; usd: number }[] = [];
  const seen = new Set<number>();
  for (const x of scored) {
    if (seen.has(x.price)) continue;
    seen.add(x.price);
    out.push(x);
    if (out.length >= topN) break;
  }
  return out;
}

function segmentsFromRows(
  rows: unknown[],
  intervalMs: number,
  topN: number,
  minUsd: number,
): WallSegment[] {
  const segs: WallSegment[] = [];
  for (const row of rows) {
    const bc = unwrapBookChange(row);
    if (!bc) continue;
    const t0 = bc.timestamp;
    const t1 = t0 + intervalMs;
    for (const s of topLevels(bc.bids, topN, minUsd))
      segs.push({ t0, t1, price: s.price, side: 'bid', usd: s.usd });
    for (const s of topLevels(bc.asks, topN, minUsd))
      segs.push({ t0, t1, price: s.price, side: 'ask', usd: s.usd });
  }
  segs.sort((a, b) => a.t0 - b.t0 || a.price - b.price);
  return segs;
}

export async function fetchWallSegments(opts: {
  symbol: string;
  fromMs: number;
  toMs: number;
  exchange?: string;
  step?: number;
  topPerSide?: number;
  minNotionalUsd?: number;
}): Promise<{ segments: WallSegment[]; error?: string }> {
  const exchange = opts.exchange ?? 'Binance';
  const step = opts.step ?? 10;
  const topN = Math.max(1, Math.min(12, opts.topPerSide ?? 4));
  const minUsd = Math.max(0, opts.minNotionalUsd ?? 350_000);

  let { fromMs, toMs } = alignTapeSurfWindow(opts.fromMs, opts.toMs);
  if (toMs <= fromMs) return { segments: [] };

  try {
    const allSegs: WallSegment[] = [];
    for (let start = fromMs; start < toMs; start += CHUNK_MS) {
      const end = Math.min(toMs, start + CHUNK_MS);
      const fromIso = new Date(start).toISOString().replace(/\.\d{3}Z$/, '.000Z');
      const toIso = new Date(end).toISOString().replace(/\.\d{3}Z$/, '.000Z');
      const buf = await fetchOrderBookAvro({
        exchange,
        symbol: opts.symbol,
        fromIso,
        toIso,
        intervalMs: DEFAULT_INTERVAL_MS,
        step,
      });
      const rows = await decodeAll(buf);
      allSegs.push(...segmentsFromRows(rows, DEFAULT_INTERVAL_MS, topN, minUsd));
    }
    return { segments: allSegs };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { segments: [], error: msg };
  }
}
