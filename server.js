#!/usr/bin/env node
/**
 * HGhub clone — Node.js port (single process) for Cloudzyro.
 *
 * Ported from vps1986/hghub-clone (Python stdlib, two processes):
 *   - proxy/server.py  — playback proxy (was port 8080)
 *   - web/server.py    — web server (was port 8081)
 *
 * The two servers are merged into ONE process: /api/play calls the
 * upstream playback API directly (no PROXY_BASE hop, no second port),
 * and /proxy/m3u8|key|ts|/proxy are internal relay functions.
 *
 * Zero npm dependencies: Node 24 built-ins only (http, crypto, fetch).
 * Listens on process.env.PORT (default 8081), host 0.0.0.0.
 *
 * Public routes (same shapes as the Python versions):
 *   GET  / , /index.html        -> web/index.html
 *   GET  /hls.min.js            -> web/hls.min.js
 *   GET  /health                -> {"status":"ok"}
 *   POST /api/play              -> upstream POST {} playback, returned as-is
 *   GET  /proxy/m3u8|key|ts     -> relay (host allowlist, CORS *)
 *   GET  /proxy                 -> same relay (alias)
 *   GET  /proxy/img             -> cover fetch + AES-128-CBC decrypt
 *   GET  /api/prefip            -> cf.090227.xyz preferred-IP lists
 *   GET  /api/favs             -> Valkey favorites (REDIS_URL env)
 *   PUT  /api/favs             -> same, whole-list write
 *   GET  /api/history          -> Valkey watch history (REDIS_URL env)
 *   PUT  /api/history          -> same, whole-list write
 *   GET  /api/up/*              -> proxy to https://huangguoai.com/api/*
 *   GET  /api/edge/*, /api/*    -> proxy to https://huangguoai.com (+ path)
 *   POST /api/up/*, /api/edge/*, /api/* (not /api/play) -> same, upstream
 *   OPTIONS *                  -> 204, CORS headers
 *
 * All responses carry Access-Control-Allow-Origin: *,
 * Access-Control-Allow-Headers: Content-Type, x-cdn-auth and
 * Access-Control-Allow-Methods: GET, POST, OPTIONS.
 *
 * Cover decryption (public upstream protocol, see the original README):
 * AES-128-CBC, NoPadding, key "f5d965df75336270", IV "97b60394abc2fbe1".
 * These are published in the upstream site's own frontend JS
 * (crypto-image-protocol.js), not secrets.
 */

'use strict';

const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8081', 10);
const UPSTREAM = 'https://huangguoai.com';

// Cloud favorites + watch history: Hostless Valkey (Redis protocol).
// One REDIS_URL env var (rediss://user:pass@host:port/db), never in the
// repo. Unset => local-only (501). Keys hold whole JSON lists:
//   hghub:favs     [{id, title, cover, savedAt}]
//   hghub:history  [{id, title, cover, ep, t}]
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const FAVS_KEY = 'hghub:favs';
const HIST_KEY = 'hghub:history';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

// Only these hosts may be relayed through /proxy (proxy/server.py).
const ALLOWED_HOSTS = new Set([
  'huangguoai.com',
  'huangguoai.ai',
  'pic.drleao.cn',
  'yd-lphu-long.hzjvlo.cn',
  'tp1.drleao.cn',
  'tp4.drleao.cn',
  'tp8.drleao.cn',
]);
const ALLOWED_SUFFIXES = ['.hzjvlo.cn', '.drleao.cn', '.tjyyjk.cn', '.qnlycc.cn'];

// /proxy/img only allows these image hosts (web/server.py).
const IMG_HOSTS = new Set([
  'pic.drleao.cn',
  'new.drleao.cn',
  'image.drleao.cn',
  'new2.drleao.cn',
  'pic.aluxvl.cn',
  'pic.qnlycc.cn',
  'huangguoai.com',
]);

// Cover-decrypt key/IV: upstream's public frontend protocol (see header).
const IMG_KEY = Buffer.from('f5d965df75336270', 'ascii');
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'ascii');

