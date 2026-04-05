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
  name: string;
  openedMs: number;
  closedMs: number | null;
  lastSeenMs: number;
};

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

const store = new Map<string, MirrorlyPosition>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function loadDisk() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const d = JSON.parse(raw) as DiskShape;
    if (d?.positions && typeof d.positions === 'object') {
      for (const [k, v] of Object.entries(d.positions)) {
        if (v && typeof v.openedMs === 'number' && v.positionId) store.set(k, v as MirrorlyPosition);
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

  const prev = store.get(positionId);

  if (isClose) {
    const openedMs = prev?.openedMs ?? (type === 'open' ? t : t);
    const row: MirrorlyPosition = {
      positionId,
      symbol: symbol || prev?.symbol || '',
      side: prev?.side ?? side,
      entryPrice: entryPrice || prev?.entryPrice || 0,
      name: name || prev?.name || '',
      openedMs: prev?.openedMs ?? openedMs,
      closedMs: t,
      lastSeenMs: t,
    };
    store.set(positionId, row);
    scheduleSave();
    prune();
    return;
  }

  if (prev?.closedMs) return;

  let openedMs = prev?.openedMs ?? 0;
  if (type === 'open' || !openedMs) openedMs = t;

  const row: MirrorlyPosition = {
    positionId,
    symbol: symbol || prev?.symbol || '',
    side,
    entryPrice: entryPrice || prev?.entryPrice || 0,
    name: name || prev?.name || '',
    openedMs,
    closedMs: null,
    lastSeenMs: t,
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
        const row: MirrorlyPosition = {
          positionId: id,
          symbol: String(doc.symbol ?? prev?.symbol ?? ''),
          side,
          entryPrice: Number(doc.positionEntryPrice ?? prev?.entryPrice ?? 0) || 0,
          name: String(doc.name ?? prev?.name ?? ''),
          openedMs: openedMs || prev?.openedMs || Date.now(),
          closedMs: closedMs ?? prev?.closedMs ?? null,
          lastSeenMs: Date.now(),
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

export function getMirrorlyForChartSymbol(chartSymbol: string): MirrorlyPosition[] {
  const b = veloBase(chartSymbol);
  const now = Date.now();
  const minClosed = now - DISPLAY_CLOSED_MS;
  const out: MirrorlyPosition[] = [];
  for (const p of store.values()) {
    if (mirrorlyInstrumentBase(p.symbol) !== b) continue;
    if (p.closedMs == null) {
      out.push(p);
      continue;
    }
    if (p.closedMs >= minClosed) out.push(p);
  }
  out.sort((a, c) => c.openedMs - a.openedMs);
  return out;
}

export function startMirrorlyIngestion() {
  if (process.env.MIRRORLY_DISABLE === '1') return;
  loadDisk();
  prune();
  void runFeedLoop();
  void reconcileOnce();
  scheduleReconcile();
}
