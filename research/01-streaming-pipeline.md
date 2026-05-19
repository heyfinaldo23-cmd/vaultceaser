# Streaming Pipeline — Megaplay.buzz

> Analysis of `HTTPToolkit_2026-05-16_05-40.har` (586 entries)

---

## Table of Contents

1. [Overview](#overview)
2. [The /stream/s-2/{id}/{type} Iframe Embed Pattern](#1-the-streams-2idtype-iframe-embed-pattern)
3. [The getSources?id= Endpoint](#2-the-getsourcesid-endpoint)
4. [Sub vs. Dub — Separate Episode IDs](#3-sub-vs-dub--separate-episode-ids)
5. [The /domains Endpoint — Referrer Whitelist](#4-the-domains-endpoint--referrer-whitelist)
6. [Full HLS Chain](#5-full-hls-chain)
7. [Fake File Extensions on Video Segments](#6-fake-file-extensions-on-video-segments)
8. [JWPlayer Setup](#7-jwplayer-setup)
9. [Subtitle Delivery](#8-subtitle-delivery)

---

## Overview

The streaming pipeline follows this request chain:

```
miruro.to (watch page)
  → megaplay.buzz/stream/s-2/{episodeId}/{type}  (iframe embed)
    → megaplay.buzz/stream/getSources?id={episodeId}  (API call)
      → CDN/master.m3u8  (HLS master playlist)
        → CDN/index-fX.m3u8  (quality variant playlist)
          → CDN/seg-X.{jpg,html,js,css,png,...}  (video segments)
```

---

## 1. The /stream/s-2/{id}/{type} Iframe Embed Pattern

### Trigger
User clicks a "Watch" button on Miruro for a specific episode.

### Captured Requests (5 total)

| URL | Type |
|-----|------|
| `https://megaplay.buzz/stream/s-2/869100600/sub` | Sub (ID: 869100600) |
| `https://megaplay.buzz/stream/s-2/169702/sub` | Sub (ID: 169702) |
| `https://megaplay.buzz/stream/s-2/124216/sub` | Sub (ID: 124216) |
| `https://megaplay.buzz/stream/s-2/124216/dub` | Dub (same episode, different endpoint) |
| `https://megaplay.buzz/stream/s-2/13793/dub` | Dub (ID: 13793) |

### Request Details
- **Method:** GET
- **Status:** 200 OK
- **Content-Type:** `text/html`
- **Title:** `File [ID] - MegaPlay`

### Referrer Chain
```
1. miruro.to/watch/{anilistId}
   → Referer: https://www.miruro.to/

2. megaplay.buzz/stream/s-2/{id}/{type}
   → Referer: https://www.miruro.to/

3. megaplay.buzz/stream/getSources?id={id}
   → Referer: https://megaplay.buzz/stream/s-2/{id}/{type}
```

> This referrer chain is critical for the **domain whitelist** anti-hotlinking check (see Section 4).

---

## 2. The getSources?id= Endpoint

### Trigger
JavaScript inside the `/stream/s-2/` iframe page calls this endpoint after loading.

### Request
- **URL:** `https://megaplay.buzz/stream/getSources?id={episodeId}`
- **Method:** GET
- **Status:** 200 OK

### Full JSON Response Structure

```json
{
  "sources": [
    {
      "file": "https://{cdn}/anime/{id}/{hash}/master.m3u8"
    }
  ],
  "tracks": [
    {
      "file": "https://1oe.lostproject.club/subtitles/{hash}.vtt",
      "kind": "captions",
      "label": "English"
    }
  ],
  "intro": { "start": 0, "end": 100 },
  "outro": { "start": 1309, "end": 1366 },
  "server": 4
}
```

### 5 Captured Responses

| ID | Master M3U8 Source | Subtitles | Intro (s) | Outro (s) | Server |
|----|-------------------|-----------|-----------|-----------|--------|
| 176144 | `cdn.mewstream.buzz` | English | 0–0 | 0–0 | 4 |
| 174707 | `s2.cinewave2.site` | English | 0–0 | 0–0 | 4 |
| 7921 | `cdn.mewstream.buzz` | Chinese, English, Indonesian, Thai, Vietnamese | 0–100 | 1386–1475 | 4 |
| 7914 | `cdn.mewstream.buzz` | English | 0–0 | 0–0 | 4 |
| 135223 | `s2.cinewave2.site` | English, Portuguese, Spanish | 0–101 | 1309–1366 | 4 |

### Key Observations

- **`intro`/`outro` timestamps:** Enable the "Skip Intro" / "Skip Outro" buttons in the player UI. Values of `0–0` mean no intro/outro detected.
- **`server: 4`:** Constant across all requests — indicates server node or CDN allocation pool ID.
- **Two source CDNs:** `cdn.mewstream.buzz` and `s2.cinewave2.site` (load-balanced or content-routed).
- **Subtitle `tracks` array:** Contains VTT file URLs from `1oe.lostproject.club` for each language.

---

## 3. Sub vs. Dub — Separate Episode IDs

Sub and dub versions of the **same episode** use **different episode IDs** served by different `category` values in the backend.

### Example from the HAR

```
Episode 124216:
  /stream/s-2/124216/sub  →  getSources?id=124216  →  sub video track
  /stream/s-2/124216/dub  →  getSources?id=124216  →  dub video track
```

### In Backend Pipe Calls

The `/api/secure/pipe` proxy calls reveal the category distinction:

```json
// Sub call
{ "path": "sources", "query": { "episodeId": "...", "provider": "bee", "category": "ssub", "ttl": 86400 } }

// Dub call  
{ "path": "sources", "query": { "episodeId": "...", "provider": "bee", "category": "dub", "ttl": 86400 } }
```

> Note: There's also a `"ssub"` (soft-sub) category observed, distinct from `"sub"`.

### Providers Observed

| Provider | Category | Usage |
|----------|----------|-------|
| `kiwi` | `sub` | Primary sub source (used with `anilistId`) |
| `bee` | `ssub`, `dub` | Soft-sub and dub sources (with `ttl: 86400`) |
| `ally` | `sub` | Alternative sub provider |
| `hop` | `ssub` | Backup soft-sub provider |

---

## 4. The /domains Endpoint — Referrer Whitelist

### Trigger
Called during page initialization (before streaming begins).

### Request
- **URL:** `https://megaplay.buzz/domains?h=2026051520`
- **Method:** GET
- **Status:** 200 OK

### Response
The response body is a **base64-encoded JSON array**. Decoded:

```json
[
  "animesugez.to", "animesugez.tv", "animesugetv.se", "animesugetv.to",
  "animesugetv.io", "animesuge.bz", "megacloud.bloggy.click",
  "ea.bunniescdn.online", "animesuge.nz", "animesuge.fi",
  "aniwave.best", "anixtv.me", "animixplay.tube", "anixt.to",
  "animixplaytv.to", "anix.tube", "aniwave.id", "anix.at",
  "animesogo.to", "9anime.skin", "animesugeto.com", "anikoto.tv",
  "aniwave.ro", "animekai.se", "animez.pro", "animez.ro",
  "gogoanime.com.by", "animekaitv.to", "anikai.se", "anikoto.bz",
  "anikototv.to", "anisugetv.to", "animesugetv.bz", "animewave.to",
  "anikaitv.to", "hianimez.org", "anisuge.tv", "9animez.org", "anikoto.net",
  "megacloud.bloggy.click", "ea.bunniescdn.online"
]
```

### Purpose
This is the **primary anti-hotlinking mechanism**. The streaming backend checks the `Referer` header of incoming requests against this whitelist. Only requests originating from these domains (or their subdomains/sub-paths) are allowed to fetch video content.

> The `?h=2026051520` parameter appears to be a date-based hash (`YYYYMMDDHH`), suggesting the whitelist may be rotated daily.

---

## 5. Full HLS Chain

### 5.1 Mewstream CDN (`cdn.mewstream.buzz`)

**Master playlist** `/path/master.m3u8`:
```m3u8
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
index-f3.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
index-f2.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080
index-f1.m3u8
```

**Index playlist** (1080p variant, `/index-f1.m3u8`):
- 144 segments
- Target duration: ~10s per segment
- Segments served from rotated CDN subdomains (`u0Dx.sparqle.click`, `f5ym.glimmeron.click`, `v2Xy.orbitra.click`)
- Fake extensions on all segments

### 5.2 Cinewave2 CDN (`s2.cinewave2.site`)

**Master playlist** `/path/master.m3u8`:
```m3u8
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1407000,RESOLUTION=1920x1080,CODECS="avc1.64001E,mp4a.40.2"
index-f1-v1-a1.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=773000,RESOLUTION=1280x720,CODECS="avc1.4D401E,mp4a.40.2"
index-f2-v1-a1.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=391000,RESOLUTION=640x360,CODECS="avc1.42C015,mp4a.40.2"
index-f3-v1-a1.m3u8
```

**Index playlist** (1080p variant, `/index-f1-v1-a1.m3u8`):
- VOD playlist type
- Target duration: ~10s
- Segments served from `h9c5b.cinewave2.site` and `v2Xy.orbitra.click`
- Same fake extension pattern

### 5.3 Ultracloud CDN (`pru.ultracloud.cc`)

**Full playlist** `/path/pl.m3u8`:
```m3u8
#EXTM3U
#EXT-X-TARGETDURATION:19
#EXT-X-ALLOW-CACHE:YES
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://pru.ultracloud.cc/{obfuscated_path}/seg.jpg"
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:1
#EXTINF:11.928,
https://pru.ultracloud.cc/{obfuscated_path}/seg.jpg
...
#EXT-X-ENDLIST
```

- **AES-128 encrypted:** Each segment is encrypted. Decryption key URL also uses `.jpg` extension.
- **Obfuscated paths:** URL paths are long base64-looking strings containing session-specific HMAC tokens.
- **Single quality:** No multi-quality variants (unlike mewstream/cinewave2).

---

## 6. Fake File Extensions on Video Segments

This is the most notable anti-filtering technique. Video segments are served with **entirely fake file extensions** to bypass:
- Corporate firewall MIME-type filtering
- ISP traffic shaping that throttles `.ts`/`.mp4` video traffic
- CDN caching rules targeting video content

### Observed Extension Patterns

| Fake Extension | CDN Subdomains | Example |
|---------------|---------------|---------|
| `.jpg` | `h9c5b.cinewave2.site`, `pru.ultracloud.cc` | `seg-152-f1-v1-a1.jpg` |
| `.html` | `u0Dx.sparqle.click` | `seg-153-f1-v1-a1.html` |
| `.js` | `f5ym.glimmeron.click` | `seg-154-f1-v1-a1.js` |
| `.css` | `v2Xy.orbitra.click` | `seg-4-f1-v1-a1.css` |
| `.txt` | Multiple CDNs | `seg-155-f1-v1-a1.txt` |
| `.png` | Multiple CDNs | `seg-156-f1-v1-a1.png` |
| `.webp` | Multiple CDNs | `seg-157-f1-v1-a1.webp` |
| `.ico` | Multiple CDNs | `seg-158-f1-v1-a1.ico` |

### How It Works

1. The **HLS playlist** (`.m3u8`) lists segment URLs with these fake extensions.
2. The **CDN servers** serve the files with mismatched `Content-Type` headers (`image/jpeg`, `text/html`, `application/javascript`, etc.).
3. The response bodies are **binary HLS segment data** (often base64-encoded, responses start with `R0AA...`).
4. The **hls.js player** (via JWPlayer) ignores the Content-Type and parses the binary as MPEG-TS.

### CDN Subdomain Rotation

Segments within the same playlist rotate across multiple subdomains:

| Subdomain | Base Domain | Segment Range |
|-----------|-------------|--------------|
| `h9c5b` | `cinewave2.site` | Early segments |
| `k8v2x` | `cinewave2.site` | Mid segments |
| `u0Dx` | `sparqle.click` | Various |
| `f5ym` | `glimmeron.click` | Various |
| `v2Xy` | `orbitra.click` | Late segments |

> The subdomain prefixes (`h9c5b`, `k8v2x`, `u0Dx`, `f5ym`, `v2Xy`) appear to be **programmatically generated per session**, likely using a hash of the session ID + segment index.

### Failed Requests
Some segments returned `Status: 0` with `Content-Type: application/x-unknown` and `Size: -1`, indicating certain fake-extension requests failed to resolve — likely load balancer routing issues for less common CDN nodes.

---

## 7. JWPlayer Setup

### Player Version & Source
- **Version:** 8.33.2
- **CDN Source:** `https://ssl.p.jwpcdn.com/player/v/8.33.2/jwpsrv.js`
- **Player ID:** `megaplay-player`
- **Playback Engine:** `hlsjs` (hls.js library, not native HLS)

### Analytics Pings to `prd.jwpltx.com`

The player sends detailed analytics to JWPlayer's analytics endpoint:

```
https://prd.jwpltx.com/v1/jwplayer6/ping.gif?{params}
```

**Key parameters:**
| Param | Value | Meaning |
|-------|-------|---------|
| `e` | `pa`, `s`, `bw` | Event type: play attempt, start, bandwidth report |
| `mu` | (master.m3u8 URL) | Media URL being played |
| `pv` | `8.33.2` | Player version |
| `cdid` | `megaplay-player` | Custom player identifier |
| `pp` | `hlsjs` | Playback plugin (hls.js) |
| `ppm` | `VOD` | Playback mode (Video on Demand) |
| `aid` | `GCCG` | Analytics account ID |
| `pid` | `aVr2lJgW` | Player instance ID |
| `pl` | `756` | Playlist ID |
| `vh` | `1080` | Viewport height |
| `vw` | `1920` | Viewport width |

### Custom Player Files

| File | Size | Notes |
|------|------|-------|
| `lib/e1-player.min.js` | 228 KB | Heavily obfuscated with hex-encoded strings and index-based lookups (`_0xd148` pattern) |
| `lib/app.main.js` | 1.9 KB | Contains premium country list, fallback/ad URLs |

---

## 8. Subtitle Delivery

### Source
```
https://1oe.lostproject.club/subtitles/{hash}.vtt
```

### Format
- WebVTT (`.vtt`)
- Served as `application/octet-stream`
- Content begins with `WEBVTT` header

### Languages Identified

| Language | File Pattern |
|----------|-------------|
| English | `sub_eng-0.vtt`, `eng-2.vtt` |
| Chinese | `chi-6.vtt` |
| Indonesian | `ind-3.vtt` |
| Thai | `tha-4.vtt` |
| Vietnamese | `vie-5.vtt` |
| Portuguese | `por-*.vtt` (from getSources track data) |
| Spanish | `spa-*.vtt` (from getSources track data) |

### Languages per Episode

| Episode ID | Languages |
|-----------|-----------|
| 176144 | English |
| 174707 | English |
| 7921 | Chinese, English, Indonesian, Thai, Vietnamese |
| 7914 | English |
| 135223 | English, Portuguese, Spanish |

---

## 9. VaultCeaser mapping (this repo)

The FastAPI app implements the same **referrer / Origin** expectations described above: pipe responses include per-stream `referer` fields; when traffic is proxied, `/api/cdn-hls` can carry `r=` so upstream CDNs see the host they allow (e.g. megaplay vs vidwish). For **upstream** embed mode, the watch UI loads the real **`stream_upstream_base`** JWPlayer page (e.g. `vidwish.live/stream/s-2/{numericId}/sub`) after resolving numeric IDs from pipe payloads.

**Operational diagram** (how requests layer in production):

```
  [ Browser: Next.js or /watch ]
           |
           +----------------------->  AniList  (metadata: /api/anime/..., homepage, etc.)
           |
           v
  [ VaultCeaser :8080 ]
           |
           +--- call_pipe --->  miruro_base  --->  /api/secure/pipe?e=...
           |         \----->  pipe_fallback_bases...   (same contract; ordered + circuit TTL)
           |
           +--- iframe src --->  stream_upstream_base/stream/s-2/{id}/{sub|dub}   [JWPlayer -> CDN]
           |
           +--- optional --->  /api/cdn-hls?u=...&r=...   [synthetic / proxy embed modes only]
```

Full config table, health endpoint, and a **Mermaid** version of this flow live in the repository root [`README.md`](../README.md).
