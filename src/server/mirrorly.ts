import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/mirrorly.json');

function defaultFeedUrl(): string {
  const u = new URL('https://portal.mirrorly.xyz/api/live-trades/feed');
  u.searchParams.set('MinSizeChangePercent', '0.01');
  for (const t of ['New', 'Challenge', 'Consistent Winner', 'Twitter Celeb'])
    u.searchParams.append('IncludeTags', t);
  for (const t of ['Dormant', 'AI Model']) u.searchParams.append('ExcludeTags', t);
  u.searchParams.set('MinTraderProfit', '0.01');
  u.searchParams.set('MinTraderMedianDurationMins', '300');
  u.searchParams.set('MaxTraderMedianDurationMins', '14400');
  return u.toString();
}

const FEED_URL = process.env.MIRRORLY_FEED_URL ?? defaultFeedUrl();

const DETAIL = (id: string) => `https://portal.mirrorly.xyz/api/live-trades/detail/${id}`;
const TRADER_PROFILE_BASE = (process.env.MIRRORLY_TRADER_BASE ?? 'https://portal.mirrorly.xyz/trader').replace(
  /\/$/,
  '',
);
const DAY = 86400000;
const PRUNE_CLOSED_AFTER_MS = 8 * DAY;
const DISPLAY_CLOSED_MS = 7 * DAY;
const RECONCILE_INTERVAL_MS = 120_000;
const RECONCILE_BATCH = 12;
const SAVE_DEBOUNCE_MS = 400;

export type MirrorlyPosition = {
  positionId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  /** USD notional from feed/detail; used to merge multiple open legs into weighted avg entry. */
  positionSize: number;
  /** First fill price (open event); avg may differ after scales. */
  firstEntryPrice: number | null;
  /** Last exit trade price when closed. */
  exitPrice: number | null;
  name: string;
  openedMs: number;
  closedMs: number | null;
  lastSeenMs: number;
  exchangeRef: string;
  exchangeIdentifier: string;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
};

export function mirrorlyProfileUrl(wallet: string): string {
  const w = (wallet || '').trim();
  if (w.startsWith('0x') && w.length === 42) return `${TRADER_PROFILE_BASE}/${encodeURIComponent(w)}`;
  return 'https://portal.mirrorly.xyz/';
}

type DiskShape = { positions: Record<string, MirrorlyPosition> };

function veloBase(chartSymbol: string): string {
  return chartSymbol.replace(/USDT$/i, '').toUpperCase();
}

function mirrorlyInstrumentBase(mlSymbol: string): string {
  const s = mlSymbol.toUpperCase();
  if (s.endsWith('USD')) return s.slice(0, -3);
  if (s.endsWith('USDT')) return s.slice(0, -4);
  return s;
}

function parseMirrorTime(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

function firstAndExitFromDetail(doc: Record<string, unknown>): {
  firstPrice: number | null;
  exitPrice: number | null;
} {
  const ex = doc.executions as { price?: unknown; increase?: boolean }[] | undefined;
  if (!Array.isArray(ex) || ex.length === 0) return { firstPrice: null, exitPrice: null };
  const f = Number(ex[0]?.price);
  const firstPrice = Number.isFinite(f) && f > 0 ? f : null;
  let exitPrice: number | null = null;
  for (let i = ex.length - 1; i >= 0; i--) {
    if (ex[i]?.increase === false) {
      const p = Number(ex[i]?.price);
      if (Number.isFinite(p) && p > 0) exitPrice = p;
      break;
    }
  }
  return { firstPrice, exitPrice };
}

const store = new Map<string, MirrorlyPosition>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function loadDisk() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const d = JSON.parse(raw) as DiskShape;
    if (d?.positions && typeof d.positions === 'object') {
      for (const [k, v] of Object.entries(d.positions)) {
        if (v && typeof v.openedMs === 'number' && v.positionId) {
          const p = v as MirrorlyPosition;
          store.set(k, {
            ...p,
            exchangeRef: p.exchangeRef ?? '',
            exchangeIdentifier: p.exchangeIdentifier ?? '',
            unrealizedPnl: p.unrealizedPnl ?? null,
            realizedPnl: p.realizedPnl ?? null,
            positionSize: typeof p.positionSize === 'number' && p.positionSize >= 0 ? p.positionSize : 0,
            firstEntryPrice:
              p.firstEntryPrice != null && Number.isFinite(p.firstEntryPrice) ? p.firstEntryPrice : null,
            exitPrice: p.exitPrice != null && Number.isFinite(p.exitPrice) ? p.exitPrice : null,
          });
        }
      }
    }
  } catch {
    /* empty */
  }
}

