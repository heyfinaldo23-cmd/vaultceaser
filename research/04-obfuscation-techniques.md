# Obfuscation & Anti-Hotlinking Techniques

> Analysis of `HTTPToolkit_2026-05-16_05-40.har` (586 entries)

---

## Techniques Overview

| # | Technique | Layer | Severity | Defeated By |
|---|-----------|-------|----------|-------------|
| 1 | Base64 Pipe Proxy | API | Medium | Decode & analyze |
| 2 | Pipe Obfuscation Key | API | High | Reverse-engineer encryption |
| 3 | Referrer Domain Whitelist | Streaming | High | Spoof `Referer` header |
| 4 | CDN Subdomain Rotation | Delivery | Medium | Follow playlist segments |
| 5 | Fake File Extensions | Delivery | Medium | Ignore extension, read binary |
| 6 | AES-128 Encryption | Transport | Very High | Requires decryption key |
| 7 | Proxy Obfuscation Key | CDN | High | Session token reverse-engineering |
| 8 | JavaScript Obfuscation | Client | Medium | Deobfuscation tools |
| 9 | Gzip+Base64 Response Encoding | API | Low | Standard decompression |
| 10 | Separate Sub/Dub IDs | Data | Low | Discovery |

---

## 1. Base64 Pipe Proxy

### What It Is
All API calls go through a **single proxy endpoint**:

```
https://www.miruro.to/api/secure/pipe?e={base64_encoded_json}
```

### How It Works
The `e=` parameter contains a base64-encoded JSON object:

```json
{ "path": "search/browse", "method": "GET", "query": { ... }, "body": null }
```

### Security Level: Medium
- Base64 is **not encryption** — it's encoding
- Prevents casual inspection by someone looking at network requests
- Can be decoded with `Buffer.from(value, 'base64').toString('utf-8')`

### Decoded Example from HAR

```javascript
// Encoded parameter (partial):
e = "eyJwYXRoIjoic2VhcmNoL2Jyb3dzZSIsIm1ldGhvZCI6IkdFVCIsInF1ZXJ5Ijp7InR5cGUiOiJBTklNRSIsInN0YXR1cyI6IlJFTEVBU0lORyIsInNvcnQiOiJUUkVORElOR19ERVNDIiwicGFnZSI6MSwicGVyUGFnZSI6MTJ9LCJib2R5IjpudWxsfQ=="

// Decoded:
{ "path": "search/browse", "method": "GET", "query": { "type": "ANIME", "status": "RELEASING", "sort": "TRENDING_DESC", "page": 1, "perPage": 12 }, "body": null }
```

---

## 2. Pipe Obfuscation Key (VITE_PIPE_OBF_KEY)

### What It Is
A 128-bit key used to encrypt or HMAC-sign the `e=` parameter payload:

```
VITE_PIPE_OBF_KEY = "71951034f8fbcf53d89db52ceb3dc22c"
```

### How It Likely Works
The 32-character hex string (128 bits) suggests one of:

**Option A: AES-128-CBC Encryption**
```
plaintext = JSON.stringify({path, method, query, body})
key = Buffer.from("71951034f8fbcf53d89db52ceb3dc22c", 'hex')
ciphertext = aes128_cbc_encrypt(plaintext, key, iv)
e_param = base64_encode(ciphertext)
```

**Option B: HMAC-SHA256 Signing**
```
payload = base64_encode(JSON.stringify({path, method, query, body}))
signature = hmac_sha256(payload, key)
e_param = payload + "." + base64_encode(signature)
```

**Option C: XOR Obfuscation**
```
plaintext = JSON.stringify({path, method, query, body})
key_buffer = Buffer.from("71951034f8fbcf53d89db52ceb3dc22c", 'hex')
obfuscated = xor(plaintext, key_buffer)
e_param = base64_encode(obfuscated)
```

### Why It Matters
This prevents:
- Request replay attacks (if HMAC includes a timestamp)
- Parameter tampering (changing the query would invalidate the signature)
- Direct API access without the frontend

---

## 3. Referrer Domain Whitelist

### What It Is
The `/domains` endpoint returns a JSON array of **~40 whitelisted referrer domains** (base64-encoded).

### Captured Response (Decoded)
```json
[
  "animesugez.to", "animesugez.tv", "animesugetv.se",
  "animesugetv.to", "animesugetv.io", "animesuge.bz",
  "megacloud.bloggy.click", "ea.bunniescdn.online",
  "aniwave.best", "anixtv.me", "animixplay.tube",
  // ... 30+ more domains
]
```

### Verification Flow

```
Client requests video URL
  → Backend checks Referer header
  → Extracts domain from Referer
  → Checks against whitelist from /domains
  → If match: serve content
  → If no match: reject (403/404)
```

### HAR Evidence
Requests to `/stream/s-2/` consistently include:
```
Referer: https://www.miruro.to/
```

Requests to `getSources` include:
```
Referer: https://megaplay.buzz/stream/s-2/{id}/{type}
```

