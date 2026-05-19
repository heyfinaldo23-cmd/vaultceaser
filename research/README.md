# Megaplay.buzz — HAR Analysis Research

> Analysis of `HTTPToolkit_2026-05-16_05-40.har` (586 HTTP entries, captured 2026-05-16 05:39–05:45 UTC)

This directory contains a comprehensive analysis of the Megaplay.buzz / Miruro.to streaming site's architecture, API patterns, and obfuscation techniques.

## VaultCeaser implementation (codebase)

The running app is documented in the repo root **[`README.md`](../README.md)** — config keys (`miruro_base`, `pipe_fallback_bases`, `embed_s2_mode`, CDN allowlists), health checks, main API routes, and an **architecture diagram** (Mermaid) for how the browser, FastAPI app, pipe, AniList, embed player, and CDN interact.

## Files

| File | Description |
|------|-------------|
| [`01-streaming-pipeline.md`](./01-streaming-pipeline.md) | Full HLS streaming chain: `/stream/s-2/` iframe embed → `getSources` → master.m3u8 → index playlists → disguised segments. Covers JWPlayer, subtitles, fake extensions, and AES-128 encryption. |
| [`02-homepage-api.md`](./02-homepage-api.md) | Homepage data loading: `/api/secure/pipe` proxy pattern, 3 homepage data calls (trending, schedule, movies), banner/cover image CDNs, AniList OAuth, env2.js configuration, proxy URLs. |
| [`03-search-feature.md`](./03-search-feature.md) | Search end-to-end: incremental/live search pattern ("bleac" → "bleach"), query parameters, result mapping to watch pages, cover image sources. |
| [`04-obfuscation-techniques.md`](./04-obfuscation-techniques.md) | All 10 anti-hotlinking and obfuscation techniques ranked by severity: base64 pipe proxy, obfuscation keys, referrer whitelist, subdomain rotation, fake extensions, AES-128 encryption, HMAC session tokens, JS obfuscation. |
| [`diagram.md`](./diagram.md) | Mermaid diagrams: streaming sequence, referrer whitelist flow, homepage data loading, search flow, multi-layer obfuscation stack, network host map. |

## Key Findings Summary

### Architecture
- **Two CDN providers** for HLS: Mewstream (`cdn.mewstream.buzz`) and Cinewave2 (`s2.cinewave2.site`)
- **AES-128 encrypted** stream from Ultracloud (`pru.ultracloud.cc`)
- **Single API proxy endpoint** (`/api/secure/pipe?e=`) with base64-obfuscated JSON payloads
- **JWPlayer 8.33.2** with hls.js plugin, analytics to `prd.jwpltx.com`

### Obfuscation (10 layers)
1. Base64 pipe proxy (all API calls)
2. Pipe obfuscation key (HMAC/AES for API payloads)
3. Referrer domain whitelist (~40 domains in `/domains`)
4. CDN subdomain rotation (5+ subdomains per session)
5. Fake file extensions (`.jpg`, `.html`, `.js`, `.css`, `.png`, `.webp`, `.ico`)
6. AES-128 encryption (Ultracloud only)
7. Proxy obfuscation key (HMAC session tokens in URLs)
8. JavaScript obfuscation (e1-player.min.js)
9. Gzip + base64 response encoding
10. Separate sub/dub episode IDs

### Search
- 300ms debounced live search fires on every keystroke
- Progression: partial query → full query → expanded results → genre filter
- Results from AniList API proxied through pipe endpoint
