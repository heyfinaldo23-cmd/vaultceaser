# Architecture Diagrams

> Mermaid diagrams illustrating the Megaplay.buzz streaming pipeline, homepage data flow, and search feature.

> **Note:** These diagrams use [Mermaid](https://mermaid.js.org/) syntax. They render natively on GitHub, in VS Code with the Mermaid plugin, or at [mermaid.live](https://mermaid.live).

---

## 1. Complete Streaming Pipeline

```mermaid
sequenceDiagram
    participant User as User's Browser (Miruro.to)
    participant MP as megaplay.buzz
    participant API as Backend API
    participant ANI as AniList API
    participant CDN as Video CDN
    participant SUB as Subtitle CDN
    participant JWP as JWPlayer Analytics

    User->>MP: 1. GET /stream/s-2/{episodeId}/{type}
    Note over User,MP: Referer: miruro.to

    MP->>User: 2. Returns iframe HTML page
    
    User->>MP: 3. GET /stream/getSources?id={episodeId}
    Note over User,MP: Referer: megaplay.buzz/stream/s-2/...
    
    MP->>User: 4. Returns JSON with master.m3u8 URL + subtitles + intro/outro

    User->>CDN: 5. GET {CDN}/master.m3u8
    Note over User,CDN: CDN = mewstream.buzz or cinewave2.site
    CDN->>User: 6. Returns master playlist (3 quality variants)

    User->>CDN: 7. GET {CDN}/index-f1.m3u8 (1080p variant)
    CDN->>User: 8. Returns index playlist with segment URLs
    
    loop Every ~10 seconds
        User->>CDN: 9. GET seg-X.{jpg|html|js|css|png}
        Note over User,CDN: Rotated subdomains: h9c5b, u0Dx, f5ym, v2Xy
        CDN->>User: 10. Returns binary video data (disguised)
    end

    User->>SUB: 11. GET /subtitles/{hash}.vtt
    SUB->>User: 12. Returns WebVTT subtitle tracks

    User->>JWP: 13. POST ping.gif (analytics)
    Note over User,JWP: e=pa|s|bw, mu=master.m3u8, pv=8.33.2
```

---

## 2. Anti-Hotlinking & Referrer Whitelist Flow

```mermaid
flowchart TD
    A[User Browser] -->|Referer: miruro.to| B[Megaplay Backend]
    
    B --> C{Check /domains whitelist}
    C -->|Referer NOT in whitelist| D[Reject: 403/404]
    C -->|Referer IS in whitelist| E{Validate HMAC session token}
    
    E -->|Invalid token| D
    E -->|Valid token| F{Check TTL}
    
    F -->|Expired > 24h| D
    F -->|Valid session| G[Serve Content]
    
    G --> H{Content type}
    H -->|AES-128 encrypted| I[Serve seg.jpg + key]
    H -->|Clear text| J[Serve seg.{fake ext}]
    
    subgraph Whitelist[/domains endpoint]
        K[Base64 decoded JSON array]
        K --> L[~40 domains: 9anime, AniWave, HiAnime...]
    end
    
    B -->|GET /domains?h=2026051520| K
```

---

## 3. Homepage Data Loading

```mermaid
flowchart LR
    subgraph Browser[Miruro Homepage]
        direction TB
        H[HTML Loaded] --> JS[env2.js loaded]
        JS --> P[Pipe Proxy Setup]
    end
    
    subgraph API[All via /api/secure/pipe?e=]
        direction TB
        T1[search/browse<br/>trending airing<br/>12 results]
        T2[search/browse<br/>trending finished<br/>12 results]
        T3[search/browse<br/>popular upcoming<br/>12 results]
        T4[search<br/>top movies<br/>12 results]
        T5[schedule<br/>weekly schedule<br/>7 days]
    end
    
    P --> T1
    P --> T2
    P --> T3
    P --> T4
    P --> T5
    
    T1 --> G1[Anime Grid - Airing Now]
    T2 --> G2[Anime Grid - Recently Finished]
    T3 --> G3[Coming Soon Section]
    T4 --> G4[Movies Section]
    T5 --> G5[Schedule Sidebar]
    
    subgraph Images[Image CDNs]
        I1[s4.anilist.co - Cover Art]
        I2[image.tmdb.org - Backdrops]
        I3[artworks.thetvdb.com - Logos]
    end
    
    G1 --> I1
    G2 --> I1
    G3 --> I1
    G4 --> I2
```

---

## 4. Search Feature Flow

```mermaid
sequenceDiagram
    participant User as User
    participant UI as Search UI
    participant P as Pipe Proxy
    participant BE as Backend
    participant C as Cache/DB

    User->>UI: Types "blea"
    Note over UI: 300ms debounce timer
    UI->>UI: Timer fires
    
    UI->>P: GET /api/secure/pipe?e={base64("{query: 'bleac', limit: 5}")}
    P->>BE: Decrypts e=, routes to search
    BE->>C: Query AniList for "bleac"
    C->>BE: Results (gzip+base64)
    BE->>P: Encrypted response
    P->>UI: Decoded results
    
    User->>UI: Types "h" → "bleach"
    UI->>P: GET /api/secure/pipe?e={base64("{query: 'bleach', limit: 5}")}
    P->>BE: Search "bleach"
    BE->>C: Query AniList
    C->>BE: Results
    BE->>P: Results
    P->>UI: Show 5 results in dropdown
    
    User->>UI: Clicks search results area
    UI->>P: GET /api/secure/pipe?e={base64("{query: 'bleach', limit: 15}")}
    P->>BE: Search expanded
    BE->>C: Query with limit 15
    C->>BE: More results
    P->>UI: Show 15 results in expanded view
    
    User->>UI: Selects "Adventure" genre filter
    UI->>P: GET /api/secure/pipe?e={base64("{query: 'bleach', genres: ['Adventure'], limit: 15}")}
    P->>BE: Filtered search
    BE->>C: Query with genre filter
    P->>UI: Filtered results
    
    User->>UI: Clicks "Bleach" result (AniList ID: 269)
    UI->>User: Navigate to /watch/269
```

---

## 5. Multi-Layer Obfuscation Stack

```mermaid
flowchart TD
    subgraph Client[Browser - Client Side]
        A[e1-player.min.js<br/>Obfuscated JS]
        B[app.main.js<br/>Domain config]
        C[env2.js<br/>Keys & endpoints]
    end
    
    subgraph API_Layer[API Communication]
        D[Gzip + Base64<br/>Response encoding]
        E[HMAC/AES signed<br/>Pipe payload]
        F[Single endpoint<br/>/api/secure/pipe?e=]
    end
    
    subgraph Streaming[Video Delivery]
        G[Referrer whitelist<br/>/domains check]
        H[CDN subdomain rotation]
        I[Fake file extensions<br/>.jpg .html .js .css]
        J[AES-128 encryption<br/>seg.jpg + key file]
        K[Session HMAC paths<br/>VITE_PROXY_OBF_KEY signed]
    end
    
    subgraph Data[Data Obfuscation]
        L[Base64 encoded<br/>AniList IDs]
        M[Separate sub/dub IDs<br/>Different categories]
        N[Time-limited URLs<br/>TTL: 86400s]
    end
    
    Client --> API_Layer
    API_Layer --> Streaming
    Streaming --> Data
    
    style A fill:#ff6b6b
    style E fill:#ff6b6b
    style G fill:#ff6b6b
    style I fill:#ff6b6b
    style J fill:#ff6b6b
    style K fill:#ff6b6b
```

---

## 6. Network Host Map

```mermaid
graph TD
    subgraph Frontend
        M[miruro.to<br/>Main website]
        MB[megaplay.buzz<br/>Streaming iframe]
    end
    
    subgraph Configuration
        E[env2.js<br/>Keys & proxies]
        A[app.main.js<br/>Domains & config]
        P[e1-player.min.js<br/>Player logic]
    end
    
    subgraph API
        PP[/api/secure/pipe?e=<br/>Universal proxy]
        GS[/stream/getSources<br/>Video metadata]
        DM[/domains?h=<br/>Referrer whitelist]
    end
    
    subgraph Data_Sources
        AL[s4.anilist.co<br/>Anime metadata & art]
        TM[image.tmdb.org<br/>Movie backdrops]
        TV[artworks.thetvdb.com<br/>Series artwork]
        YT[i.ytimg.com<br/>Trailer thumbnails]
    end
    
    subgraph CDN_Streaming
        MW[cdn.mewstream.buzz<br/>HLS video]
        CW[s2.cinewave2.site<br/>HLS video]
        UC[pru.ultracloud.cc<br/>AES encrypted HLS]
        SQ[u0Dx.sparqle.click<br/>Segment delivery]
        GL[f5ym.glimmeron.click<br/>Segment delivery]
        OR[v2Xy.orbitra.click<br/>Segment delivery]
        CW2[h9c5b.cinewave2.site<br/>Segment delivery]
    end
    
    subgraph Subtitles
        LP[1oe.lostproject.club<br/>VTT subtitles]
    end
    
    subgraph Analytics
        JW[prd.jwpltx.com<br/>JWPlayer pings]
        PL[plausible.io<br/>Site analytics]
    end
    
    M --> PP
    M --> E
    M --> A
    M --> P
    M --> DM
    M --> AL
    M --> TM
    M --> TV
    M --> YT
    
    M --> MB
    MB --> GS
    MB --> MW
    MB --> CW
    MB --> UC
    
    GS --> LP
    
    MW --> SQ
    MW --> GL
    MW --> OR
    CW --> CW2
    CW --> OR
    
    M --> JW
    M --> PL
```
