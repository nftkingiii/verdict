"""Score realistic miner answers against real truth values through the built wasm.

IMPORTANT scope note: the comparator only ever sees two fixed-point integers and a
spec. Reading the number out of the miner answer (nested/stringified JSON, "$",
commas, range check) and judging wrong node / interval / units happens in the node
before the comparator is called. `node_read()` below is a clearly-labelled
APPROXIMATION of that step so the evaluation covers the whole path; it is not part
of the shipped module. Wrong-node / wrong-interval / wrong-unit answers are
therefore scored purely as "a different number".

Run: python3 eval/evaluate.py   (writes eval/results.json and eval/results.md)
"""
import json
import os
import re
import sys
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "tests"))
from harness import Module, EXACT, ABS, REL  # noqa: E402

SCALE = 10 ** 6                 # response field decimals = 6 (intent schema)
RANGE = (-2000, 20000)          # response field range (intent schema)
PRIMARY = {"ercot": "HB_WEST", "caiso": "NP15", "caiso-rt": "NP15", "miso": "ILLINOIS.HUB", "nyiso": "N.Y.C."}
DECOY = {"ercot": "HB_NORTH", "caiso": "SP15", "caiso-rt": "SP15", "miso": "INDIANA.HUB", "nyiso": "CAPITL"}

# The intent's real spec (code/tolerance) is set on chain and is not exposed by the docs'
# HTTP endpoints, so the comparator is evaluated under several plausible specs.
SPECS = {
    "Exact": (EXACT, 0),
    "AbsTol $0.50": (ABS, 500_000),
    "AbsTol $1.00": (ABS, 1_000_000),
    "AbsTol $2.00": (ABS, 2_000_000),
    "RelTol 1% (100bps)": (REL, 100),
    "RelTol 5% (500bps)": (REL, 500),
}


def fx(v):
    return int(Decimal(str(v)).scaleb(6).to_integral_value(ROUND_HALF_UP))


def node_read(answer):
    """APPROXIMATION of the node's answer reader (not part of the wasm)."""
    def find(o):
        if isinstance(o, dict):
            if "lmp_usd_per_mwh" in o:
                return o["lmp_usd_per_mwh"]
            for v in o.values():
                r = find(v)
                if r is not None:
                    return r
        elif isinstance(o, list):
            for v in o:
                r = find(v)
                if r is not None:
                    return r
        elif isinstance(o, str):
            try:
                return find(json.loads(o))
            except Exception:
                return None
        return None

    val = None
    try:
        val = find(json.loads(answer))
    except Exception:
        val = answer.strip() if isinstance(answer, str) else None
    if isinstance(val, str):
        s = val.strip().replace("$", "").replace(",", "").replace("USD", "").strip()
        if not re.fullmatch(r"[+-]?\d+(\.\d+)?", s):
            return None
        val = Decimal(s)
    elif isinstance(val, (int, float)):
        val = Decimal(str(val))
    else:
        return None
    if not (RANGE[0] <= val <= RANGE[1]):
        return None
    return fx(val)


