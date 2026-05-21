# OtakuVault (Next.js)

Lightweight anime frontend for Vercel + Supabase.

## Setup

1. Copy `.env.example` -> `.env.local`
2. Set `BACKEND_URL` and `NEXT_PUBLIC_BACKEND_URL` to your deployed FastAPI backend
3. Create a Supabase project and copy the Transaction Pooler connection string to `DATABASE_URL`
4. Apply `supabase/schema.sql` in Supabase SQL editor
5. `npm install && npm run dev` -> open the web app on your server IP and port

## Vercel env

- `BACKEND_URL` — server-side streaming/metadata API
- `NEXT_PUBLIC_BACKEND_URL` — browser-visible backend origin used for player URL rewriting
- `DATABASE_URL` — Supabase Postgres Transaction Pooler connection string
- `SESSION_SECRET` — 32+ random characters

## Auth

Mullvad-style **16-digit code** (no email). Register on `/login`, save the code once.

## Profile tabs

Profile · Continue Watching · Bookmarks · Notifications · Import/Export · Settings

Adult / hentai titles are filtered client-side from lists and blocked on watch pages.
