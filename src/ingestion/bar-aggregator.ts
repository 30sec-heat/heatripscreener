import { TIMEFRAMES } from '../shared/config.js';
import { upsertBar } from './db.js';
import { getOIBar } from './oi-poller.js';
import type { Bar, RawTrade } from '../shared/types.js';
import { EventEmitter } from 'events';

interface LiveBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  vwapNum: number;
  vwapDen: number;
}

const cvdMap = new Map<string, number>();
const openBars = new Map<string, LiveBar>();

// Net longs/shorts cumulative state per symbol:tf (resets daily)
const netLongsMap = new Map<string, number>();
const netShortsMap = new Map<string, number>();
const lastDayMap = new Map<string, number>();

export const barEvents = new EventEmitter();

function bucket(ts: number, tfMs: number) {
  return Math.floor(ts / tfMs) * tfMs;
}

export function processTrade(trade: RawTrade) {
  for (const tf of TIMEFRAMES) {
    const tfMs = tf * 1000;
    const key = `${trade.symbol}:${tf}`;
    const bk = bucket(trade.ts, tfMs);
    const existing = openBars.get(key);

    if (existing && existing.ts === bk) {
      existing.high = Math.max(existing.high, trade.price);
      existing.low = Math.min(existing.low, trade.price);
      existing.close = trade.price;
      existing.volume += trade.qty;
      if (trade.isBuyer) existing.buyVolume += trade.qty;
      else existing.sellVolume += trade.qty;
      existing.tradeCount++;
      existing.vwapNum += trade.price * trade.qty;
      existing.vwapDen += trade.qty;
    } else {
      if (existing) flushBar(trade.symbol, tf, existing);
      openBars.set(key, {
        ts: bk, open: trade.price, high: trade.price, low: trade.price, close: trade.price,
        volume: trade.qty,
        buyVolume: trade.isBuyer ? trade.qty : 0,
        sellVolume: trade.isBuyer ? 0 : trade.qty,
        tradeCount: 1,
        vwapNum: trade.price * trade.qty, vwapDen: trade.qty,
      });
    }
  }
}

function flushBar(symbol: string, tf: number, live: LiveBar) {
  const ck = `${symbol}:${tf}`;
  const tfMs = tf * 1000;

  // CVD
  const prevCvd = cvdMap.get(ck) ?? 0;
  const delta = live.buyVolume - live.sellVolume;
  const newCvd = prevCvd + delta;
  cvdMap.set(ck, newCvd);

  // Get OI OHLC from the poller's in-memory aggregation
  const oiBar = getOIBar(symbol, tfMs, live.ts);
  const oiOpen = oiBar?.open ?? 0;
  const oiClose = oiBar?.close ?? 0;

  // Cumulative net longs/shorts from price + OI OHLC (resets daily)
  const dayStart = Math.floor(live.ts / 86400000) * 86400000;
  const lastDay = lastDayMap.get(ck) ?? 0;
  if (dayStart !== lastDay) {
    netLongsMap.set(ck, 0);
    netShortsMap.set(ck, 0);
    lastDayMap.set(ck, dayStart);
  }

  let cumLongs = netLongsMap.get(ck) ?? 0;
  let cumShorts = netShortsMap.get(ck) ?? 0;

  const changePrice = live.open - live.close;
  const changeOI = oiOpen - oiClose;

  let barNetLongs = 0;
  let barNetShorts = 0;

  if (changePrice > 0 && changeOI > 0) barNetLongs = oiClose - oiOpen;
  else if (changePrice > 0 && changeOI < 0) barNetShorts = oiClose - oiOpen;
  else if (changePrice < 0 && changeOI > 0) barNetShorts = oiClose - oiOpen;
  else if (changePrice < 0 && changeOI < 0) barNetLongs = oiClose - oiOpen;

  cumLongs += barNetLongs;
  cumShorts += barNetShorts;
  netLongsMap.set(ck, cumLongs);
  netShortsMap.set(ck, cumShorts);

  const bar: Bar = {
    ts: live.ts, symbol, exchange: 'binance', tfSeconds: tf,
    open: live.open, high: live.high, low: live.low, close: live.close,
    volume: live.volume, buyVolume: live.buyVolume, sellVolume: live.sellVolume,
    tradeCount: live.tradeCount, cvd: newCvd,
    vwap: live.vwapDen > 0 ? live.vwapNum / live.vwapDen : live.close,
    netLongs: cumLongs, netShorts: cumShorts, oiOpen, oiClose,
  };

  upsertBar(bar).catch(e => console.error('bar upsert error:', e.message));
  barEvents.emit('bar', bar);
}

export function getCurrentBar(symbol: string, tf: number): Bar | null {
  const live = openBars.get(`${symbol}:${tf}`);
  if (!live) return null;
  const ck = `${symbol}:${tf}`;
  const tfMs = tf * 1000;
  const prevCvd = cvdMap.get(ck) ?? 0;
  const oiBar = getOIBar(symbol, tfMs, live.ts);
  return {
    ts: live.ts, symbol, exchange: 'binance', tfSeconds: tf,
    open: live.open, high: live.high, low: live.low, close: live.close,
    volume: live.volume, buyVolume: live.buyVolume, sellVolume: live.sellVolume,
    tradeCount: live.tradeCount,
    cvd: prevCvd + (live.buyVolume - live.sellVolume),
    vwap: live.vwapDen > 0 ? live.vwapNum / live.vwapDen : live.close,
    netLongs: netLongsMap.get(ck) ?? 0,
    netShorts: netShortsMap.get(ck) ?? 0,
    oiOpen: oiBar?.open ?? 0, oiClose: oiBar?.close ?? 0,
  };
}