function flushSave() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    const positions: Record<string, MirrorlyPosition> = {};
    for (const [k, v] of store) positions[k] = v;
    fs.writeFileSync(DATA_PATH, JSON.stringify({ positions }, null, 0), 'utf8');
  } catch {
    /* read-only */
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function prune() {
  const cutoff = Date.now() - PRUNE_CLOSED_AFTER_MS;
  for (const [id, p] of store) {
    if (p.closedMs != null && p.closedMs < cutoff) store.delete(id);
  }
}

function applyFeed(obj: Record<string, unknown>) {
  const positionId = String(obj.positionId ?? '');
  if (!positionId) return;
  const type = String(obj.type ?? '');
  const t = parseMirrorTime(String(obj.tradeTimestamp ?? ''));
  if (!t) return;

  const qty = Number(obj.positionQuantity);
  const isClose = type === 'close' || qty === 0;

  const sideRaw = String(obj.side ?? 'long').toLowerCase();
  const side = sideRaw === 'short' ? 'short' : 'long';
  const symbol = String(obj.symbol ?? '');
  const name = String(obj.name ?? '');
  const entryPrice = Number(obj.positionEntryPrice ?? obj.tradePrice ?? 0) || 0;
  const nSz = Number(obj.positionSize);
  const legSize = Number.isFinite(nSz) && nSz > 0 ? nSz : 0;

  const prev = store.get(positionId);
  const exchangeRef = String(obj.exchangeRef ?? prev?.exchangeRef ?? '');
  const exchangeIdentifier = String(obj.exchangeIdentifier ?? prev?.exchangeIdentifier ?? '');
  const nu = Number(obj.positionUnrealizedPnL);
  const nr = Number(obj.positionRealizedPnL);
  const ntp = Number(obj.tradePnL);

  if (isClose) {
    const openedMs = prev?.openedMs ?? t;
    const realizedPnl =
      Number.isFinite(nr) ? nr : Number.isFinite(ntp) ? ntp : prev?.realizedPnl ?? null;
    const tp = Number(obj.tradePrice);
    const exitPrice = Number.isFinite(tp) && tp > 0 ? tp : prev?.exitPrice ?? null;
    const row: MirrorlyPosition = {
      positionId,
      symbol: symbol || prev?.symbol || '',
      side: prev?.side ?? side,
      entryPrice: entryPrice || prev?.entryPrice || 0,
      positionSize: legSize || prev?.positionSize || 0,
      firstEntryPrice: prev?.firstEntryPrice ?? null,
      exitPrice,
      name: name || prev?.name || '',
      openedMs: prev?.openedMs ?? openedMs,
      closedMs: t,
      lastSeenMs: t,
      exchangeRef: exchangeRef || prev?.exchangeRef || '',
      exchangeIdentifier: exchangeIdentifier || prev?.exchangeIdentifier || '',
      unrealizedPnl: null,
      realizedPnl,
    };
    store.set(positionId, row);
    scheduleSave();
    prune();
    return;
  }

  if (prev?.closedMs) return;

  let openedMs = prev?.openedMs ?? 0;
  if (type === 'open' || !openedMs) openedMs = t;

  let firstEntryPrice = prev?.firstEntryPrice ?? null;
  if (type === 'open') {
    const tp = Number(obj.tradePrice);
    firstEntryPrice =
      Number.isFinite(tp) && tp > 0 ? tp : entryPrice > 0 ? entryPrice : firstEntryPrice;
  } else if (firstEntryPrice == null && entryPrice > 0) firstEntryPrice = entryPrice;

  const unrealizedPnl = Number.isFinite(nu) ? nu : prev?.unrealizedPnl ?? null;

  const row: MirrorlyPosition = {
    positionId,
    symbol: symbol || prev?.symbol || '',
    side,
    entryPrice: entryPrice || prev?.entryPrice || 0,
    positionSize: legSize || prev?.positionSize || 0,
    firstEntryPrice,
    exitPrice: null,
    name: name || prev?.name || '',
    openedMs,
    closedMs: null,
    lastSeenMs: t,
    exchangeRef: exchangeRef || prev?.exchangeRef || '',
    exchangeIdentifier: exchangeIdentifier || prev?.exchangeIdentifier || '',
    unrealizedPnl,
    realizedPnl: null,
  };
  store.set(positionId, row);
  scheduleSave();
  prune();
}

async function reconcileOnce() {
  const openIds: string[] = [];
  for (const p of store.values()) {
    if (p.closedMs == null) openIds.push(p.positionId);
  }
  const slice = openIds.slice(0, RECONCILE_BATCH);
  await Promise.all(
    slice.map(async (id) => {
      try {
        const r = await fetch(DETAIL(id), { headers: { Accept: 'application/json' } });
        if (!r.ok) return;
        const doc = (await r.json()) as Record<string, unknown>;
        const prev = store.get(id);
        const sideRaw = String(doc.side ?? prev?.side ?? 'long').toLowerCase();
        const side: 'long' | 'short' = sideRaw === 'short' ? 'short' : 'long';
        let openedMs = doc.opened ? parseMirrorTime(String(doc.opened)) : prev?.openedMs ?? 0;
        if (!openedMs && Array.isArray(doc.executions) && doc.executions[0]) {
          const t0 = (doc.executions[0] as { timestamp?: string }).timestamp;
          if (t0) openedMs = parseMirrorTime(String(t0)) || 0;
        }
        let closedMs: number | null = null;
        if (doc.closed != null && String(doc.closed).length > 0) {
          const c = parseMirrorTime(String(doc.closed));
          if (c > 0) closedMs = c;
        }
        const nup = Number(doc.positionUnrealizedPnL);
        const nrp = Number(doc.positionRealizedPnL);
        const isClosed = closedMs != null;
        const nDocSz = Number(doc.positionSize);
        const docSize =
          !isClosed && Number.isFinite(nDocSz) && nDocSz > 0
            ? nDocSz
            : prev?.positionSize ?? 0;
        const { firstPrice, exitPrice: exExit } = firstAndExitFromDetail(doc);
        const row: MirrorlyPosition = {
          positionId: id,
          symbol: String(doc.symbol ?? prev?.symbol ?? ''),
          side,
          entryPrice: Number(doc.positionEntryPrice ?? prev?.entryPrice ?? 0) || 0,
          positionSize: docSize,
          firstEntryPrice: firstPrice ?? prev?.firstEntryPrice ?? null,
          exitPrice: isClosed ? exExit ?? prev?.exitPrice ?? null : null,
          name: String(doc.name ?? prev?.name ?? ''),
          openedMs: openedMs || prev?.openedMs || Date.now(),
          closedMs: closedMs ?? prev?.closedMs ?? null,
          lastSeenMs: Date.now(),
          exchangeRef: String(doc.exchangeRef ?? prev?.exchangeRef ?? ''),
          exchangeIdentifier: String(doc.exchangeIdentifier ?? prev?.exchangeIdentifier ?? ''),
          unrealizedPnl: isClosed
            ? null
            : Number.isFinite(nup)
              ? nup
              : prev?.unrealizedPnl ?? null,
          realizedPnl: isClosed
            ? Number.isFinite(nrp)
              ? nrp
              : prev?.realizedPnl ?? null
            : null,
        };
        store.set(id, row);
      } catch {
        /* ignore */
      }
    }),
  );
  scheduleSave();
  prune();
}

function scheduleReconcile() {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(async () => {
    reconcileTimer = null;
    try {
      await reconcileOnce();
    } finally {
      scheduleReconcile();
    }
  }, RECONCILE_INTERVAL_MS);
}

function parseSseBlocks(chunk: string, onData: (line: string) => void) {
  const lines = chunk.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('data:')) onData(t.slice(5).trim());
  }
}

