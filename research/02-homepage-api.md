# Homepage Anime Showcase & Background

> Analysis of `HTTPToolkit_2026-05-16_05-40.har` (586 entries)

---

## Table of Contents

1. [The /api/secure/pipe Proxy Pattern](#1-the-apisecurepipe-proxy-pattern)
2. [Three Homepage Data Calls](#2-three-homepage-data-calls)
3. [Banner and Cover Image Sources](#3-banner-and-cover-image-sources)
4. [AniList OAuth Configuration](#4-anilist-oauth-configuration)
5. [Obfuscation Keys](#5-obfuscation-keys)
6. [Ultracloud.cc Proxy URLs](#6-ultracloudcc-proxy-urls)

---

## 1. The /api/secure/pipe Proxy Pattern

This is the **core obfuscation technique** for all API communication. Every API call from the frontend goes through a **single proxy endpoint**:

```
https://www.miruro.to/api/secure/pipe?e={base64_encoded_json}
```

### How It Works

The `e=` query parameter is a **base64-encoded JSON object** containing the actual API request details:

```json
{
  "path": "search/browse",
  "method": "GET",
  "query": { "type": "ANIME", "status": "RELEASING", "sort": "TRENDING_DESC", "page": 1, "perPage": 12 },
  "body": null
}
```

### Decoded Schema

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Internal API path (e.g., `search`, `search/browse`, `schedule`, `sources`, `info/{id}`, `episodes`) |
| `method` | string | HTTP method (`GET`, `POST`) |
| `query` | object | URL query parameters for the proxied request |
| `body` | object/null | Request body (for POST requests) |

### Security Mechanisms

1. **Single endpoint exposure:** External attackers only see one endpoint (`/api/secure/pipe`) — the actual API structure is hidden.
2. **Base64 encoding:** While base64 is not encryption, it prevents casual inspection of API paths.
3. **Pipe obfuscation key:** `VITE_PIPE_OBF_KEY` (see Section 5) likely encrypts or HMAC-signs the payload to prevent request tampering.
4. **Server-side validation:** The backend decodes the `e` parameter, validates it, and proxies the request to the internal API.

### All Observed Pipe Paths

| Path | Purpose |
|------|---------|
| `search` | Free-text search & movie search |
| `search/browse` | Browse anime by status/sort |
| `schedule` | Airing schedule |
| `info/anilist/{id}` | Anime info from AniList |
| `info/{id}` | Combined anime info |
| `episodes` | Episode list for an anime |
| `sources` | Video source URLs |

---

## 2. Three Homepage Data Calls

The homepage makes exactly **three categories** of parallel data requests to populate the grid and hero sections:

### 2.1 Trending Airing Anime (Main Grid)

```
path: "search/browse"
query: {
  "type": "ANIME",
  "status": "RELEASING",
  "sort": "TRENDING_DESC",
  "page": 1,
  "perPage": 12
}
```

- **Purpose:** Populates the main anime grid with currently airing shows sorted by trending score.
- **Response:** 12 anime entries with titles, cover images, airing status, episodes count.
- **Display:** Grid of anime cards, each linking to `/watch/{anilistId}`.

### 2.2 Trending Finished Anime (Secondary Grid)

```
path: "search/browse"
query: {
  "type": "ANIME",
  "sort": "TRENDING_DESC",
  "status": "FINISHED",
  "endDate_greater": 20250515,
  "perPage": 12
}
```

- **Purpose:** Recently completed shows (within the last day — `endDate_greater: 20250515`).
- **Note:** The `endDate_greater` value (`20250515`) is the capture date, suggesting this filter shows shows that finished recently.

### 2.3 Airing Schedule (Calendar/Upcoming)

**Call 1 — Latest schedule:**
```
path: "schedule"
query: { "sort": ["TIME_DESC"], "newest": true }
```

**Call 2 — Weekly range:**
```
path: "schedule"
query: { "startAt": 1778338800, "endAt": 1778943600, "sort": ["TIME"] }
```

- Timestamps decode to: `startAt = 2026-05-09 22:00:00 UTC`, `endAt = 2026-05-16 22:00:00 UTC`
- This is a **7-day schedule window** for the current airing week.
- **Display:** Schedule sidebar or calendar showing which episodes air on which days.

### 2.4 Top Movies (Movies Section)

```
path: "search"
query: {
  "format": "MOVIE",
  "sort": "SCORE_DESC",
  "limit": 12,
  "offset": 0
}
```

- **Purpose:** Top 12 anime movies sorted by score.
- **Display:** Movie cards in a dedicated section.

### 2.5 Popular Upcoming Anime

```
path: "search/browse"
query: {
  "type": "ANIME",
  "status": "NOT_YET_RELEASED",
  "sort": "POPULARITY_DESC",
  "page": 1,
  "perPage": 12
}
```

- **Purpose:** Upcoming/anticipated shows for a "Coming Soon" section.

### Request Timeline

All homepage calls fire **in parallel** when the page loads:
```
05:39:25 — search/browse (trending airing)
05:39:25 — search/browse (popular upcoming)
05:39:25 — search (top movies)
05:39:25 — search/browse (trending finished)
05:39:26 — schedule (newest)
05:39:26 — schedule (weekly range)
```

---

## 3. Banner and Cover Image Sources

**184 image requests** were captured from three primary CDN sources:

### Source Comparison

| Source | Type | URL Pattern | Usage |
|--------|------|-------------|-------|
| **AniList CDN** (`s4.anilist.co`) | Primary artwork | `/image/anime/{size}/{id}.{ext}` | Cover art in grids, small thumbnails |
| **TMDB** (`image.tmdb.org`) | Backgrounds/posters | `/t/p/original/{path}.webp` | Banner images, hero backgrounds |
| **TheTVDB** (`artworks.thetvdb.com`) | Series art | `/v4/artwork/{path}` | Season posters, clear logos |

### Image Sizes (AniList)

- `small` — Thumbnail
- `medium` — Grid card
- `large` — Banner/hero

### Image Formats
- `image/jpeg` — Most common
- `image/png` — For artwork with transparency (TVDB logos)
- `image/webp` — Modern format (TMDB)

### Loading Strategy

Images appear to be loaded lazily as the user scrolls through the grid. The homepage HTML loads the page structure first, then fetches image URLs from AniList metadata returned by the pipe API calls.

---

## 4. AniList OAuth Configuration

### Source: `env2.js`

```javascript
window.env = JSON.parse("{
  \"VITE_ANILIST_CLIENT_ID\":\"20656\",
  \"VITE_ANILIST_REDIRECT_URI\":\"https://www.miruro.to/callback\",
  \"VITE_PIPE_OBF_KEY\":\"71951034f8fbcf53d89db52ceb3dc22c\",
  \"VITE_PROXY_A\":\"https://pro.ultracloud.cc/\",
  \"VITE_PROXY_B\":\"https://pru.ultracloud.cc/\",
  \"VITE_PROXY_OBF_KEY\":\"a54d389c18527d9fd3e7f0643e27edbe\"
}");
```

### OAuth Flow

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Client ID** | `20656` | AniList application ID — identifies Miruro as an OAuth client |
| **Redirect URI** | `https://www.miruro.to/callback` | OAuth callback — AniList redirects users here after authorization |

### How It's Used

1. User clicks "Login with AniList" on Miruro.
2. Miruro redirects to `https://anilist.co/api/v2/oauth/authorize?client_id=20656&redirect_uri=https://www.miruro.to/callback&response_type=code`.
3. User authorizes on AniList.
4. AniList redirects to `https://www.miruro.to/callback?code={auth_code}`.
5. Miruro exchanges the auth code for an access token.
6. The token is used to fetch/manage the user's anime list (watching, completed, plan-to-watch, etc.).

---

## 5. Obfuscation Keys

### VITE_PIPE_OBF_KEY

```
Value: 71951034f8fbcf53d89db52ceb3dc22c
Length: 32 hex characters (128 bits)
Format: Looks like MD5 hash
```

**Purpose:** Used to obfuscate the `e=` parameter in the pipe API. The base64 payload is likely:
- Encrypted with AES-128 using this key, OR
- HMAC-signed with this key to prevent tampering

### VITE_PROXY_OBF_KEY

```
Value: a54d389c18527d9fd3e7f0643e27edbe
Length: 32 hex characters (128 bits)
Format: Looks like MD5 hash
```

**Purpose:** Used to generate the long, obfuscated URL paths on `pru.ultracloud.cc`. These paths are **session-specific HMAC tokens** that:
- Encode the user/device session
- Are time-limited (preventing URL replay attacks)
- Are generated server-side using this key

### How Obfuscation Flows

```
User clicks "Watch"
  → Frontend builds API request JSON
  → Encrypts/HMACs JSON with VITE_PIPE_OBF_KEY
  → Base64 encodes the result
  → Sends to /api/secure/pipe?e={encoded}
  
Backend receives request
  → Base64 decodes `e` parameter
  → Validates HMAC/decrypts with VITE_PIPE_OBF_KEY
  → Parses the decoded JSON
  → Routes to internal API
  → Fetches data from AniList or database
  → Returns result
```

---

## 6. Ultracloud.cc Proxy URLs

### Configuration

```javascript
VITE_PROXY_A: "https://pro.ultracloud.cc/"
VITE_PROXY_B: "https://pru.ultracloud.cc/"
```

### Observed Usage

| Proxy | URL | Captured in HAR? | Usage |
|-------|-----|------------------|-------|
| **PROXY_A** | `https://pro.ultracloud.cc/` | ❌ Not observed | Possibly a fallback/additional CDN |
| **PROXY_B** | `https://pru.ultracloud.cc/` | ✅ Actively used | Full HLS streaming (all traffic to ultracloud) |

### PROXY_B URL Structure

All requests follow this pattern:

```
https://pru.ultracloud.cc/{long_obfuscated_path}/{filename}
```

Where `{long_obfuscated_path}` is a ~200+ character string like:

```
zTlM7GtoUrClhoUISgrUh4siT_N7NhOxp4iAS01Tn9vEIBelIX1NrfyGyFYME96IxHQLqS5hHKvhhcFUDBbVi8B0Df4rM0j7toPIAVgU34uWdA35KmNM_rWDkQEMEomOxHgMrS5nSPnkyJ0LUAmG29w...
```

### File Types Served

| File | Purpose |
|------|---------|
| `pl.m3u8` | HLS master playlist |
| `master.m3u8` | HLS master playlist (used by JWPlayer) |
| `seg.jpg` | AES-128 encrypted video segment + decryption key |

### Request Flow

```
getSources returns master.m3u8 URL on PROXY_B
  → Player requests master.m3u8
    → Player selects quality variant
      → Player downloads AES key from seg.jpg
        → Player decrypts and plays seg.jpg segments
```

### Security

The obfuscated path encodes:
- Session identifier
- Timestamp (time-limited — probably 24h based on `ttl: 86400`)
- HMAC signature (generated with `VITE_PROXY_OBF_KEY`)
- Content identifier

This makes direct URL sharing/leeching practically impossible — the URL expires after a set time.