// Static files, read once at startup (same bytes as web/index.html,
// web/hls.min.js in the original repo).
const BASE_DIR = __dirname;
let INDEX_HTML = null;
let HLS_JS = null;
try {
  INDEX_HTML = fs.readFileSync(path.join(BASE_DIR, 'index.html'));
} catch (e) {
  console.error(`index.html not found: ${e.message}`);
}
try {
  HLS_JS = fs.readFileSync(path.join(BASE_DIR, 'hls.min.js'));
} catch (e) {
  console.error(`hls.min.js not found: ${e.message}`);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------- fetch
// Mirrors Python urllib behaviour: follow redirects, send the Android UA,
// honour a timeout. Returns { status, body: Buffer, contentType } where
// contentType is the bare MIME type (no parameters), lower-cased — the
// equivalent of urllib's get_content_type().
// errorContentType: what to report as contentType on an HTTP error status.
//   Python's proxy _fetch always used "text/plain" there; the web _fetch
//   used the upstream header (or "text/plain" if absent).
async function fetchUpstream(
  url,
  { method = 'GET', data = null, headers = {}, timeout = 25000, errorContentType = 'from-headers' } = {},
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      body: data,
      signal: ctrl.signal,
    });
    const body = Buffer.from(await resp.arrayBuffer());
    let contentType = (resp.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (resp.status >= 400 && errorContentType === 'text/plain') {
      contentType = 'text/plain';
    }
    if (!contentType) contentType = 'text/plain';
    return { status: resp.status, body, contentType };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- send
function send(res, req, status, body, contentType = 'application/json') {
  if (!Buffer.isBuffer(body)) body = Buffer.from(String(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-cdn-auth',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  // Python's _send also omits the body for HEAD; we never route HEAD here,
  // but keep the guard for safety.
  if (req.method !== 'HEAD') res.end(body);
  else res.end();
}

function sendJson(res, req, status, obj) {
  send(res, req, status, JSON.stringify(obj), 'application/json');
}

// ---------------------------------------------------------------- images
function sniffImage(data) {
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      data.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  return 'application/octet-stream';
}

// AES-128-CBC, NoPadding — same guard as Python's _aes_decrypt_cbc_nopad:
// empty input or a length that is not a multiple of 16 -> null.
// (Node's createDecipheriv + setAutoPadding(false) replaces openssl CLI.)
function aesDecryptCbcNopad(data) {
  if (data.length === 0 || data.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return null;
  }
}

// Decrypted-cover LRU cache, max 200 entries (Python _ImgCache).
class ImgCache {
  constructor(limit = 200) {
    this.limit = limit;
    this.store = new Map();
  }
  get(key) {
    const hit = this.store.get(key);
    if (hit !== undefined) {
      this.store.delete(key);
      this.store.set(key, hit);
    }
    return hit;
  }
  put(key, value) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.limit) {
      this.store.delete(this.store.keys().next().value);
    }
  }
}
const IMG_CACHE = new ImgCache();

// ---------------------------------------------------------------- prefip
// cf.090227.xyz preferred-IP lists, plain text "IP#CF ..." lines.
// /ct (telecom), /cu (unicom), /cmcc (mobile). 10 s timeout, [] on failure.
// Cached 600 s, exactly like Python's _prefip_all/_prefip_list.
const PREFIP_TTL = 600;
const prefipCache = { at: 0, data: {} };

async function prefipList(isp) {
  try {
    const { body } = await fetchUpstream(`https://cf.090227.xyz/${isp}`, {
      timeout: 10000,
    });
    const text = body.toString('utf8');
    const out = [];
    const re = /(\d+\.\d+\.\d+\.\d+)\s*#/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  } catch (e) {
    log(`prefip fetch ${isp} failed: ${e.message}`);
    return [];
  }
}

async function prefipAll() {
  const now = Date.now() / 1000;
  if (now - prefipCache.at < PREFIP_TTL && Object.keys(prefipCache.data).length > 0) {
    return prefipCache.data;
  }
  const data = {};
  for (const k of ['ct', 'cu', 'cmcc']) data[k] = await prefipList(k);
  prefipCache.at = now;
  prefipCache.data = data;
  return data;
}

// ---------------------------------------------------------------- proxy
function hostAllowed(host) {
  host = (host || '').toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some((s) => host.endsWith(s));
}

// GET /proxy, /proxy/m3u8, /proxy/key, /proxy/ts (proxy/server.py _proxy).
// Timeout 30 s; HTTP-error bodies keep content-type "text/plain" unless the
// .m3u8/.ts/.key override below applies.
async function handleProxyRelay(res, req, url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    sendJson(res, req, 400, { status: 0, msg: 'url must be http(s)' });
    return;
  }
  let host = '';
  try {
    host = new URL(url).hostname || '';
  } catch {
    host = '';
  }
  if (!hostAllowed(host)) {
    sendJson(res, req, 403, { status: 0, msg: `host not allowed: ${host}` });
    return;
  }
  let result;
  try {
    result = await fetchUpstream(url, {
      timeout: 30000,
      errorContentType: 'text/plain',
    });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `upstream error: ${e.message}` });
    return;
  }
  // The manifest URL carries ?auth_key=... — strip the query before
  // checking the suffix, exactly like the Python version.
  let urlPath = '';
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch {
    urlPath = '';
  }
  let ctype = result.contentType;
  if (
    urlPath.endsWith('.m3u8') ||
    ctype.includes('mpegurl') ||
    ctype.includes('x-mpegurl')
  ) {
    ctype = 'application/vnd.apple.mpegurl';
  } else if (urlPath.endsWith('.ts')) {
    ctype = 'video/MP2T';
  } else if (urlPath.endsWith('.key') || url.includes('crypt.key')) {
    ctype = 'application/octet-stream';
  }
  send(res, req, result.status, result.body, ctype);
}

