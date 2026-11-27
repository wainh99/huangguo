# HGhub — Node.js port for Cloudzyro

Single-process Node.js port of [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)
(a web remake of the HGhub short-drama client). The original runs two Python
stdlib servers — `proxy/server.py` (playback proxy, port 8080) and
`web/server.py` (web server, port 8081). Cloudzyro runs static sites and
Node.js only, no Python, so both are merged here into one Node process.

Zero npm dependencies — Node 20+ built-ins only (`http`, `crypto`, `fetch`).
Cloudzyro runs it with `npm start` (`node server.js`); it listens on
`process.env.PORT` (default 8081), host `0.0.0.0`.

## Files

- `server.js` — the whole server (playback proxy + web server merged)
- `index.html`, `hls.min.js` — frontend, copied unchanged from the original repo
- `package.json` — `start: node server.js`, `engines: node >= 20`

## Run locally

```bash
PORT=18081 node server.js
# then open http://127.0.0.1:18081/
```

## Routes (same shapes as the Python versions)

| Route | What it does |
|---|---|
| `GET /`, `/index.html` | The HGhub page |
| `GET /hls.min.js` | Bundled hls.js |
| `GET /health` | `{"status":"ok"}` |
| `POST /api/play` `{"id":12,"ep":1}` | POSTs empty `{}` to upstream `.../playback`, returns the response as-is |
| `GET /proxy/m3u8\|key\|ts?url=...`, `/proxy?url=...` | Relay for manifests/keys/segments (host allowlist, CORS `*`) |
| `GET /proxy/img?url=...` | Cover fetch + AES-128-CBC decrypt (see below) |
| `GET /api/prefip?isp=ct\|cu\|cmcc` | Cloudflare preferred-IP lists from cf.090227.xyz (600 s cache) |
| `GET/POST /api/up/*`, `/api/edge/*`, `/api/*` | Proxy to `https://huangguoai.com` (GET forwards the query string; POST does not, as in the original) |
| `OPTIONS *` | 204 with CORS headers |

## Cloud favorites + history (1.2.2.0)

Favorites and watch history sync to Hostless Valkey (Redis protocol).
The server talks RESP over TLS with zero dependencies (see `redisCall`
in server.js). Set the `REDIS_URL` env var on each deployment
(rediss://user:pass@host:port/db) to enable it — never commit it.
Keys: `hghub:favs`, `hghub:history` (whole JSON lists). The browser
keeps localStorage as a cache; on load it pulls the cloud lists, and
every favorite toggle or video open pushes the whole list (600 ms
debounce). Without `REDIS_URL`, `/api/favs` and `/api/history` answer
501 and the frontend falls back to local-only data.

## Two versions
- `main` — shared-favorites build: set `REDIS_URL` and favorites/history sync across devices via Valkey (this is the build running on 137/129/MS HOST).
- `local-favs` branch — local-only build: favorites and history live only in the browser's localStorage, no Redis, no cloud sync. Same playback, same allowlist, same playlist rewrite.

All responses carry `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: Content-Type, x-cdn-auth`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`.

## Cover decryption

Upstream covers from `pic.drleao.cn` arrive as AES-128-CBC-encrypted bytes
(NoPadding, key `f5d965df75336270`, IV `97b60394abc2fbe1`). Those values are
published in the upstream site's own frontend JS (`crypto-image-protocol.js`)
— they are not secrets. This port decrypts with Node's built-in `crypto`
(`createDecipheriv` + `setAutoPadding(false)`), no openssl CLI, no child
processes. Decrypted bytes that sniff as a real image (JPEG/PNG/WebP/GIF
magic) are returned; otherwise the original bytes are returned, same
fallback as the Python version. Decrypted covers are cached in memory
(LRU, 200 entries).

## Notes / deliberate differences from the Python version

- **One process instead of two**: `/api/play` calls upstream directly and
  `/proxy/*` are internal functions — no `PROXY_BASE` hop, no second port.
- **`/proxy` on the web server**: the original web server had no `/proxy`
  route (only the proxy process did); the merged server serves it, so the
  frontend's alias keeps working.
- **Network errors return 502 JSON** (`{"status":0,"msg":"upstream error: ..."}`).
  The Python code let the handler thread die on a fetch timeout/DNS failure
  (no response at all); a 502 is strictly more useful to the frontend.
  HTTP error statuses from upstream are still passed through unchanged.
- **`/api/play` error text**: the `invalid body: ...` message text differs
  slightly (JS vs Python `int()` errors); the status code and JSON shape
  are the same.
- **Other HTTP methods** (HEAD/PUT/DELETE/…) still return 501 as in Python,
  but with a plain-text body instead of BaseHTTPRequestHandler's HTML page.
