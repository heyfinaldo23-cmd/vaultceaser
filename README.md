# OtakuVault Web

Next.js frontend for SaturdayNight/VaultCeaser. Deploy this folder to Vercel.

## Local Dev

```powershell
cd "reverse proxy\web"
copy .env.example .env.local
npm install
npm run dev
```

For local backend testing, set:

```env
BACKEND_URL=http://127.0.0.1:8080
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8080
```

For production/Vercel, point both backend vars at the VPS API.

## Vercel

Project settings:

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

Use the Supabase **Transaction Pooler** URL for `DATABASE_URL`. Serverless functions should not use a direct long-lived Postgres connection.

## Supabase

Before deploying, run:

```text
supabase/schema.sql
```

Run it in Supabase SQL Editor. It creates:

- `ov_users`
- `ov_bookmarks`
- `ov_watch_progress`
- `ov_notifications`

## Backend Dependency

The web app does not resolve streams by itself. It calls the FastAPI backend for metadata, episode counts, stream source resolution, and HLS proxying.

Backend must be reachable at:

```text
GET {BACKEND_URL}/api/health
GET {BACKEND_URL}/api/mp/stream/getSources?id=mal%3A62568%3A2&category=sub
```

## Auth

Auth uses a Mullvad-style 16-digit code. No email. Users must save the code after registration.

## Notes

Adult/hentai titles are filtered client-side from lists and blocked on watch pages. Keep `.env.local`, database credentials, and tokens out of git.