// POST /api/play — upstream playback with an EMPTY JSON body. Any id/ep in
// the body makes upstream reject it ("播放参数无效"), so id/ep only ever go
// in the URL. The upstream response is returned as-is (proxy/server.py).
function toInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return parseInt(value, 10);
  }
  throw new Error(`invalid literal for int(): ${JSON.stringify(value)}`);
}

async function handleApiPlay(res, req, rawBody) {
  let videoId;
  let ep;
  try {
    const payload = JSON.parse(rawBody.length ? rawBody.toString('utf8') : '{}');
    videoId = toInt(payload.id);
    ep = payload.ep === undefined ? 1 : toInt(payload.ep);
  } catch (e) {
    sendJson(res, req, 400, { status: 0, msg: `invalid body: ${e.message}` });
    return;
  }
  const url = `${UPSTREAM}/api/videos/${videoId}/episodes/${ep}/playback`;
  let result;
  try {
    result = await fetchUpstream(url, {
      method: 'POST',
      data: Buffer.from('{}'),
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
      errorContentType: 'from-headers',
    });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `upstream error: ${e.message}` });
    return;
  }
  if (result.status !== 200) {
    sendJson(res, req, result.status, {
      status: 0,
      msg: `upstream HTTP ${result.status}`,
    });
    return;
  }
  let data;
  try {
    data = JSON.parse(result.body.toString('utf8'));
  } catch {
    sendJson(res, req, 502, { status: 0, msg: 'upstream returned non-JSON' });
    return;
  }
  sendJson(res, req, 200, data);
}

// Generic upstream proxy (web/server.py _proxy_to): status + body +
// content-type pass through unchanged. Timeout 25 s.
async function proxyTo(res, req, url, data = null, headers = {}) {
  let result;
  try {
    result = await fetchUpstream(url, {
      method: data !== null ? 'POST' : 'GET',
      data,
      headers,
      timeout: 25000,
      errorContentType: 'from-headers',
    });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `upstream error: ${e.message}` });
    return;
  }
  send(res, req, result.status, result.body, result.contentType || 'application/octet-stream');
}

// GET /proxy/img — fetch cover bytes, AES-decrypt, return a real image.
// Same fallback as Python: decrypted bytes that sniff as an image win;
// otherwise the original bytes are returned (sniffed type, defaulting to
// image/jpeg when the bytes sniff as nothing at all).
async function handleProxyImg(res, req, url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    sendJson(res, req, 400, { status: 0, msg: 'url must be http(s)' });
    return;
  }
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (!IMG_HOSTS.has(host)) {
    sendJson(res, req, 403, { status: 0, msg: `image host not allowed: ${host}` });
    return;
  }
  const cacheKey = crypto.createHash('sha256').update(url).digest('hex');
  const hit = IMG_CACHE.get(cacheKey);
  if (hit !== undefined) {
    send(res, req, 200, hit[0], hit[1]);
    return;
  }
  let result;
  try {
    result = await fetchUpstream(url, {
      timeout: 20000,
      errorContentType: 'from-headers',
    });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `upstream error: ${e.message}` });
    return;
  }
  if (result.status !== 200) {
    sendJson(res, req, result.status, {
      status: 0,
      msg: `upstream HTTP ${result.status}`,
    });
    return;
  }
  const plain = aesDecryptCbcNopad(result.body);
  if (plain !== null && sniffImage(plain) !== 'application/octet-stream') {
    const ctype = sniffImage(plain);
    IMG_CACHE.put(cacheKey, [plain, ctype]);
    send(res, req, 200, plain, ctype);
    return;
  }
  let ctype = sniffImage(result.body);
  if (ctype === 'application/octet-stream') ctype = 'image/jpeg';
  IMG_CACHE.put(cacheKey, [result.body, ctype]);
  send(res, req, 200, result.body, ctype);
}

