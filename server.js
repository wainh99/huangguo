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
 *   GET  /api/favs             -> Cloudflare KV favorites (FAV_CODE env)
 *   PUT  /api/favs             -> same, whole-list write
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
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT || '8081', 10);
const UPSTREAM = 'https://huangguoai.com';

// Cloud favorites: reuse the huangguo-parser Worker + huangguo-favs KV
// (the same backend as the Huangguo station, a different code => a
// different key, so the two stations never share a list).
// The code IS the key to this station's favorites: keep it in the
// FAV_CODE env var, never in the repo. Unset => local-only (501).
const FAV_WORKER = 'https://huangguo-parser.wainh99.workers.dev';
const FAV_CODE = (process.env.FAV_CODE || '').trim().toUpperCase();
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
const ALLOWED_SUFFIXES = ['.hzjvlo.cn', '.drleao.cn'];

// /proxy/img only allows these image hosts (web/server.py).
const IMG_HOSTS = new Set([
  'pic.drleao.cn',
  'new.drleao.cn',
  'image.drleao.cn',
  'new2.drleao.cn',
  'pic.aluxvl.cn',
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

// GET /api/favs, PUT /api/favs, POST /api/favs — forward to the
// favorites Worker. The code is added server-side and never leaves the
// server; the Worker validates the code and the list shape, and we pass
// its status/body through unchanged.
async function handleFavs(res, req, rawBody) {
  if (!FAV_CODE) {
    sendJson(res, req, 501, { status: 0, msg: 'favs not configured' });
    return;
  }
  const method = req.method === 'GET' ? 'GET' : req.method; // PUT or POST
  const url = `${FAV_WORKER}/api/favs?code=${encodeURIComponent(FAV_CODE)}`;
  let result;
  try {
    result = await fetchUpstream(url, {
      method,
      data: method === 'GET' ? null : rawBody,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      timeout: 15000,
      errorContentType: 'from-headers',
    });
  } catch (e) {
    sendJson(res, req, 502, { status: 0, msg: `favs upstream error: ${e.message}` });
    return;
  }
  send(res, req, result.status, result.body, result.contentType || 'application/json');
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
    // Cloud favorites — must come before the generic /api/* proxy below,
    // or the request would be forwarded to the upstream site instead.
    if (pathname === '/api/favs') {
      await handleFavs(res, req, null);
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
    // Cloud favorites — same intercept as the GET route above.
    if (pathname === '/api/favs') {
      await handleFavs(res, req, body);
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

  // PUT only exists for /api/favs (cloud favorites); anything else keeps
  // the Python 501 behaviour below.
  if (req.method === 'PUT') {
    const body = await readBody(req);
    if (pathname === '/api/favs') {
      await handleFavs(res, req, body);
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
