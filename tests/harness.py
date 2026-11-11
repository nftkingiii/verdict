"""Loads the built comparator under wasmtime and calls it the way the node does.

Reference rule below is written independently from the docs
(https://anjoman.ai/docs/scoring/build-a-scoring-module), using Python big ints.
"""
import os
import struct
import wasmtime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WASM = os.path.join(ROOT, "dist", "verdict_adapter.wasm")

EXACT, ABS, REL, PASSFAIL = 0, 1, 2, 3


def ref_score(truth: int, miner: int, code: int, tol: int) -> int:
    """Reference rule from the docs. code is read as a 32-bit integer."""
    code &= 0xFFFFFFFF
    if code >= 0x80000000:
        code -= 1 << 32
    if code not in (ABS, REL):
        return 10000 if miner == truth else 0
    diff = abs(miner - truth)
    err = diff if code == ABS else diff * 10000 // max(abs(truth), 1)
    if tol <= 0:
        return 10000 if miner == truth else 0
    if err >= 2 * tol:
        return 0
    return 10000 * (2 * tol - err) // (2 * tol)


class Module:
    def __init__(self, path=WASM):
        self.engine = wasmtime.Engine()
        self.module = wasmtime.Module.from_file(self.engine, path)
        self.imports = list(self.module.imports)
        self.exports = {e.name: e.type for e in self.module.exports}

    def instance(self):
        return Instance(self)


class Instance:
    def __init__(self, m: Module):
        self.store = wasmtime.Store(m.engine)
        inst = wasmtime.Instance(self.store, m.module, [])
        ex = inst.exports(self.store)
        self.mem = ex["memory"]
        self.alloc = ex["imw_alloc"]
        self.free = ex["imw_free"]
        self.score = ex["imw_score_deterministic"]

    def call(self, truth, miner, code, tol):
        ptr = self.alloc(self.store, 16)
        self.mem.write(self.store, struct.pack("<qq", code, tol), ptr)
        try:
            return self.score(self.store, truth, miner, ptr)
        finally:
            self.free(self.store, ptr, 16)

    def call_raw_ptr(self, truth, miner, ptr):
        return self.score(self.store, truth, miner, ptr)