### Bypass Methods
- Spoof the `Referer` header to a whitelisted domain
- The whitelist includes many common anime streaming sites (9anime, AniWave, HiAnime, etc.)

---

## 4. CDN Subdomain Rotation

### What It Is
Video segments within the same HLS playlist are distributed across **multiple subdomains**:

| Subdomain | Domain | Segment Examples |
|-----------|--------|-----------------|
| `h9c5b` | `cinewave2.site` | `seg-152-f1-v1-a1.jpg`, `seg-160-f1-v1-a1.js` |
| `k8v2x` | `cinewave2.site` | `seg-161-f1-v1-a1.png` |
| `u0Dx` | `sparqle.click` | `seg-153-f1-v1-a1.html` |
| `f5ym` | `glimmeron.click` | `seg-154-f1-v1-a1.js` |
| `v2Xy` | `orbitra.click` | `seg-4-f1-v1-a1.css` |

### How the Rotation Works

```
Playlist defines:
  seg-152 → https://h9c5b.cinewave2.site/anime/{id}/{hash}/seg-152-f1-v1-a1.jpg
  seg-153 → https://u0Dx.sparqle.click/anime/{id}/{hash}/seg-153-f1-v1-a1.html
  seg-154 → https://f5ym.glimmeron.click/anime/{id}/{hash}/seg-154-f1-v1-a1.js
```

The subdomain prefixes (`h9c5b`, `k8v2x`, `u0Dx`, `f5ym`, `v2Xy`) are **not random** — they appear to be generated using a deterministic hash of:
- Session ID
- Segment index
- Content identifier

This rotates segments across ~5 CDN nodes to:
- Load balance across multiple servers
- Evade domain-based rate limiting
- Make it harder to block "all" video traffic to a single domain

---

## 5. Fake File Extensions

### What It Is
HLS video segments (which are MPEG-TS binary data) are served with **non-video file extensions**.

### Extension Map

| Extension | MIME Type Served | Disguised As |
|-----------|-----------------|--------------|
| `.jpg` | `image/jpeg` | JPEG image |
| `.html` | `text/html` | Web page |
| `.js` | `application/javascript` | JavaScript file |
| `.css` | `text/css` | Stylesheet |
| `.txt` | `text/plain` | Text file |
| `.png` | `image/png` | PNG image |
| `.webp` | `image/webp` | WebP image |
| `.ico` | `image/x-icon` | Favicon |

### Why It Works
- **Corporate firewalls:** Many corporate networks block `.ts`, `.mp4`, `.mkv` extensions but allow `.jpg`, `.png`, `.js`
- **ISP traffic shaping:** ISPs throttle known video streaming traffic — fake extensions bypass deep packet inspection if the CDN uses HTTPS
- **CDN caching CDNs:** Some CDNs treat video differently for caching/bandwidth pricing — fake extensions may get cheaper "image" or "static asset" rates

