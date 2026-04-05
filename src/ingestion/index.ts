import { SYMBOLS } from '../shared/config.js';
import { startBinanceIngestion } from './binance-ws.js';

console.log(`[heatrip] ingestion starting: ${SYMBOLS.join(', ')}`);
startBinanceIngestion(SYMBOLS);
console.log('[heatrip] ingestion ready');