// ---------------------------------------------------------------- valkey
// Minimal RESP client over node:net / node:tls — no dependencies.
// One short connection per call (AUTH, SELECT if needed, one command),
// closed right after the reply. Favorites/history calls are rare, so
// the handshake cost does not matter; short connections also survive
// platform restarts without reconnect logic.
function parseRedisUrl(u) {
  const p = new URL(u);
  if (p.protocol !== 'rediss:' && p.protocol !== 'redis:') {
    throw new Error('REDIS_URL must start with redis:// or rediss://');
  }
  return {
    host: p.hostname,
    port: parseInt(p.port || (p.protocol === 'rediss:' ? '6380' : '6379'), 10),
    tls: p.protocol === 'rediss:',
    user: decodeURIComponent(p.username || ''),
    pass: decodeURIComponent(p.password || ''),
    db: parseInt((p.pathname || '/0').replace(/^\//, '') || '0', 10) || 0,
  };
}

function encodeResp(args) {
  const parts = [Buffer.from('*' + args.length + '\r\n', 'utf8')];
  for (const a of args) {
    const b = Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from('$' + b.length + '\r\n', 'utf8'), b, Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

// Parse one RESP reply from buf starting at off.
// Returns [value, nextOff], or null when the buffer does not hold a
// complete reply yet. Error replies (-...) throw.
function parseResp(buf, off) {
  const type = String.fromCharCode(buf[off]);
  const end = buf.indexOf('\r\n', off);
  if (end === -1) return null;
  const line = buf.toString('utf8', off + 1, end);
  if (type === '+') return [line, end + 2];
  if (type === '-') throw new Error('redis error: ' + line);
  if (type === ':') return [parseInt(line, 10), end + 2];
  if (type === '$') {
    const len = parseInt(line, 10);
    if (len === -1) return [null, end + 2];
    if (buf.length < end + 2 + len + 2) return null;
    return [buf.toString('utf8', end + 2, end + 2 + len), end + 2 + len + 2];
  }
  if (type === '*') {
    const n = parseInt(line, 10);
    if (n === -1) return [null, end + 2];
    const out = [];
    let cur = end + 2;
    for (let i = 0; i < n; i++) {
      const r = parseResp(buf, cur);
      if (r === null) return null;
      out.push(r[0]);
      cur = r[1];
    }
    return [out, cur];
  }
  throw new Error('redis: unknown reply type ' + JSON.stringify(type));
}

function redisCall(args) {
  return redisAttempt(args, 0);
}

// One attempt: open a TLS/plain connection, AUTH, SELECT if needed, run
// one command, close. Transient transport failures (timeout, reset)
// get one retry 300 ms later — the first connections after a cold
// start can be slow to establish; RESP error replies (wrong password
// and friends) are real failures and are not retried. GET/SET here are
// idempotent whole-list operations, so a retry cannot double-apply.
function redisAttempt(args, attempt) {
  return new Promise((resolve, reject) => {
    let cfg;
    try {
      cfg = parseRedisUrl(REDIS_URL);
    } catch (e) {
      reject(e);
      return;
    }
    let done = false;
    let sock = null;
    let respError = null;
    const timer = setTimeout(() => fail(new Error('redis timeout')), 8000);
    const fail = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (sock) sock.destroy();
      } catch {}
      if (respError === null && attempt < 1) {
        setTimeout(() => {
          redisAttempt(args, attempt + 1).then(resolve, reject);
        }, 300);
      } else {
        reject(respError || e);
      }
    };
    sock = cfg.tls
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    let buf = Buffer.alloc(0);
    const queue = [];
    const send = (a) =>
      new Promise((res) => {
        queue.push(res);
        sock.write(encodeResp(a), (e) => {
          if (e) fail(e);
        });
      });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (queue.length) {
        let parsed;
        try {
          parsed = parseResp(buf, 0);
        } catch (e) {
          respError = e;
          fail(e);
          return;
        }
        if (parsed === null) return; // wait for more data
        buf = buf.subarray(parsed[1]);
        queue.shift()(parsed[0]);
      }
    });
    sock.on('error', fail);
    sock.on(cfg.tls ? 'secureConnect' : 'connect', async () => {
      try {
        if (cfg.user) await send(['AUTH', cfg.user, cfg.pass]);
        else if (cfg.pass) await send(['AUTH', cfg.pass]);
        if (cfg.db !== 0) await send(['SELECT', String(cfg.db)]);
        const v = await send(args);
        clearTimeout(timer);
        done = true;
        try {
          sock.end();
        } catch {}
        resolve(v);
      } catch (e) {
        fail(e);
      }
    });
  });
}

