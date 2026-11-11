# Evaluation results

Truth rows: 240 real values (240 missing) from https://assize.up.railway.app, fetched 2026-11-11T18:39:20.026988+00:00.
Negative prices in set: 0; |price| < $5: 0.
Answer cases: 2262. Scores are mean basis points (0-10000) from the built wasm, truth = real value, scale 1e6.

| Variant | n | Exact | AbsTol $0.50 | AbsTol $1.00 | AbsTol $2.00 | RelTol 1% (100bps) | RelTol 5% (500bps) |
|---|---|---|---|---|---|---|---|
| exact | 130 | 10000 | 10000 | 10000 | 10000 | 10000 | 10000 |
| exact as nested JSON | 130 | 10000 | 10000 | 10000 | 10000 | 10000 | 10000 |
| exact as stringified JSON | 130 | 10000 | 10000 | 10000 | 10000 | 10000 | 10000 |
| '$1,234.50' string (2dp) | 130 | 8308 | 9996 | 9998 | 9999 | 10000 | 10000 |
| rounded to 0.01 | 130 | 8308 | 9996 | 9998 | 9999 | 10000 | 10000 |
| rounded to $1 | 130 | 77 | 7548 | 8774 | 9387 | 7422 | 9484 |
| off by +$0.25 | 130 | 0 | 7500 | 8750 | 9375 | 7367 | 9473 |
| off by +$1 | 130 | 0 | 0 | 5000 | 7500 | 1288 | 7878 |
| off by +0.5% | 130 | 0 | 7253 | 8626 | 9313 | 7505 | 9501 |
| off by +2% | 130 | 0 | 1213 | 4670 | 7253 | 4 | 8001 |
| off by +10% | 130 | 0 | 0 | 0 | 561 | 0 | 0 |
| half the price | 130 | 0 | 0 | 0 | 0 | 0 | 0 |
| wrong units ($/kWh) | 130 | 0 | 0 | 0 | 0 | 0 | 0 |
| wrong units (x1000) | 130 | 0 | 0 | 0 | 0 | 0 | 0 |
| sign flipped | 130 | 0 | 0 | 0 | 0 | 0 | 0 |
| wrong interval (next hour) | 125 | 0 | 849 | 1542 | 2681 | 746 | 2962 |
| wrong interval (prev hour) | 125 | 0 | 849 | 1542 | 2681 | 749 | 2964 |
| wrong node (same hour) | 26 | 0 | 1427 | 2460 | 3414 | 1377 | 3706 |
| wrong market (DAM vs RT) | 10 | 0 | 0 | 152 | 856 | 0 | 1204 |
| malformed / invalid / out of range | 26 | 0 | 0 | 0 | 0 | 0 | 0 |

## Negative and near-zero truths (exact+rounded answers)

| Truth class | Variant | n | Exact | AbsTol $0.50 | AbsTol $1.00 | AbsTol $2.00 | RelTol 1% (100bps) | RelTol 5% (500bps) |
|---|---|---|---|---|---|---|---|---|
| normal | off by +$0.25 | 130 | 0 | 7500 | 8750 | 9375 | 7367 | 9473 |
| normal | off by +0.5% | 130 | 0 | 7253 | 8626 | 9313 | 7505 | 9501 |
| normal | rounded to $1 | 130 | 77 | 7548 | 8774 | 9387 | 7422 | 9484 |
| normal | rounded to 0.01 | 130 | 8308 | 9996 | 9998 | 9999 | 10000 | 10000 |