def build(rows):
    idx = {(r["route"], r["node"], r["interval_start"]): r["value"] for r in rows if r["value"] is not None}
    hours = sorted({r["interval_start"] for r in rows})
    items = []   # (variant, truth_value, answer_text)
    j = json.dumps
    for route, node in PRIMARY.items():
        for i, ts in enumerate(hours):
            t = idx.get((route, node, ts))
            if t is None:
                continue
            A = lambda v: j({"lmp_usd_per_mwh": v})
            r2 = lambda x: float(Decimal(str(x)).quantize(Decimal("0.01"), ROUND_HALF_UP))
            items += [
                ("exact", t, A(t)),
                ("exact as nested JSON", t, j({"data": {"result": {"lmp_usd_per_mwh": t}}})),
                ("exact as stringified JSON", t, j({"answer": A(t)})),
                ("'$1,234.50' string (2dp)", t, A(f"${t:,.2f}")),
                ("rounded to 0.01", t, A(r2(t))),
                ("rounded to $1", t, A(float(round(t)))),
                ("off by +$0.25", t, A(round(t + 0.25, 6))),
                ("off by +$1", t, A(round(t + 1, 6))),
                ("off by +0.5%", t, A(round(t * 1.005, 6))),
                ("off by +2%", t, A(round(t * 1.02, 6))),
                ("off by +10%", t, A(round(t * 1.10, 6))),
                ("half the price", t, A(round(t / 2, 6))),
                ("wrong units ($/kWh)", t, A(round(t / 1000, 9))),
                ("wrong units (x1000)", t, A(round(t * 1000, 6))),
                ("sign flipped", t, A(-t)),
            ]
            for lbl, d in (("wrong interval (prev hour)", -1), ("wrong interval (next hour)", 1)):
                k = i + d
                if 0 <= k < len(hours):
                    v = idx.get((route, node, hours[k]))
                    if v is not None:
                        items.append((lbl, t, A(v)))
            v = idx.get((route, DECOY[route], ts))
            if v is not None:
                items.append(("wrong node (same hour)", t, A(v)))
    # wrong market: CAISO day-ahead truth answered with real-time value and vice versa
    for node in ("NP15", "SP15"):
        for ts in hours:
            da, rt = idx.get(("caiso", node, ts)), idx.get(("caiso-rt", node, ts))
            if da is not None and rt is not None and node == "NP15":
                items.append(("wrong market (DAM vs RT)", da, json.dumps({"lmp_usd_per_mwh": rt})))
    for bad in ["N/A", "", "null", "price is high", "NaN", "Infinity", "1e999", "forty five", '{"lmp_usd_per_mwh": null}',
                '{"lmp_usd_per_mwh": "n/a"}', '{"price": 45.3}', '{"lmp_usd_per_mwh": 25000}', '{"lmp_usd_per_mwh": -2500}']:
        for route, node in PRIMARY.items():
            ts = hours[len(hours) // 2]
            t = idx.get((route, node, ts))
            if t is not None:
                items.append(("malformed / invalid / out of range", t, bad))
    return items


def main():
    data = json.load(open(os.path.join(HERE, "eval_set.json")))
    rows = data["rows"]
    items = build(rows)
    inst = Module().instance()
    stats = defaultdict(lambda: defaultdict(list))
    unreadable = defaultdict(int)
    for variant, t, ans in items:
        tf = fx(t)
        if tf == 0:        # the node never passes a truth of 0
            continue
        mf = node_read(ans)
        for sname, (code, tol) in SPECS.items():
            if mf is None:
                s = 0          # missing/invalid answers score 0 (node-side)
                unreadable[variant] += 1 if sname == "Exact" else 0
            else:
                s = inst.call(tf, mf, code, tol)
            stats[variant][sname].append(s)

    order = []
    for v, _, _ in items:
        if v not in order:
            order.append(v)
    ok = [r for r in rows if r["value"] is not None]
    neg = [r for r in ok if r["value"] < 0]
    small = [r for r in ok if abs(r["value"]) < 5]
    lines = [
        "# Evaluation results", "",
        f"Truth rows: {len(ok)} real values ({len(rows) - len(ok)} missing) from {data['base']}, fetched {data['fetched_at']}.",
        f"Negative prices in set: {len(neg)}; |price| < $5: {len(small)}.",
        f"Answer cases: {len(items)}. Scores are mean basis points (0-10000) from the built wasm, truth = real value, scale 1e6.",
        "", "| Variant | n | " + " | ".join(SPECS) + " |", "|---|---|" + "---|" * len(SPECS)]
    result = {}
    for v in order:
        n = len(stats[v]["Exact"])
        means = {s: round(sum(stats[v][s]) / max(len(stats[v][s]), 1)) for s in SPECS}
        result[v] = {"n": n, **means}
        lines.append(f"| {v} | {n} | " + " | ".join(str(means[s]) for s in SPECS) + " |")
    # negative / near-zero truths broken out
    lines += ["", "## Negative and near-zero truths (exact+rounded answers)", ""]
    sub = defaultdict(lambda: defaultdict(list))
    for variant, t, ans in items:
        if variant not in ("rounded to 0.01", "rounded to $1", "off by +$0.25", "off by +0.5%"):
            continue
        tf = fx(t)
        if tf == 0:
            continue
        cls = "negative" if t < 0 else ("|price|<5" if abs(t) < 5 else "normal")
        mf = node_read(ans)
        for sname, (code, tol) in SPECS.items():
            sub[(cls, variant)][sname].append(0 if mf is None else inst.call(tf, mf, code, tol))
    lines += ["| Truth class | Variant | n | " + " | ".join(SPECS) + " |", "|---|---|---|" + "---|" * len(SPECS)]
    for (cls, variant), d in sorted(sub.items()):
        lines.append(f"| {cls} | {variant} | {len(d['Exact'])} | " + " | ".join(
            str(round(sum(d[s]) / len(d[s]))) for s in SPECS) + " |")
    open(os.path.join(HERE, "results.md"), "w").write("\n".join(lines) + "\n")
    json.dump(result, open(os.path.join(HERE, "results.json"), "w"), indent=1)
    print("\n".join(lines))

    # Sanity assertions on the evaluation itself
    ex = result["exact"]
    assert all(ex[s] == 10000 for s in SPECS), "exact answers must score 10000 under every spec"
    assert result["malformed / invalid / out of range"]["Exact"] == 0
    print("\neval sanity checks passed")


if __name__ == "__main__":
    main()
