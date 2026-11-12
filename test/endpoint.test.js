import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM = path.join(ROOT, 'dist', 'verdict_adapter.wasm');
const SHA = '26e3935f1b637eb065e3ed3a6c446ff891c0b400251cd3ad1dacd5cf46ff3a71';
const wasmBytes = readFileSync(WASM);

// Independent direct instance (not the server's code path).
const direct = (() => {
  const { exports: ex } = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
  return (t, m, c, tol) => {
    const p = ex.imw_alloc(16);
    const dv = new DataView(ex.memory.buffer, p, 16);
    dv.setBigInt64(0, BigInt(c), true); dv.setBigInt64(8, BigInt(tol), true);
    const r = ex.imw_score_deterministic(BigInt(t), BigInt(m), p);
    ex.imw_free(p, 16);
    return Number(r);
  };
})();

// Reference rule written from the docs, BigInt.
function ref(t, m, code, tol) {
  const c = Number(BigInt.asIntN(32, BigInt(code)));
  if (c !== 1 && c !== 2) return m === t ? 10000 : 0;
  const abs = (x) => (x < 0n ? -x : x);
  const diff = abs(m - t);
  const err = c === 1 ? diff : (diff * 10000n) / (abs(t) > 1n ? abs(t) : 1n);
  if (tol <= 0n) return m === t ? 10000 : 0;
  if (err >= 2n * tol) return 0;
  return Number((10000n * (2n * tol - err)) / (2n * tol));
}

function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });
}
async function boot(env = {}) {
  const port = await freePort();
  const p = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env } });
  await new Promise((resolve, reject) => {
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => { if (/verdict endpoint on/.test(d)) resolve(); });
    p.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return { p, base: `http://127.0.0.1:${port}` };
}
const post = (b, body, headers = {}) => fetch(b + '/score', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const raw = (t, m, c, tol) => `{"ground_truth_value":${t},"miner_value":${m},"spec":[${c},${tol}]}`;

let proc, base;
before(async () => { ({ p: proc, base } = await boot({ RATE_LIMIT_PER_MIN: '100000' })); });
after(() => proc.kill());

test('sha256 of dist wasm is the pinned value', () => {
  assert.equal(createHash('sha256').update(wasmBytes).digest('hex'), SHA);
  assert.equal(wasmBytes.length, 2149);
});

test('GET /verdict_adapter.wasm serves exact bytes as application/wasm', async () => {
  const r = await fetch(base + '/verdict_adapter.wasm');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/wasm');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(wasmBytes));
});

test('GET /health returns sha256 and keccak256', async () => {
  const j = await (await fetch(base + '/health')).json();
  assert.equal(j.sha256, SHA);
  assert.match(j.keccak256, /^0x[0-9a-f]{64}$/);
  console.log('health:', JSON.stringify(j));
});

test('(a) scores match direct wasm calls and the reference rule on the eval set', async () => {
  const rows = JSON.parse(readFileSync(path.join(ROOT, 'eval', 'eval_set.json'), 'utf8')).rows.filter((r) => typeof r.value === 'number');
  const specs = [[0, 0], [1, 500000], [1, 1000000], [1, 2000000], [2, 100], [2, 500], [3, 0]];
  const shifts = [(v) => v, (v) => v + 0.25, (v) => v + 1, (v) => v * 1.02, (v) => v * 1.1, (v) => -v, (v) => v / 2];
  const cases = [];
  for (const r of rows) for (const f of shifts) for (const [c, tol] of specs) {
    cases.push([BigInt(Math.round(r.value * 1e6)), BigInt(Math.round(f(r.value) * 1e6)), BigInt(c), BigInt(tol)]);
  }
  let checked = 0, maxDev = 0, requests = 0;
  for (let i = 0; i < cases.length; i += 100) {
    const chunk = cases.slice(i, i + 100);
    const res = await post(base, '{"batch":[' + chunk.map((x) => raw(...x)).join(',') + ']}'); requests++;
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.equal(results.length, chunk.length);
    chunk.forEach((x, j) => {
      const d = direct(...x);
      assert.equal(results[j].score, d, `direct mismatch ${x}`);
      maxDev = Math.max(maxDev, Math.abs(d - ref(...x)));
      checked++;
    });
  }
  console.log(`eval-set: ${rows.length} real rows -> ${checked} cases in ${requests} requests; endpoint == direct for all; max deviation vs reference rule ${maxDev} bps`);
  assert.equal(maxDev, 0);
});

test('(a) wei-scale and 64-bit extremes stay exact (BigInt parsing)', async () => {
  const I = 2n ** 63n - 1n, N = -(2n ** 63n);
  const items = [[10n ** 18n, 10n ** 18n + 123456789n, 2n, 100n], [I, I - 1n, 1n, 1n], [I, I, 0n, 0n], [N, N + 1n, 1n, 5n], [9007199254740993n, 9007199254740993n, 0n, 0n], [9007199254740993n, 9007199254740992n, 0n, 0n], [N, I, 1n, I], [1n, 2n, 4294967298n, 100n]];
  const res = await post(base, '{"batch":[' + items.map((x) => raw(...x)).join(',') + ']}');
  const { results } = await res.json();
  items.forEach((x, i) => assert.equal(results[i].score, direct(...x), JSON.stringify(x.map(String))));
  assert.equal(results[4].score, 10000);
  assert.equal(results[5].score, 0);
});

test('(b) 100-item batch ok, 101 rejected, empty batch ok', async () => {
  const mk = (n) => '{"batch":[' + Array.from({ length: n }, (_, i) => raw(1000000 + i, 1000500 + i, 1, 1000)).join(',') + ']}';
  let r = await post(base, mk(100)); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.results.length, 100);
  j.results.forEach((x, i) => assert.equal(x.score, direct(1000000 + i, 1000500 + i, 1, 1000)));
  r = await post(base, mk(101)); assert.equal(r.status, 400); assert.match((await r.json()).error, /maximum is 100/);
  r = await post(base, mk(0)); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { results: [] });
  const t0 = performance.now(); await (await post(base, mk(100))).json();
  console.log(`100-item batch latency ${(performance.now() - t0).toFixed(1)} ms`);
});

