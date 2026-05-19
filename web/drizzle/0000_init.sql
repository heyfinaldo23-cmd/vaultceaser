-- OtakuVault — run in Supabase SQL editor (or psql) once.
-- Requires extension for gen_random_uuid() (enabled by default on Supabase).

CREATE TABLE IF NOT EXISTS ov_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(16) NOT NULL UNIQUE,
  display_name varchar(64) NOT NULL DEFAULT 'Watcher',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ov_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ov_users(id) ON DELETE CASCADE,
  anime_id integer NOT NULL,
  title_romaji text,
  title_english text,
  poster text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ov_bookmarks_user_anime_uidx UNIQUE (user_id, anime_id)
);

CREATE TABLE IF NOT EXISTS ov_watch_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ov_users(id) ON DELETE CASCADE,
  anime_id integer NOT NULL,
  episode_number integer NOT NULL,
  episode_id text NOT NULL,
  category varchar(8) NOT NULL DEFAULT 'sub',
  title text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ov_watch_user_anime_uidx UNIQUE (user_id, anime_id)
);

CREATE TABLE IF NOT EXISTS ov_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES ov_users(id) ON DELETE CASCADE,
  title varchar(200) NOT NULL,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ov_watch_progress_user_updated_idx ON ov_watch_progress (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ov_notifications_user_created_idx ON ov_notifications (user_id, created_at DESC);
