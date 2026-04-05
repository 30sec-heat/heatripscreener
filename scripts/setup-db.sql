-- heat.rip / heatripscreener database
CREATE DATABASE heatrip;
\c heatrip

-- Tick-level trades, partitioned by day (7-day retention)
CREATE TABLE trades (
  ts          TIMESTAMPTZ NOT NULL,
  symbol      TEXT NOT NULL,
  exchange    TEXT NOT NULL DEFAULT 'binance',
  price       DOUBLE PRECISION NOT NULL,
  qty         DOUBLE PRECISION NOT NULL,
  is_buyer    BOOLEAN NOT NULL,
  trade_id    BIGINT
) PARTITION BY RANGE (ts);

CREATE INDEX idx_trades_sym_ts ON trades (symbol, ts);

-- Create partitions for the next 14 days
DO $$
DECLARE
  d DATE := CURRENT_DATE;
BEGIN
  FOR i IN 0..13 LOOP
    EXECUTE format(
      'CREATE TABLE trades_%s PARTITION OF trades FOR VALUES FROM (%L) TO (%L)',
      to_char(d + i, 'YYYYMMDD'),
      (d + i)::timestamp,
      (d + i + 1)::timestamp
    );
  END LOOP;
END $$;

-- Pre-aggregated OHLCV + CVD bars
CREATE TABLE bars (
  ts          TIMESTAMPTZ NOT NULL,
  symbol      TEXT NOT NULL,
  exchange    TEXT NOT NULL DEFAULT 'binance',
  tf_seconds  INT NOT NULL,
  open        DOUBLE PRECISION,
  high        DOUBLE PRECISION,
  low         DOUBLE PRECISION,
  close       DOUBLE PRECISION,
  volume      DOUBLE PRECISION DEFAULT 0,
  buy_volume  DOUBLE PRECISION DEFAULT 0,
  sell_volume DOUBLE PRECISION DEFAULT 0,
  trade_count INT DEFAULT 0,
  cvd         DOUBLE PRECISION DEFAULT 0,
  vwap        DOUBLE PRECISION DEFAULT 0,
  PRIMARY KEY (ts, symbol, tf_seconds)
);

CREATE INDEX idx_bars_lookup ON bars (symbol, tf_seconds, ts);

-- Large trade / whale detections
CREATE TABLE large_trades (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  symbol          TEXT NOT NULL,
  exchange        TEXT NOT NULL DEFAULT 'binance',
  price           DOUBLE PRECISION,
  qty             DOUBLE PRECISION,
  notional        DOUBLE PRECISION,
  is_buyer        BOOLEAN,
  classification  TEXT DEFAULT 'whale'
);

CREATE INDEX idx_large_trades_sym_ts ON large_trades (symbol, ts);

-- Options snapshots from Deribit
CREATE TABLE options_snapshots (
  ts              TIMESTAMPTZ NOT NULL,
  underlying      TEXT NOT NULL,
  atm_iv          DOUBLE PRECISION,
  iv_skew_25d     DOUBLE PRECISION,
  put_call_ratio  DOUBLE PRECISION,
  total_oi        DOUBLE PRECISION,
  max_pain        DOUBLE PRECISION,
  net_gamma       DOUBLE PRECISION,
  PRIMARY KEY (ts, underlying)
);

-- Book snapshots (sampled every ~5s)
CREATE TABLE book_snapshots (
  ts          TIMESTAMPTZ NOT NULL,
  symbol      TEXT NOT NULL,
  bid         DOUBLE PRECISION,
  ask         DOUBLE PRECISION,
  spread_bps  DOUBLE PRECISION,
  bid_size    DOUBLE PRECISION,
  ask_size    DOUBLE PRECISION,
  PRIMARY KEY (ts, symbol)
);

CREATE INDEX idx_book_sym_ts ON book_snapshots (symbol, ts);
