import { SYMBOLS, TIMEFRAMES } from '../shared/config.js';
import { setChartSymbolsGetter } from '../shared/active-subscriptions.js';
import { startVeloLivePoller } from './velo-live-bars.js';
import { startOIPoller } from './oi-poller.js';

/** Headless process: no WS clients — pin symbols from config. */
setChartSymbolsGetter(() => new Set(SYMBOLS));

console.log(`[heatrip] velo live + OI poller (static ${SYMBOLS.join(', ')})`);
startVeloLivePoller();
startOIPoller(TIMEFRAMES, 60000);
console.log('[heatrip] ingestion ready (no HTTP; run `npm run server` for UI)');
