#!/usr/bin/env bash
# Reproducible build (run on the build VM). Prints size, import count and hashes.
set -euo pipefail
cd "$(dirname "$0")"
. "$HOME/.cargo/env"
cargo test --release --lib 2>&1 | tail -n 15
cargo build --release --target wasm32-unknown-unknown
OUT=target/wasm32-unknown-unknown/release/verdict_adapter.wasm
mkdir -p dist
cp "$OUT" dist/verdict_adapter.wasm
ls -l dist/verdict_adapter.wasm
echo "sha256 $(sha256sum dist/verdict_adapter.wasm | cut -d' ' -f1)"
python3 -c "
import wasmtime
m=wasmtime.Module(wasmtime.Engine(),open('dist/verdict_adapter.wasm','rb').read())
print('imports:',len(list(m.imports)))
print('exports:',sorted(e.name for e in m.exports))"
