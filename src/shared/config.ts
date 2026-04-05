export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

export const TIMEFRAMES = [1, 5, 15, 60, 300]; // seconds

export const WHALE_THRESHOLDS: Record<string, number> = {
  BTCUSDT: 50_000,   // $50K notional
  ETHUSDT: 25_000,
  DEFAULT: 10_000,
};

/** HTTP listen port (Railway sets PORT). */
export const SERVER_PORT = Number(process.env.PORT) || 4446;
