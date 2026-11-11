"""ABI + correctness battery, mirroring the node's Stage 1/Stage 2 comparator gate.

Run: python3 tests/test_abi.py
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Module, ref_score, EXACT, ABS, REL, PASSFAIL, WASM  # noqa: E402

MARGIN_BPS = 10
failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if detail else ""))
    if not cond:
        failures.append(name)


def build_cases():
    cases = []
    rng = random.Random(20261111)  # fixed seed: reproducible
    truths = [1, 2, 7, 100, 12345, 10**6, 45_342_450, 10**9, 10**12, 10**15, 10**18,
              -1, -7, -62_290_000, -10**9, -10**18, 2**62, -(2**62)]
    tols = {
        EXACT: [0, 1, 100],
        ABS: [0, 1, 5, 1000, 10**6, 10**9, 10**17],
        REL: [0, 1, 25, 50, 100, 500, 2500, 10000, 50000],
        PASSFAIL: [0, 100],
        99: [100],
        -5: [100],
        (1 << 32) + 2: [100],   # only the low 32 bits are the code (== REL)
    }
    for code, tl in tols.items():
        for tol in tl:
            for t in truths:
                if code & 0xFFFFFFFF == ABS:
                    win = max(2 * tol, 2)
                    base = [0, 1, -1, tol, -tol, win - 1, 1 - win, win, -win, win + 1, 3 * win]
                elif code & 0xFFFFFFFF == REL:
                    unit = max(abs(t), 1)
                    edge = unit * 2 * tol // 10000
                    half = unit * tol // 10000
                    base = [0, 1, -1, half, -half, edge - 1, -(edge - 1), edge, -edge, edge + 1, 3 * edge + 5]
                else:
                    base = [0, 1, -1, 10, -10, 12345, -t]
                for d in base:
                    m = t + d
                    if -(2**63) <= m < 2**63:
                        cases.append((t, m, code, tol))
    for _ in range(300):
        t = rng.choice([-1, 1]) * rng.randint(1, 10**rng.randint(1, 18))
        code = rng.choice([ABS, REL, EXACT, PASSFAIL])
        tol = rng.randint(0, 10**rng.randint(0, 9))
        m = t + rng.randint(-3 * max(tol, 5), 3 * max(tol, 5))
        if -(2**63) <= m < 2**63:
            cases.append((t, m, code, tol))
    return cases


def main():
    check("wasm exists", os.path.exists(WASM), WASM)
    size = os.path.getsize(WASM)
    check("size <= 32 MB", size <= 32 * 1024 * 1024, f"{size} bytes")
    mod = Module()
    check("zero imports (not WASI)", len(mod.imports) == 0, f"{len(mod.imports)}")
    for name in ("imw_score_deterministic", "imw_alloc", "imw_free", "memory"):
        check(f"exports {name}", name in mod.exports)

    cases = build_cases()
    print(f"battery: {len(cases)} cases")

    def run(inst):
        return [inst.call(t, m, c, tol) for (t, m, c, tol) in cases]

    one = mod.instance()
    r1 = run(one)
    r2 = run(one)                  # same instance reused
    r3 = run(mod.instance())       # fresh instance
    check("deterministic: reused instance", r1 == r2)
    check("deterministic: fresh instance", r1 == r3)

    mism = []
    maxdev = 0
    for (t, m, c, tol), got in zip(cases, r1):
        want = ref_score(t, m, c, tol)
        dev = abs(got - want)
        maxdev = max(maxdev, dev)
        if dev > MARGIN_BPS:
            mism.append(((t, m, c, tol), want, got))
    check(f"within +/-{MARGIN_BPS} bps of reference on all cases", not mism, f"first={mism[:3]}")
    check("max deviation from reference", maxdev == 0, f"{maxdev} bps")
    check("all scores in 0..10000", all(0 <= s <= 10000 for s in r1))
    check("truth-first order matters (asymmetric rel)",
          one.call(100, 200, REL, 10000) != one.call(200, 100, REL, 10000))

    # ABI edge cases
    check("null spec pointer refused", one.call_raw_ptr(1, 1, 0) == -1)
    check("out of bounds spec pointer refused", one.call_raw_ptr(1, 1, 0x7FFFFFF0) == -1)
    check("alloc(0) / alloc(huge) do not crash", one.alloc(one.store, 0) == 0 and one.alloc(one.store, 1 << 30) == 0)
    p = [one.alloc(one.store, 16) for _ in range(3)]
    check("alloc returns distinct pointers", len(set(p)) == 3 and all(x > 0 for x in p))
    for x in p:
        one.free(one.store, x, 16)
    check("alloc after free works", one.alloc(one.store, 16) > 0)

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILED: {failures}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