test('(c) malformed input -> 400 with a message', async () => {
  const one = (v) => `{"batch":[${v}]}`;
  const bad = {
    'not json': '{nope',
    'empty body': '',
    'array body': '[]',
    'missing batch': '{}',
    'batch not array': '{"batch":1}',
    'item not object': one('1'),
    'missing truth': one('{"miner_value":1,"spec":[1,1]}'),
    'float value': one('{"ground_truth_value":1.5,"miner_value":1,"spec":[1,1]}'),
    'exponent value': one('{"ground_truth_value":1e3,"miner_value":1,"spec":[1,1]}'),
    'non-integer string': one('{"ground_truth_value":"1.5","miner_value":1,"spec":[1,1]}'),
    'string above i64': one('{"ground_truth_value":"9223372036854775808","miner_value":1,"spec":[1,1]}'),
    'null value': one('{"ground_truth_value":null,"miner_value":1,"spec":[1,1]}'),
    'above i64': one('{"ground_truth_value":9223372036854775808,"miner_value":1,"spec":[1,1]}'),
    'below i64': one('{"ground_truth_value":1,"miner_value":-9223372036854775809,"spec":[1,1]}'),
    'spec too short': one('{"ground_truth_value":1,"miner_value":1,"spec":[1]}'),
    'spec too long': one('{"ground_truth_value":1,"miner_value":1,"spec":[1,1,1]}'),
    'spec not array': one('{"ground_truth_value":1,"miner_value":1,"spec":{"a":1}}'),
    'spec float': one('{"ground_truth_value":1,"miner_value":1,"spec":[1,0.5]}'),
    'spec word string': one('{"ground_truth_value":1,"miner_value":1,"spec":["abs",1]}'),
    'spoofed marker string': one('{"ground_truth_value":"\\u0001abc:5","miner_value":1,"spec":[1,1]}'),
  };
  for (const [name, body] of Object.entries(bad)) {
    const r = await post(base, body);
    assert.equal(r.status, 400, name);
    const j = await r.json(); assert.ok(typeof j.error === 'string' && j.error.length > 5, name);
  }
  console.log(`malformed: ${Object.keys(bad).length} variants, all 400 with a message`);
});

test('decimal-string integers score the same as JSON integers', async () => {
  const asNum = await (await post(base, '{"batch":[{"ground_truth_value":98500000,"miner_value":98250000,"spec":[1,1000000]}]}')).json();
  const asStr = await (await post(base, '{"batch":[{"ground_truth_value":"98500000","miner_value":"98250000","spec":["1","1000000"]}]}')).json();
  assert.deepEqual(asStr, asNum);
  assert.equal(asNum.results[0].score, 8750);
});

test('result shape, routes, no redirects, body size limit', async () => {
  const r = await post(base, '{"batch":[' + raw(5, 5, 0, 0) + ',' + raw(5, 6, 0, 0) + ']}');
  assert.deepEqual(await r.json(), { results: [{ score: 10000 }, { score: 0 }] });
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/score')).status, 405);
  const slash = await fetch(base + '/score/', { method: 'POST', body: '{}', redirect: 'manual' });
  assert.equal(slash.status, 404); // never a 3xx
  const big = '{"batch":[],"pad":"' + 'x'.repeat(2 * 1024 * 1024 + 10) + '"}';
  let status; try { status = (await post(base, big)).status; } catch { status = 'closed'; }
  assert.ok(status === 413 || status === 'closed', 'oversize body: ' + status);
  console.log('oversize (2 MiB + 10) body ->', status);
  // 1 MiB body must still be accepted
  const ok1 = '{"batch":[],"pad":"' + 'x'.repeat(1024 * 1024) + '"}';
  assert.equal((await post(base, ok1)).status, 200);
});

test('per-IP rate limit returns 429', async () => {
  const { p, base: b } = await boot({ RATE_LIMIT_PER_MIN: '5' });
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await post(b, '{"batch":[]}')).status);
    console.log('rate-limit codes', codes.join(','));
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
    assert.equal((await fetch(b + '/health')).status, 200);
  } finally { p.kill(); }
});

test('(d) wrong wasm hash -> refuses to start', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'verdict-'));
  const bad = path.join(dir, 'tampered.wasm');
  const b = Buffer.from(wasmBytes); b[b.length - 1] ^= 1; writeFileSync(bad, b);
  const r = spawnSync(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', VERDICT_WASM_PATH: bad }, encoding: 'utf8', timeout: 15000 });
  console.log('startup refusal: exit', r.status, '|', r.stderr.trim());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sha256 mismatch/);
  const missing = spawnSync(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, VERDICT_WASM_PATH: path.join(dir, 'none.wasm') }, encoding: 'utf8', timeout: 15000 });
  assert.equal(missing.status, 1);
});