async function runFeedLoop() {
  let buf = '';
  try {
    const res = await fetch(FEED_URL, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(String(res.status));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const block of parts) {
        parseSseBlocks(block, (json) => {
          try {
            const obj = JSON.parse(json) as Record<string, unknown>;
            applyFeed(obj);
          } catch {
            /* ignore */
          }
        });
      }
    }
  } catch {
    /* reconnect */
  }
  setTimeout(runFeedLoop, 2500);
}

function chartDedupeKey(p: MirrorlyPosition): string {
  const w = (p.exchangeIdentifier || '').toLowerCase();
  const sym = (p.symbol || '').toUpperCase();
  return `${w}|${sym}`;
}

function mergeOpenMirrorlyGroup(rows: MirrorlyPosition[]): MirrorlyPosition {
  const sorted = [...rows].sort((a, b) => a.openedMs - b.openedMs);
  const anchor = [...sorted].sort((a, b) => b.lastSeenMs - a.lastSeenMs)[0];
  let wSum = 0;
  let pxSum = 0;
  let nBare = 0;
  let bareSum = 0;
  for (const p of sorted) {
    const w = p.positionSize > 0 && Number.isFinite(p.positionSize) ? p.positionSize : 0;
    if (w > 0 && p.entryPrice > 0) {
      wSum += p.entryPrice * w;
      pxSum += w;
    } else if (p.entryPrice > 0) {
      bareSum += p.entryPrice;
      nBare++;
    }
  }
  let entryPrice = anchor.entryPrice;
  if (pxSum > 0) entryPrice = wSum / pxSum;
  else if (nBare > 0) entryPrice = bareSum / nBare;

  const openedMs = Math.min(...sorted.map((r) => r.openedMs));
  const lastSeenMs = Math.max(...sorted.map((r) => r.lastSeenMs));
  const totalSz = sorted.reduce((s, r) => s + (r.positionSize > 0 ? r.positionSize : 0), 0);
  const earliest = sorted[0];
  const firstEntryPrice =
    earliest.firstEntryPrice ?? (earliest.entryPrice > 0 ? earliest.entryPrice : null);
  return {
    positionId: sorted.map((r) => r.positionId).join(','),
    symbol: anchor.symbol,
    side: anchor.side,
    entryPrice,
    positionSize: totalSz || anchor.positionSize,
    firstEntryPrice,
    exitPrice: null,
    name: anchor.name,
    openedMs,
    closedMs: null,
    lastSeenMs,
    exchangeRef: anchor.exchangeRef,
    exchangeIdentifier: anchor.exchangeIdentifier,
    unrealizedPnl: anchor.unrealizedPnl,
    realizedPnl: null,
  };
}

