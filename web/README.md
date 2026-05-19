# OtakuVault (Next.js)

Lightweight anime frontend for Vercel + Supabase.

## Setup

1. Copy `.env.example` → `.env.local`
2. Run the Python API (`../server.py`) or set `NEXT_PUBLIC_API_URL` to your deployed backend
3. Apply `drizzle/0000_init.sql` in Supabase SQL editor
4. `npm install && npm run dev` → open **http://127.0.0.1:3456** (port 3000 is in Windows’ reserved range 2964–3063)

## Vercel env

- `NEXT_PUBLIC_API_URL` — streaming/metadata API (e.g. Railway/Fly/your VPS)
- `DATABASE_URL` — Supabase Postgres connection string
- `SESSION_SECRET` — 32+ random characters

## Auth

Mullvad-style **16-digit code** (no email). Register on `/login`, save the code once.

## Profile tabs

Profile · Continue Watching · Bookmarks · Notifications · Import/Export · Settings

Adult / hentai titles are filtered client-side from lists and blocked on watch pages.