async function redisGet(key) {
  const v = await redisCall(['GET', key]);
  return v === null ? null : v;
}

async function redisSet(key, value) {
  const v = await redisCall(['SET', key, value]);
  if (v !== 'OK') throw new Error('redis SET failed: ' + String(v));
}

// GET /api/favs|/api/history, PUT|POST same — whole-list read/write.
// GET returns {list, source:'redis'} (empty list when the key is absent).
// PUT/POST takes {list:[...]} and returns {ok, count, source:'redis'}.
// No REDIS_URL => 501 (frontend falls back to local-only). Redis errors
// => 502 (frontend shows "同步失败，仅保存在本机").
function cleanFavItem(x) {
  if (!x || typeof x.id === 'undefined') return null;
  const id = +x.id;
  if (!id) return null;
  return {
    id,
    title: String(x.title || '').slice(0, 200),
    cover: String(x.cover || '').slice(0, 2000),
    savedAt: Number(x.savedAt) || Date.now(),
  };
}
function cleanHistItem(x) {
  if (!x || typeof x.id === 'undefined') return null;
  const id = +x.id;
  if (!id) return null;
  return {
    id,
    title: String(x.title || '').slice(0, 200),
    cover: String(x.cover || '').slice(0, 2000),
    ep: Math.max(1, +x.ep || 1),
    t: Number(x.t) || Date.now(),
  };
}
async function handleStore(res, req, rawBody, key, maxItems, clean) {
  if (!REDIS_URL) {
    sendJson(res, req, 501, { status: 0, msg: 'cloud storage not configured' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const raw = await redisGet(key);
      let list = [];
      if (raw) {
        try {
          const d = JSON.parse(raw);
          list = (Array.isArray(d) ? d : []).map(clean).filter(Boolean);
        } catch {
          list = [];
        }
      }
      sendJson(res, req, 200, { list, source: 'redis' });
      return;
    }
    let body;
    try {
      body = JSON.parse(rawBody.length ? rawBody.toString('utf8') : '{}');
    } catch {
      sendJson(res, req, 400, { status: 0, msg: 'bad json' });
      return;
    }
    if (!body || !Array.isArray(body.list) || body.list.length > maxItems) {
      sendJson(res, req, 400, { status: 0, msg: 'bad list' });
      return;
    }
    const list = body.list.map(clean).filter(Boolean);
    await redisSet(key, JSON.stringify(list));
    sendJson(res, req, 200, { ok: true, count: list.length, source: 'redis' });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `redis error: ${e.message}` });
  }
}

