"""Fetch real truth values from the Assize truth-source service into eval/eval_set.json.

Read-only GETs. Run on the build VM:  python3 eval/fetch_truth.py
"""
import concurrent.futures as cf
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://assize.up.railway.app"
# (route, node) -- first node per route is the "primary" series, the rest are used as wrong-node decoys.
SERIES = [
    ("ercot", "HB_WEST"), ("ercot", "HB_NORTH"),
    ("caiso", "NP15"), ("caiso", "SP15"),
    ("caiso-rt", "NP15"), ("caiso-rt", "SP15"),
    ("miso", "ILLINOIS.HUB"), ("miso", "INDIANA.HUB"),
    ("nyiso", "N.Y.C."), ("nyiso", "CAPITL"),
]
START = dt.datetime(2026, 11, 8, 0, tzinfo=dt.timezone.utc)
HOURS = 72
# CAISO OASIS-backed routes are slow/flaky upstream; fetch a shorter window with one attempt.
ROUTE_HOURS = {"caiso": 12, "caiso-rt": 12}
SLOW = {"caiso", "caiso-rt"}


def get(route, node, ts):
    q = urllib.parse.urlencode({"node_or_zone": node, "interval_start": ts})
    url = f"{BASE}/{route}/price?{q}"
    for attempt in range(1 if route in SLOW else 3):
        try:
            with urllib.request.urlopen(url, timeout=20 if route in SLOW else 25) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 422):
                return {"error": f"http {e.code}"}
            time.sleep(1.5 * (attempt + 1))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return {"error": "unreachable"}


def main():
    jobs = []
    for route, node in SERIES:
        for h in range(ROUTE_HOURS.get(route, HOURS)):
            ts = (START + dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
            jobs.append((route, node, ts))
    rows = []
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        for (route, node, ts), res in zip(jobs, ex.map(lambda j: get(*j), jobs)):
            if "lmp_usd_per_mwh" in res and res["lmp_usd_per_mwh"] is not None:
                rows.append({
                    "route": route, "node": node, "interval_start": ts,
                    "value": res["lmp_usd_per_mwh"], "market": res.get("market"),
                    "iso": res.get("iso"), "source": res.get("source"),
                })
            else:
                rows.append({"route": route, "node": node, "interval_start": ts,
                              "value": None, "error": res.get("error", "no value")})
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eval_set.json")
    meta = {"fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "base": BASE,
            "series": SERIES, "rows": rows}
    with open(out, "w") as f:
        json.dump(meta, f, indent=1)
    ok = [r for r in rows if r["value"] is not None]
    print(f"rows={len(rows)} ok={len(ok)} missing={len(rows) - len(ok)}")
    for s in SERIES:
        vals = [r["value"] for r in ok if (r["route"], r["node"]) == s]
        if vals:
            print(s, "n=%d min=%.2f max=%.2f neg=%d" % (len(vals), min(vals), max(vals), sum(v < 0 for v in vals)))
        else:
            print(s, "no data")


if __name__ == "__main__":
    main()
