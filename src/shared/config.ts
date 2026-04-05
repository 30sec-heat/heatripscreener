export const DB_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'heatrip',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  max: 10,
};

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

export const TIMEFRAMES = [1, 5, 15, 60, 300]; // seconds

export const WHALE_THRESHOLDS: Record<string, number> = {
  BTCUSDT: 50_000,   // $50K notional
  ETHUSDT: 25_000,
  DEFAULT: 10_000,
};

/** HTTP listen port (Railway sets PORT). */
export const SERVER_PORT = Number(process.env.PORT) || 4446;

export const BATCH_INSERT_INTERVAL = 500; // ms
export const BATCH_INSERT_MAX = 200;      // trades per batch
export const BOOK_SNAPSHOT_INTERVAL = 5000; // ms
