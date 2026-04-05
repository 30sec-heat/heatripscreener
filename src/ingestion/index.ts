import { SYMBOLS, TIMEFRAMES } from '../shared/config.js';
import { startVeloLivePoller } from './velo-live-bars.js';
import { startOIPoller } from './oi-poller.js';

console.log(`[heatrip] velo live + OI poller: ${SYMBOLS.join(', ')}`);
startVeloLivePoller(SYMBOLS);
startOIPoller(SYMBOLS, TIMEFRAMES, 60000);
console.log('[heatrip] ingestion ready (no HTTP; run server for WS UI)');
