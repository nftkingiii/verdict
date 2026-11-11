# Verdict (Telegraph comparator module)

A comparator WASM module for the deterministic `GRID_POWER_PRICE` family
(`GRID_POWER_PRICE_GENERAL`). Built and tested only; nothing is hosted, registered or published.

## What it scores

ABI from https://anjoman.ai/docs/scoring/build-a-scoring-module ("Comparator modules"):

- `imw_score_deterministic(truth: i64, miner: i64, spec_ptr: i32) -> i64`
- `imw_alloc(size: i32) -> i32`, `imw_free(ptr: i32, size: i32)`
- `spec_ptr` -> 16 bytes, little-endian `i64 code`, `i64 tolerance`
- returns basis points 0..10000 (negative = refuse)

The node reads `lmp_usd_per_mwh` out of the miner answer, scales it (6 decimals) and passes only two
integers. The module implements the network reference rule exactly:

| code | rule |
|---|---|
| 0 Exact, 3 PassFail, unknown | 10000 if miner == truth else 0 |
| 1 AbsTol | error = abs(miner - truth) |
| 2 RelTol | error = abs(miner - truth) * 10000 / max(abs(truth), 1), truncated, in bps |

For codes 1 and 2: score = 10000 * (2*tol - err) / (2*tol) (integer division), 0 once err >= 2*tol;
tolerance <= 0 means exact only. Truth first, miner second. 128-bit arithmetic, so no overflow at wei scale.

## Tolerance rationale (and what this module deliberately does not do)

The tolerance and comparison code come from the intent's on-chain spec, not from the module. The node's
Stage 2 gate (~1,260 cases, +/-10 bps of the reference rule, docs above) rejects any module that adds
its own floor, band, unit conversion or context penalty. So:

- No extra absolute floor or relative band is added. Negative or zero prices are handled by the spec
  choosing AbsTol (RelTol divides by max(abs(truth),1), which is harsh near zero; see eval table).
- No unit conversion: the intent schema declares one unit (USD per MWh, range -2000..20000) and no aliases.
- Field extraction (nested/stringified JSON, "$", commas, range checks) and wrong node / interval / market
  detection happen in the node before the comparator, which only sees two numbers. A wrong-interval or
  wrong-node answer is scored as a different number.
- No hardcoded answers, nodes, prices or contributors; the module has no data at all.

If the spec is AbsTol, a tolerance around $0.50-$1.00/MWh (500000-1000000 at scale 1e6) gives the full
gradient on real data (see `eval/results.md`). That is a recommendation for whoever sets the spec, not something the module can enforce.

## Build and test (on the build VM)

```
./build.sh                  # cargo test, wasm32-unknown-unknown release build, size/imports/hash
python3 tests/test_abi.py   # needs: pip install wasmtime==28.0.0
python3 eval/fetch_truth.py # refetch real truth values (read-only GETs)
python3 eval/evaluate.py
```

Toolchain: Rust 1.90.0 (`rust-toolchain.toml`), target `wasm32-unknown-unknown` (not WASI), no dependencies.
Tests: 7 Rust unit tests; 4,516-case ABI battery (all codes, tolerances 0..1e17, truths 1..1e18 and
negative, edges at 0 / half / 2x tolerance, code truncated to 32 bits), compared against an independent
big-int reference: max deviation 0 bps, identical on reused and fresh instances, zero imports.

## Evaluation

`eval/eval_set.json`: 240 real hourly values fetched 2026-11-11 from https://assize.up.railway.app
(ERCOT HB_WEST/HB_NORTH, CAISO NP15/SP15 DAM and RT, MISO ILLINOIS.HUB/INDIANA.HUB, NYISO N.Y.C./CAPITL);
the other 240 requests returned no value upstream. No negative prices occurred in this window, so
negatives are covered only by the synthetic battery. Results: `eval/results.md`. The reading step in
`eval/evaluate.py` is an approximation of the node and not part of the module. No incumbent exists for
this intent (no active module), so there is no benchmark against one.

## Artifact

`dist/verdict_adapter.wasm`: 2149 bytes, 0 imports,
sha256 `26e3935f1b637eb065e3ed3a6c446ff891c0b400251cd3ad1dacd5cf46ff3a71`.
Registration uses keccak256 of the same bytes (`cast keccak`), not sha256.
