// HTTP layer: POST scoring route, wasm download, health. Plain node:http, no framework.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { inI64, newScorer } from './module.js';

export const MAX_BATCH = 100;
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // docs: accept bodies of at least 1 MiB
const SCORE_PATHS = new Set(['/', '/score', '/runnable']);

class BadRequest extends Error {}

/**
 * JSON.parse that keeps 64-bit integers exact. Integer literals (no fraction/exponent) are
 * swapped for a nonce-tagged string while tokenising (string literals are skipped), then
 * turned into BigInt. Non-integer numbers stay JS numbers and are rejected by validation.
 */
export function parseJsonBigInt(text) {
  const tag = `\u0001${randomBytes(6).toString('hex')}:`;
  const swapped = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m) =>
    /^-?\d+$/.test(m) ? JSON.stringify(tag + m) : m);
  return JSON.parse(swapped, (_k, v) =>
    typeof v === 'string' && v.startsWith(tag) ? BigInt(v.slice(tag.length)) : v);
}

// The docs show values as <int64> without saying number or string, and a 4xx rejects the whole
// registration, so accept both a JSON integer and a decimal integer string.
function asI64(v, where) {
  if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) v = BigInt(v);
  if (typeof v !== 'bigint') throw new BadRequest(`${where} must be an integer (JSON number or decimal string)`);
  if (!inI64(v)) throw new BadRequest(`${where} is outside the signed 64-bit range`);
  return v;
}

export function validateBatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('body must be a JSON object {"batch": [...]}');
  const { batch } = body;
  if (!Array.isArray(batch)) throw new BadRequest('"batch" must be an array');
  if (batch.length > MAX_BATCH) throw new BadRequest(`"batch" holds ${batch.length} items; the maximum is ${MAX_BATCH}`);
  return batch.map((q, i) => {
    const at = `batch[${i}]`;
    if (q === null || typeof q !== 'object' || Array.isArray(q)) throw new BadRequest(`${at} must be an object`);
    const truth = asI64(q.ground_truth_value, `${at}.ground_truth_value`);
    const miner = asI64(q.miner_value, `${at}.miner_value`);
    if (!Array.isArray(q.spec) || q.spec.length !== 2) throw new BadRequest(`${at}.spec must be an array of exactly two integers [code, tolerance]`);
    return [truth, miner, asI64(q.spec[0], `${at}.spec[0]`), asI64(q.spec[1], `${at}.spec[1]`)];
  });
}

export function scoreBatch(loaded, questions) {
  const score = newScorer(loaded.module); // fresh instance per batch, reused inside it
  return questions.map(([t, m, c, tol]) => {
    try {
      const s = score(t, m, c, tol);
      if (s < 0n) return { error: 'module refused this input' };
      if (s > 10000n) return { error: 'module returned an out-of-range score' };
      return { score: Number(s) };
    } catch {
      return { error: 'module trapped on this input' };
    }
  });
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) { const parts = String(xff).split(','); return parts[parts.length - 1].trim(); } // rightmost = added by our proxy
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createApp(loaded, opts = {}) {
  const limit = opts.rateLimitPerMin ?? 120;
  const trustProxy = opts.trustProxy ?? true;
  const hits = new Map(); // ip -> { start, n }
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 60000) hits.delete(k); }, 30000);
  sweep.unref();

  const send = (res, status, obj, extra = {}) => {
    const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && p === '/health') {
      return send(res, 200, { ok: true, module: 'verdict_adapter.wasm', bytes: loaded.bytes.length, sha256: loaded.sha256, keccak256: '0x' + loaded.keccak256 });
    }
    if (req.method === 'GET' && p === '/verdict_adapter.wasm') {
      return send(res, 200, loaded.bytes, { 'content-type': 'application/wasm', 'cache-control': 'public, max-age=300' });
    }
    if (!SCORE_PATHS.has(p)) return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }, { allow: 'POST' });

    const ip = clientIp(req, trustProxy);
    const now = Date.now();
    let h = hits.get(ip);
    if (!h || now - h.start >= 60000) { h = { start: now, n: 0 }; hits.set(ip, h); }
    if (++h.n > limit) return send(res, 429, { error: 'rate limit exceeded' }, { 'retry-after': String(Math.ceil((60000 - (now - h.start)) / 1000)) });

    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => {
      if (over) return send(res, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { connection: 'close' });
      try {
        let body;
        try { body = parseJsonBigInt(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new BadRequest('body is not valid JSON'); }
        send(res, 200, { results: scoreBatch(loaded, validateBatch(body)) });
      } catch (e) {
        if (e instanceof BadRequest) return send(res, 400, { error: e.message });
        send(res, 500, { error: 'internal error' });
      }
    });
    req.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => clearInterval(sweep));
  return server;
}
