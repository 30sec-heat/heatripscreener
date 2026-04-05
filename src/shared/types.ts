export interface RawTrade {
  ts: number;
  symbol: string;
  exchange: string;
  price: number;
  qty: number;
  isBuyer: boolean;
  tradeId: number;
}

export interface Bar {
  ts: number;
  symbol: string;
  exchange: string;
  tfSeconds: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  cvd: number;
  vwap: number;
  netLongs: number;
  netShorts: number;
  oiOpen: number;
  oiClose: number;
}

export interface LargeTrade {
  ts: number;
  symbol: string;
  exchange: string;
  price: number;
  qty: number;
  notional: number;
  isBuyer: boolean;
  classification: string;
}

export interface BookUpdate {
  symbol: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  spreadBps: number;
}

export interface WsMessage {
  type: 'trade' | 'bar' | 'book' | 'whale' | 'options';
  [key: string]: any;
}
