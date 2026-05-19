# Search Feature — End-to-End Trace

> Analysis of `HTTPToolkit_2026-05-16_05-40.har` (586 entries)

---

## Table of Contents

1. [Overview](#overview)
2. [Incremental/Live Search (Typing Pattern)](#1-incrementallive-search-typing-pattern)
3. [Full Search Query Parameters](#2-full-search-query-parameters)
4. [How Search Results Map to Watch Pages](#3-how-search-results-map-to-watch-pages)
5. [Cover Image Sources](#4-cover-image-sources)
6. [Search/Browse vs. Search](#5-searchbrowse-vs-search)

---

## Overview

The search feature uses the same `/api/secure/pipe` proxy as all other API calls. All search queries are encoded as `base64` JSON and sent to:

```
https://www.miruro.to/api/secure/pipe?e={base64_encoded_json}
```

There are two distinct search paths:
- **`search`** — Free-text keyword search (used for the search bar)
- **`search/browse`** — Filtered browsing (used for homepage grids and genre filters)

---

## 1. Incremental/Live Search (Typing Pattern)

### Captured Sequence

The HAR file captures a user searching for **"Bleach"** in real-time:

| # | Time | Query | Params | Note |
|---|------|-------|--------|------|
| 1 | **05:39:32.717** | `"bleac"` | `limit: 5, offset: 0, type: ANIME, sort: POPULARITY_DESC` | 🔴 User only typed "bleac" (4/6 chars) |
| 2 | **05:39:33.055** | `"bleach"` | `limit: 5, offset: 0, type: ANIME, sort: POPULARITY_DESC` | Full word, same params |
| 3 | **05:40:00.013** | `"bleach"` | `limit: 15, offset: 0, sort: POPULARITY_DESC, type: ANIME` | Expanded results (clicked search or pressed Enter) |
| 4 | **05:40:22.967** | `"bleach"` | `limit: 15, offset: 0, sort: POPULARITY_DESC, genres: [Adventure], type: ANIME` | Genre filter applied |

### Key Observations

**Debounce timing:** Only **338ms** between calls #1 and #2. This indicates:
- A debounce timer of approximately **300ms**
- The search fires on **every keystroke**, not just on Enter

**Progressive refinement pattern:**

```
Type "b"   → (debounce) → fire search("b")
Type "l"   → (reset debounce)
Type "e"   → (reset debounce)
Type "a"   → (reset debounce)
Type "c"   → (debounce fires) → fire search("bleac")     ← Call #1
Type "h"   → (debounce fires) → fire search("bleach")     ← Call #2
```

**After search results appear:**
- User sees results, clicks the search results area (not a specific result yet)
- `limit` increases from 5 to 15 — the UI expanded the dropdown to show more results
- User navigates to the genre filter and selects "Adventure" — triggers Call #4

### UI Behavior Inferred

1. **Initial typing (limit: 5):** Small autocomplete dropdown — quick, minimal results
2. **Focus on search area (limit: 15):** Expanded dropdown with more results
3. **Genre filter applied:** Results filtered server-side

---

## 2. Full Search Query Parameters

### 2.1 Free-Text Search (`path: "search"`)

```
pipe?e={base64({"path":"search","method":"GET","query":{...}})}
```

| Parameter | Values Observed | Description |
|-----------|----------------|-------------|
| `q` | `"bleac"`, `"bleach"` | Search query string |
| `limit` | `5`, `15` | Max results per page |
| `offset` | `0`, `15` | Pagination offset |
| `type` | `"ANIME"` | Media type filter |
| `sort` | `"POPULARITY_DESC"`, `"SCORE_DESC"` | Sort order |
| `genres` | `["Adventure"]` | Genre filter (array) |
| `format` | `"MOVIE"` | Format filter |

### 2.2 Browse Search (`path: "search/browse"`)

Used for homepage grids and category pages:

| Parameter | Values Observed | Description |
|-----------|----------------|-------------|
| `type` | `"ANIME"` | Always `ANIME` |
| `status` | `"RELEASING"`, `"FINISHED"`, `"NOT_YET_RELEASED"` | Airing status |
| `sort` | `"TRENDING_DESC"`, `"POPULARITY_DESC"` | Sort order |
| `page` | `1` | Page number |
| `perPage` | `12` | Results per page |
| `endDate_greater` | `20250515` | Filter finished anime by end date |

### 2.3 Search Response

The search response is returned as a **base64-encoded, Gzip-compressed binary payload** (identified by the `H4sIAAAA...` Gzip magic bytes in the response). This is an additional obfuscation layer beyond the pipe proxy.

The decoded response contains an array of anime objects from AniList with:
- `id` (AniList ID)
- `title` (romaji, english, native)
- `coverImage` (URLs for different sizes)
- `format` (TV, MOVIE, ONA, etc.)
- `status` (RELEASING, FINISHED, etc.)
- `episodes` (count)
- `genres` (array)
- `averageScore`
- `startDate` / `endDate`

---

## 3. How Search Results Map to Watch Pages

### Navigation Flow

```
User types "bleach" in search bar
  → API returns anime list with AniList IDs
  → Results displayed as cards in dropdown
  → User clicks "Bleach" (AniList ID: 269)
  → Browser navigates to:
    https://www.miruro.to/watch/269
```

### Watch Page Load Sequence

When the watch page loads, it fires these pipe calls in sequence:

```
Step 1: path: "info/anilist/{id}"  (e.g., /info/anilist/269)
        → Gets AniList metadata, cover images, synopsis, genres

Step 2: path: "info/{id}"  (e.g., /info/269)
        → Gets combined info (episode count, streaming links, etc.)

Step 3: path: "episodes"
        query: { "anilistId": "269" }
        → Gets all episode IDs and metadata for the anime

Step 4: path: "sources"
        query: { "episodeId": "...", "provider": "bee", "category": "dub/ssub", "ttl": 86400 }
        → Gets video source URLs for the selected episode
```

### URL Structure
```
Watch page:    https://www.miruro.to/watch/{anilistId}
Stream embed:  https://megaplay.buzz/stream/s-2/{episodeId}/{type}
```

---

## 4. Cover Image Sources

Search result cover images come from **AniList CDN**:

```
https://s4.anilist.co/image/anime/{size}/{id}.{format}
```

| Size | Resolution | Usage |
|------|-----------|-------|
| `small` | ~100×150px | Thumbnails in search dropdown |
| `medium` | ~200×300px | Grid cards |
| `large` | ~400×600px | Detail pages / hero banners |

### Additional Sources for Banners

When viewing a specific anime page (after clicking a search result), additional images are loaded from:

| Source | Type | Example |
|--------|------|---------|
| TMDB (`image.tmdb.org`) | Backdrops | Wide banner images for hero sections |
| TheTVDB (`artworks.thetvdb.com`) | Clear logos | Transparent logo overlays for branding |
| YouTube (`i.ytimg.com`) | Trailers | `maxresdefault.jpg` for video thumbnails |

---

## 5. Search/Browse vs. Search

| Feature | `search` | `search/browse` |
|---------|----------|-----------------|
| **Path** | `search` | `search/browse` |
| **User-triggered?** | Yes (search bar) | No (homepage/auto-load) |
| **Query param** | `q` (keyword) | `status` / `sort` / `format` |
| **Pagination** | `limit` + `offset` | `page` + `perPage` |
| **Response** | Full anime objects | Full anime objects |
| **Caching** | Likely not cached | Likely cached (homepage data doesn't change often) |

### Example: Search vs Browse

**Search for "Bleach":**
```json
{ "path": "search", "query": { "q": "bleach", "limit": 5, "sort": "POPULARITY_DESC", "type": "ANIME" } }
```

**Browse trending airing:**
```json
{ "path": "search/browse", "query": { "type": "ANIME", "status": "RELEASING", "sort": "TRENDING_DESC", "page": 1, "perPage": 12 } }
```
