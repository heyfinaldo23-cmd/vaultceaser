# Deployment Guide — VaultCeaser

## Architecture (simple)

```
Browser  →  Vercel (Next.js)  →  37.114.37.107:8080 (FastAPI, already running)
                 ↓
           Neon Postgres (free)
```

- **Frontend**: Vercel (free hobby tier)
- **Backend**: Your VPS at `37.114.37.107:8080` (already up)
- **Database**: Neon serverless Postgres (free tier, no server to manage)

Vercel **proxies** all `/api/anime/*`, `/api/search`, etc. calls to your backend,
so the browser never hits plain HTTP — no mixed-content warnings.

---

## Step 1 — Database (Neon, ~5 min)

1. Go to [neon.tech](https://neon.tech) → Sign up (free)
2. Create a new project (any name, pick closest region)
3. On the dashboard → **Connection string** → copy the `postgresql://...` URL
4. Keep it, you'll use it in Step 2

**Run migrations once** (from your local machine or any machine with Node):

```bash
cd web
DATABASE_URL="postgresql://your-neon-url" npx drizzle-kit push
```

This creates the 4 tables (`ov_users`, `ov_bookmarks`, `ov_watch_progress`, `ov_notifications`).

---

## Step 2 — Vercel Deployment

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select repo `heyfinaldo23-cmd/vaultceaser`
3. **Root Directory** → set to `web`
4. Framework: **Next.js** (auto-detected)
5. Add these **Environment Variables**:

| Variable | Value |
|----------|-------|
| `BACKEND_URL` | `http://37.114.37.107:8080` |
| `DATABASE_URL` | `postgresql://...` (your Neon connection string) |
| `SESSION_SECRET` | any random 32+ char string (e.g. output of `openssl rand -hex 32`) |

6. Click **Deploy** → done.

---

## Step 3 — Backend (server.py on your VPS)

Already running at `37.114.37.107:8080`. To keep it running:

```bash
# Install deps
pip install fastapi uvicorn httpx wreq-python structlog colorama

# Run in background (tmux, screen, or systemd)
tmux new -s api
python server.py
# Ctrl+B, D to detach
```

Or as a systemd service:

```ini
# /etc/systemd/system/vaultceaser.service
[Unit]
Description=VaultCeaser FastAPI
After=network.target

[Service]
WorkingDirectory=/path/to/vaultceaser
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable vaultceaser && systemctl start vaultceaser
```

---

## How the proxy works

`next.config.ts` has a rewrite rule:
```
/api/* (not /api/auth or /api/me) → http://37.114.37.107:8080/api/*
```

So:
- Browser calls `https://your-site.vercel.app/api/search?q=naruto`
- Vercel forwards it to `http://37.114.37.107:8080/api/search?q=naruto`
- Response comes back through Vercel → browser gets HTTPS all the way

No CORS config needed, no mixed content warnings.

---

## Environment Variables Summary

| Variable | Where | Required |
|----------|-------|----------|
| `BACKEND_URL` | Vercel | Yes — points to your VPS |
| `DATABASE_URL` | Vercel | Yes — Neon connection string |
| `SESSION_SECRET` | Vercel | Yes — min 32 chars |

---

## Sanity check after deploy

```
https://your-site.vercel.app/api/health          → {"status":"ok"}
https://your-site.vercel.app/api/search?q=naruto → results
https://your-site.vercel.app/api/anime/21/episodes
```

---

## Checklist

- [ ] Neon project created, connection string copied
- [ ] `npx drizzle-kit push` run (creates tables)
- [ ] Vercel project created, root dir = `web`
- [ ] `BACKEND_URL`, `DATABASE_URL`, `SESSION_SECRET` set in Vercel
- [ ] First deploy succeeds
- [ ] `/api/health` returns 200
- [ ] Search works, anime pages load
