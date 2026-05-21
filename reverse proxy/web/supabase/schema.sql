-- OtakuVault / VaultCeaser web database schema for Supabase Postgres.
-- Run this in Supabase SQL Editor before deploying the Vercel web app.

create table if not exists public.ov_users (
  id text primary key default gen_random_uuid()::text,
  code text not null unique,
  display_name text not null default 'Watcher',
  created_at timestamptz not null default now()
);

create table if not exists public.ov_bookmarks (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.ov_users(id) on delete cascade,
  anime_id integer not null,
  title_romaji text,
  title_english text,
  poster text,
  created_at timestamptz not null default now()
);

create unique index if not exists ov_bookmarks_user_anime_uidx
  on public.ov_bookmarks (user_id, anime_id);

create table if not exists public.ov_watch_progress (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.ov_users(id) on delete cascade,
  anime_id integer not null,
  episode_number integer not null,
  episode_id text not null,
  category text not null default 'sub',
  title text,
  updated_at timestamptz not null default now()
);

create unique index if not exists ov_watch_user_anime_uidx
  on public.ov_watch_progress (user_id, anime_id);

create table if not exists public.ov_notifications (
  id text primary key default gen_random_uuid()::text,
  user_id text not null references public.ov_users(id) on delete cascade,
  title text not null,
  body text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists ov_notifications_user_created_idx
  on public.ov_notifications (user_id, created_at desc);
