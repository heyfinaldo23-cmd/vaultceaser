# SaturdayNight Deployment Setup

Two things deploy separately:

- `reverse proxy/` — FastAPI backend on the VPS.
- `reverse proxy/web/` — Next.js app on Vercel, with Supabase Postgres for user data.

## 1. VPS Backend

Run the API from the `reverse proxy` folder:

```powershell
cd "C:\Users\Administrator\Documents\reverse proxy"
py -m pip install -r ..\requirements.txt
py server.py
```

For dev reload:

```powershell
py server.py --reload
```

Expected public API:

```text
http://37.114.37.107:8080
```

Open port `8080` in the VPS firewall/security group. The backend writes its provider cache to:

```text
reverse proxy/data/provider_cache.sqlite
```

Keep that file. Deleting it makes homepage badges, episode counts, and provider lookups cold-start like molasses.

For production, run `py server.py` under a process manager (`nssm`, Windows Task Scheduler, PM2, systemd on Linux, etc.) so it restarts after crashes/reboots.

## 2. Supabase

Create a Supabase project, then run this file in Supabase SQL Editor:

```text
reverse proxy/web/supabase/schema.sql
```

Use the Supabase **Transaction Pooler** connection string for Vercel/serverless:

```text
postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
```

Put that full URL in `DATABASE_URL`.

Do not use local SQLite for Vercel. Do not expose the Supabase service-role key in the frontend. The app only needs the Postgres connection string server-side.

## 3. Vercel

Import the GitHub repo into Vercel and set:

```text
Root Directory: reverse proxy/web
Build Command: npm run build
Install Command: npm install
Output Directory: .next
```

Environment variables:

```env
BACKEND_URL=http://37.114.37.107:8080
NEXT_PUBLIC_BACKEND_URL=http://37.114.37.107:8080
DATABASE_URL=postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
SESSION_SECRET=generate_32_plus_random_chars
```

Generate a session secret:

```bash
openssl rand -hex 32
```

`BACKEND_URL` is used by Next server routes. `NEXT_PUBLIC_BACKEND_URL` is used when browser-visible URLs need to know the backend origin.

## 4. Smoke Tests

Backend:

```text
http://37.114.37.107:8080/api/health
http://37.114.37.107:8080/api/trending?page=1&per_page=12
http://37.114.37.107:8080/api/episode-counts?ids=21,59551,63276
```

Web:

- Open the Vercel URL.
- Search an anime.
- Open `/anime/{mal_id}/watch?ep=1&cat=sub`.
- Register/login with a 16-digit account code.
- Add a bookmark.
- Confirm continue watching saves after watching at least a little.
- Confirm the browser-facing stream route returns JSON:

```text
https://YOUR_VERCEL_DOMAIN/api/mp/stream/getSources?id=mal%3A62568%3A2&category=sub
```

## 5. Updating Deployments

Backend changes do not deploy through Vercel. Copy/pull the repo on the VPS, then restart `server.py`.

Frontend changes deploy through Vercel after pushing to GitHub.

## Security Notes

Keep secrets out of git and chat. Never commit `.env`, database files, GitHub tokens, Supabase passwords, or service-role keys.