function pickLatestClosedMirrorly(rows: MirrorlyPosition[]): MirrorlyPosition {
  return [...rows].sort((a, b) => (b.closedMs ?? 0) - (a.closedMs ?? 0))[0];
}

export function getMirrorlyForChartSymbol(chartSymbol: string): MirrorlyPosition[] {
  const b = veloBase(chartSymbol);
  const now = Date.now();
  const minClosed = now - DISPLAY_CLOSED_MS;
  const candidates: MirrorlyPosition[] = [];
  for (const p of store.values()) {
    if (mirrorlyInstrumentBase(p.symbol) !== b) continue;
    if (p.closedMs == null) {
      candidates.push(p);
      continue;
    }
    if (p.closedMs >= minClosed) candidates.push(p);
  }
  const byKey = new Map<string, MirrorlyPosition[]>();
  for (const p of candidates) {
    const k = chartDedupeKey(p);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(p);
  }
  const merged: MirrorlyPosition[] = [];
  for (const arr of byKey.values()) {
    const opens = arr.filter((p) => p.closedMs == null);
    const closed = arr.filter((p) => p.closedMs != null);
    if (opens.length > 0)
      merged.push(opens.length === 1 ? opens[0] : mergeOpenMirrorlyGroup(opens));
    else if (closed.length > 0)
      merged.push(closed.length === 1 ? closed[0] : pickLatestClosedMirrorly(closed));
  }
  merged.sort((a, c) => c.openedMs - a.openedMs);
  return merged;
}

export function startMirrorlyIngestion() {
  if (process.env.MIRRORLY_DISABLE === '1') return;
  loadDisk();
  prune();
  void runFeedLoop();
  void reconcileOnce();
  scheduleReconcile();
}