### DID It Actually Work in the HAR?
**Partially.** Some segments returned `Status: 0` with `Content-Type: application/x-unknown` — these failed to load, suggesting not all CDN nodes support the obfuscation correctly (or certain extensions trigger false positives in the CDN's own security).

---

## 6. AES-128 Encryption

### What It Is
The Ultracloud stream (`pru.ultracloud.cc`) uses **AES-128 encryption** on all video segments.

### Playlist
```m3u8
#EXT-X-KEY:METHOD=AES-128,URI="https://pru.ultracloud.cc/{path}/seg.jpg"
```

### How It Works
1. The **encryption key** is served at the same URL pattern as video segments (`seg.jpg`)
2. Each video segment (`seg.jpg`) is AES-128 encrypted
3. The **hls.js player** (via JWPlayer) fetches the key from the URI, decrypts each segment in the browser, and feeds the decrypted data to the video element

### Why AES-128 + Fake Extension Is Hard to Defeat
Even if someone:
- Finds the segment URLs in the playlist
- Downloads the `.jpg` files
- They'd get encrypted binary data — not a playable video

They'd also need the **key file** (also disguised as `seg.jpg`), which is protected by:
- The same referrer whitelist check
- The session-specific obfuscated path
- The proxy obfuscation key

---

## 7. Proxy Obfuscation Key (VITE_PROXY_OBF_KEY)

### What It Is
A 128-bit key used to generate the obfuscated paths on `pru.ultracloud.cc`:

```
VITE_PROXY_OBF_KEY = "a54d389c18527d9fd3e7f0643e27edbe"
```

### How It Works
The long URL paths (~200+ characters) are likely **HMAC-SHA256 session tokens**:

```
raw_path = "/{contentId}/{sessionId}/{timestamp}"
signature = hmac_sha256(raw_path, VITE_PROXY_OBF_KEY)
obfuscated_path = base64_url_encode(raw_path + "~" + signature)
// Result: zTlM7GtoUrClhoUISgrUh4siT_N7NhOxp4iAS01Tn9vEIBelIX1NrfyGyFYME96IxHQLqS5hHKvhhcFUDBbVi8B0Df4...
```

### Security Properties
- **Time-limited:** The path includes a timestamp, making URLs expire after `ttl: 86400` (24 hours)
- **Session-bound:** The path includes a session identifier
- **Tamper-proof:** Changing any part of the path invalidates the HMAC signature

### Observed TTL
The `ttl: 86400` parameter appears in `bee` provider source requests — this is 24 hours in seconds.

---

## 8. JavaScript Obfuscation

### What It Is
The `e1-player.min.js` (228 KB) is heavily obfuscated.

### Obfuscation Patterns

**Pattern — Hex-encoded strings:**
```javascript
var _0xd148 = ['\x68\x74\x74\x70\x73\x3A\x2F\x2F', '\x6D\x65\x67\x61\x70\x6C\x61\x79\x2E', '\x62\x75\x7A\x7A', ...];
```

**Pattern — Index-based lookups:**
```javascript
var endpoint = _0xd148[0x3f] + _0xd148[0x2a] + _0xd148[0x11];
// Rewrites to: "https://megaplay.buzz/stream/"
```

**Pattern — Control flow flattening:**
```javascript
function getSources(id) {
    var state = 0;
    while (state < 100) {
        switch(state) {
            case 0: /* ... */ state = 5; break;
            case 5: /* ... */ state = 12; break;
            // ...
        }
    }
}
```

### Common Deobfuscation Tools
- `de4js` (online)
- `jsnice.org`
- Webpack source maps (if available)
- AST-based tools like `shift-ast`

---

## 9. Gzip + Base64 Response Encoding

### What It Is
Search responses are returned as **Gzip-compressed, then base64-encoded** strings.

### Example
```
Response body starts with: H4sIAAAAAAAAA-2aW28b...
```

The `H4sIAAAA...` magic bytes are a **Gzip header**, indicating the response is:
1. Server compresses JSON with Gzip
2. Encodes the compressed bytes as base64
3. Frontend decodes base64 → decompresses Gzip → parses JSON

### Why Layer Gzip on Top of HTTP Compression?
HTTP already supports `Content-Encoding: gzip`, so this is an **additional obfuscation layer** — probably to:
- Prevent browser dev tools from showing readable JSON
- Make searching through HAR files harder
- Add an extra parsing step for scrapers

---

## 10. Separate Sub/Dub IDs

### What It Is
Sub and dub versions of the same episode use **different episode IDs** and different `category` parameters.

### Example
```
/stream/s-2/124216/sub  →  category: "ssub"  |  provider: "bee"
/stream/s-2/124216/dub  →  category: "dub"   |  provider: "bee"
```

### Why It Matters
- Prevents direct URL guessing (you can't just change `sub` to `dub` in a URL — the session ID differs)
- Allows different CDN paths for sub vs. dub (different content, different hosting)

---

## Combined Obfuscation Layers Across Files

Refer to the main documentation files for detailed analysis of each subsystem:

| Layer | Technique | Documented In | Severity |
|-------|-----------|---------------|----------|
| **1** | Base64 Pipe Proxy | [`02-homepage-api.md#1-the-apisecurepipe-proxy-pattern`](./02-homepage-api.md#1-the-apisecurepipe-proxy-pattern) | Medium |
| **2** | Pipe Obfuscation Key | [`02-homepage-api.md#5-obfuscation-keys`](./02-homepage-api.md#5-obfuscation-keys) | High |
| **3** | Referrer Domain Whitelist | [`01-streaming-pipeline.md#4-the-domains-endpoint--referrer-whitelist`](./01-streaming-pipeline.md#4-the-domains-endpoint--referrer-whitelist) | High |
| **4** | CDN Subdomain Rotation | [`01-streaming-pipeline.md#6-fake-file-extensions-on-video-segments`](./01-streaming-pipeline.md#6-fake-file-extensions-on-video-segments) | Medium |
| **5** | Fake File Extensions | [`01-streaming-pipeline.md#6-fake-file-extensions-on-video-segments`](./01-streaming-pipeline.md#6-fake-file-extensions-on-video-segments) | Medium |
| **6** | AES-128 Encryption | [`01-streaming-pipeline.md#53-ultracloud-cdn-pruultracloudcc`](./01-streaming-pipeline.md#53-ultracloud-cdn-pruultracloudcc) | Very High |
| **7** | Proxy Obfuscation Key | [`02-homepage-api.md#5-obfuscation-keys`](./02-homepage-api.md#5-obfuscation-keys) | High |
| **8** | JavaScript Obfuscation | [`02-homepage-api.md#7-jwplayer-setup`](./02-homepage-api.md#7-jwplayer-setup) | Medium |
| **9** | Gzip+Base64 Encoding | [`03-search-feature.md#23-search-response`](./03-search-feature.md#23-search-response) | Low |
| **10** | Separate Sub/Dub IDs | [`01-streaming-pipeline.md#3-sub-vs-dub--separate-episode-ids`](./01-streaming-pipeline.md#3-sub-vs-dub--separate-episode-ids) | Low |

## Defense-in-Depth Visualization

See the [Multi-Layer Obfuscation Stack diagram](./diagram.md#5-multi-layer-obfuscation-stack) for a visual representation of how these layers are stacked.
