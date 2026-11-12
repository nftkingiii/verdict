import { loadModule, DEFAULT_WASM_PATH } from './module.js';
import { createApp } from './app.js';

let loaded;
try {
  loaded = loadModule(process.env.VERDICT_WASM_PATH || DEFAULT_WASM_PATH);
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
const server = createApp(loaded, {
  rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN || 120),
  trustProxy: process.env.TRUST_PROXY !== '0',
});
server.listen(port, '0.0.0.0', () => {
  console.log(`verdict endpoint on :${port} sha256=${loaded.sha256} keccak256=0x${loaded.keccak256}`);
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
