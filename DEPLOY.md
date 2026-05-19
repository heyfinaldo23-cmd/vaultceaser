# Deployment Guide — VaultCeaser

## Architecture

| Layer | Service | Purpose |
|-------|---------|---------|
| Frontend | Vercel | Next.js app (`web/`) |
| Backend | Your own server (VPS/Railway/Render) | FastAPI `server.py` |
| Database | Supabase | Auth + user data |
| Anime Data | AniList GraphQL + Anikoto.tv scraping | All metadata & streams |

---

## 1. Backend (server.py)

### Requirements

```bash
pip install fastapi uvicorn httpx wreq-python structlog colorama
```

### Environment Variables

Create a `.env` or set these in your hosting platform:

```env
# Optional: override the default stream/megaplay upstream
STREAM_UPSTREAM_BASE=https://megaplay.buzz

# Supabase (if you add server-side auth checks)
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...

# Optional: custom port (default 8000)
PORT=8000
```

### Run locally

```bash
python server.py
# or with auto-reload:
python server.py --reload
```

### Hosting options (pick one)

#### Railway
1. Create a new project → "Deploy from GitHub repo"
2. Set start command: `python server.py`
3. Add the env vars above
4. Railway auto-detects port from `$PORT`

#### Render (free tier)
1. New → Web Service → connect repo
2. Build command: `pip install -r requirements.txt`
3. Start command: `python server.py`
4. Set env vars in Render dashboard

#### VPS (Ubuntu)
```bash
# install deps
pip install fastapi uvicorn httpx wreq-python structlog colorama

# run with systemd or screen
uvicorn server:app --host 0.0.0.0 --port 8000 --workers 2
```

> The `server.py` file has a `requirements.txt`-compatible deps list — just `pip freeze > requirements.txt` after installing.

---

## 2. Frontend (Vercel)

### Step-by-step

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select repo `heyfinaldo23-cmd/vaultceaser`
3. Set **Root Directory** to `web`
4. Framework preset: **Next.js** (auto-detected)
5. Add the following environment variables:

### Required Environment Variables (Vercel)

```env
# Your backend URL (wherever you hosted server.py)
NEXT_PUBLIC_API_URL=https://your-backend.railway.app

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

6. Click **Deploy**

### After deployment

- Your frontend will be at `https://vaultceaser.vercel.app` (or your custom domain)
- Make sure `NEXT_PUBLIC_API_URL` points to the running backend

---

## 3. Supabase Setup

1. Go to [app.supabase.com](https://app.supabase.com) → New project
2. Give it a name (e.g. `vaultceaser`) and a strong DB password
3. Wait for provisioning (~2 min)
4. Go to **Settings → API** and copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon / public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
5. Go to **Authentication → Providers** and enable:
   - Email (enabled by default)
   - Google (optional — add OAuth client ID/secret from Google Cloud Console)
6. The schema auto-creates for auth (users, sessions). For custom tables (watchlist, history), run migrations from `supabase/migrations/` if they exist.

### Auth redirect URL
In Supabase → Authentication → URL Configuration:
- **Site URL**: `https://vaultceaser.vercel.app`
- **Redirect URLs**: `https://vaultceaser.vercel.app/**`

---

## 4. Custom Domain (Optional)

In Vercel project settings → Domains → Add `yourdomain.com`.  
Point your DNS `CNAME` → `cname.vercel-dns.com`.

---

## 5. Quick Sanity Check After Deploy

```bash
# Backend health
curl https://your-backend.railway.app/health

# AniList search
curl "https://your-backend.railway.app/api/search?q=naruto"

# Anikoto search (should include extra results not on AniList)
curl "https://your-backend.railway.app/api/search?q=devil+may+cry"

# Episodes
curl "https://your-backend.railway.app/api/anime/103/episodes"
```

---

## 6. Summary Checklist

- [ ] `server.py` deployed and `/health` returns `{"status":"ok"}`
- [ ] Vercel project created with `web/` as root dir
- [ ] `NEXT_PUBLIC_API_URL` set in Vercel to backend URL
- [ ] `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` set in Vercel
- [ ] Supabase auth redirect URLs configured
- [ ] First visit to the site works, search returns results