// ---------------------------------------------------------------- routing
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const query = u.search; // includes leading '?', or ''
  const qs = u.searchParams;

  if (req.method === 'OPTIONS') {
    send(res, req, 204, Buffer.alloc(0));
    return;
  }

  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/index.html') {
      if (INDEX_HTML === null) {
        sendJson(res, req, 404, { status: 0, msg: 'index.html not found' });
        return;
      }
      send(res, req, 200, INDEX_HTML, 'text/html; charset=utf-8');
      return;
    }
    if (pathname === '/hls.min.js') {
      if (HLS_JS === null) {
        sendJson(res, req, 404, { status: 0, msg: 'hls.min.js not found' });
        return;
      }
      send(res, req, 200, HLS_JS, 'application/javascript; charset=utf-8');
      return;
    }
    if (pathname === '/health') {
      sendJson(res, req, 200, { status: 'ok' });
      return;
    }
    if (
      pathname === '/proxy/m3u8' ||
      pathname === '/proxy/key' ||
      pathname === '/proxy/ts'
    ) {
      const url = qs.get('url');
      if (!url) {
        sendJson(res, req, 400, { status: 0, msg: 'missing url' });
        return;
      }
      await handleProxyRelay(res, req, url);
      return;
    }
    if (pathname === '/proxy') {
      // Proxy alias: no "missing url" check here (proxy/server.py behaviour
      // — an empty url fails the http(s) check instead).
      await handleProxyRelay(res, req, qs.get('url') || '');
      return;
    }
    if (pathname === '/proxy/img') {
      await handleProxyImg(res, req, qs.get('url') || '');
      return;
    }
    if (pathname === '/api/prefip') {
      const isp = qs.get('isp') || 'auto';
      const all = await prefipAll();
      if (isp === 'ct' || isp === 'cu' || isp === 'cmcc') {
        sendJson(res, req, 200, {
          status: 1,
          data: { isp, ips: all[isp] || [] },
        });
      } else {
        sendJson(res, req, 200, {
          status: 1,
          data: {
            isp: 'auto',
            ips: all.ct || [],
            ct: all.ct || [],
            cu: all.cu || [],
            cmcc: all.cmcc || [],
          },
        });
      }
      return;
    }
    // Cloud favorites + history — must come before the generic /api/*
    // proxy below, or the request would be forwarded upstream instead.
    if (pathname === '/api/favs') {
      await handleStore(res, req, null, FAVS_KEY, 500, cleanFavItem);
      return;
    }
    if (pathname === '/api/history') {
      await handleStore(res, req, null, HIST_KEY, 100, cleanHistItem);
      return;
    }
    if (pathname.startsWith('/api/up/')) {
      const rest = pathname.slice('/api/up/'.length);
      await proxyTo(res, req, `${UPSTREAM}/api/${rest}${query}`);
      return;
    }
    if (pathname.startsWith('/api/edge/')) {
      await proxyTo(res, req, `${UPSTREAM}${pathname}${query}`);
      return;
    }
    if (pathname.startsWith('/api/')) {
      await proxyTo(res, req, `${UPSTREAM}${pathname}${query}`);
      return;
    }
    sendJson(res, req, 404, { status: 0, msg: 'not found' });
    return;
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (pathname === '/api/play') {
      await handleApiPlay(res, req, body);
      return;
    }
    // Cloud favorites + history — same intercept as the GET route above.
    if (pathname === '/api/favs') {
      await handleStore(res, req, body, FAVS_KEY, 500, cleanFavItem);
      return;
    }
    if (pathname === '/api/history') {
      await handleStore(res, req, body, HIST_KEY, 100, cleanHistItem);
      return;
    }
    if (pathname.startsWith('/api/up/')) {
      // NOTE: like the Python version, POST /api/up/* does NOT forward the
      // query string — only GET routes do.
      const rest = pathname.slice('/api/up/'.length);
      await proxyTo(res, req, `${UPSTREAM}/api/${rest}`, body.length ? body : Buffer.from('{}'), {
        'Content-Type': 'application/json',
      });
      return;
    }
    if (pathname.startsWith('/api/edge/')) {
      await proxyTo(res, req, `${UPSTREAM}${pathname}`, body.length ? body : Buffer.from('{}'), {
        'Content-Type': 'application/json',
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      await proxyTo(res, req, `${UPSTREAM}${pathname}`, body.length ? body : Buffer.from('{}'), {
        'Content-Type': 'application/json',
      });
      return;
    }
    sendJson(res, req, 404, { status: 0, msg: 'not found' });
    return;
  }

  // PUT only exists for /api/favs and /api/history (cloud favorites and
  // history); anything else keeps the Python 501 behaviour below.
  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (pathname === '/api/favs') {
      await handleStore(res, req, body, FAVS_KEY, 500, cleanFavItem);
      return;
    }
    if (pathname === '/api/history') {
      await handleStore(res, req, body, HIST_KEY, 100, cleanHistItem);
      return;
    }
  }

  // Python's BaseHTTPRequestHandler answers 501 for other methods (HEAD,
  // PUT, DELETE, ...). Keep that status; the body is plain text here.
  send(res, req, 501, 'Unsupported method', 'text/plain');
}

const server = http.createServer((req, res) => {
  handle(req, res)
    .then(() => {
      log(`${req.method} ${req.url} -> ${res.statusCode}`);
    })
    .catch((e) => {
      log(`error handling ${req.method} ${req.url}: ${e.stack || e.message}`);
      try {
        if (!res.headersSent) {
          sendJson(res, req, 500, { status: 0, msg: 'internal error' });
        } else {
          res.end();
        }
      } catch {
        // ignore — the socket is already gone
      }
    });
});

server.listen(PORT, HOST, () => {
  log(`hghub-node listening on ${HOST}:${PORT} (upstream ${UPSTREAM})`);
});
