# SaturdayNight Setup

This project has two deploy targets:

- FastAPI backend on your VPS.
- Next.js web app on Vercel, using Supabase Postgres for user data.

## 1. Backend VPS

Copy the repo to your server and run the backend from:

```bash
cd "reverse proxy"
pip install -r ../requirements.txt
py server.py
```

Expected backend URL:

```text
http://37.114.37.107:8080
```

Make sure your firewall allows port `8080`.

The backend creates a persistent cache at:

```text
reverse proxy/data/provider_cache.sqlite
```

Do not delete this file unless you want the homepage and episode counts to cold-start slowly again.

## 2. Supabase

Create a Supabase project, then open the SQL editor and run:

```text
reverse proxy/web/supabase/schema.sql
```

Then copy the Supabase Postgres **Transaction Pooler** connection string.

It should look like:

```text
postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
```

Use this as `DATABASE_URL` in Vercel.

## 3. Vercel

Import the GitHub repo into Vercel.

Set the root directory to:

```text
reverse proxy/web
```

Set environment variables:

```env
BACKEND_URL=http://37.114.37.107:8080
NEXT_PUBLIC_BACKEND_URL=http://37.114.37.107:8080
DATABASE_URL=your_supabase_transaction_pooler_url
SESSION_SECRET=replace_with_32_plus_random_chars
```

Then deploy.

## 4. Smoke Tests

Backend:

```text
http://37.114.37.107:8080/api/trending?page=1&per_page=12
http://37.114.37.107:8080/api/episode-counts?ids=21,59551,63276
```

Web:

- Open the Vercel URL.
- Search an anime.
- Open a watch page.
- Register/login with a 16-digit account code.
- Add a bookmark.
- Confirm continue watching saves.

## Notes

Keep secrets out of git. Do not commit `.env`, database files, GitHub tokens, or Supabase passwords.
