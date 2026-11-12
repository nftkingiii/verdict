// Loads the exact comparator bytes, verifies them, and scores questions through the wasm ABI.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const EXPECTED_SHA256 = '26e3935f1b637eb065e3ed3a6c446ff891c0b400251cd3ad1dacd5cf46ff3a71';
export const DEFAULT_WASM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'verdict_adapter.wasm');

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
export const inI64 = (v) => typeof v === 'bigint' && v >= I64_MIN && v <= I64_MAX;

/** Reads the file, refuses anything whose sha256 differs from the pinned value, compiles it. */
export function loadModule(wasmPath = DEFAULT_WASM_PATH, expected = EXPECTED_SHA256) {
  const bytes = readFileSync(wasmPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) {
    throw new Error(`wasm sha256 mismatch: got ${sha256}, expected ${expected}; refusing to start`);
  }
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('module has imports; refusing to start');
  return { bytes, sha256, keccak256: bytesToHex(keccak_256(bytes)), module };
}

/** One fresh instance; reused for every question in a batch (alloc/free per call). */
export function newScorer(module) {
  const { exports: ex } = new WebAssembly.Instance(module, {});
  return function score(truth, miner, code, tol) {
    const ptr = ex.imw_alloc(16);
    try {
      const view = new DataView(ex.memory.buffer, ptr, 16); // read buffer after alloc (memory may grow)
      view.setBigInt64(0, code, true);
      view.setBigInt64(8, tol, true);
      return ex.imw_score_deterministic(truth, miner, ptr); // BigInt
    } finally {
      ex.imw_free(ptr, 16);
    }
  };
}
