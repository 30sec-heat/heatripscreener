/** Union of symbols any connected chart client has subscribed to (via WS). */

export type ChartSymbolsGetter = () => Set<string>;

let getChartSymbols: ChartSymbolsGetter = () => new Set();

export function setChartSymbolsGetter(fn: ChartSymbolsGetter) {
  getChartSymbols = fn;
}

export function getActiveChartSymbols(): Set<string> {
  return getChartSymbols();
}
