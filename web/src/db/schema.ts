import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("ov_users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull().default("Watcher"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bookmarks = sqliteTable(
  "ov_bookmarks",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    titleRomaji: text("title_romaji"),
    titleEnglish: text("title_english"),
    poster: text("poster"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("ov_bookmarks_user_anime_uidx").on(t.userId, t.animeId)]
);

export const watchProgress = sqliteTable(
  "ov_watch_progress",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    episodeId: text("episode_id").notNull(),
    category: text("category").notNull().default("sub"),
    title: text("title"),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("ov_watch_user_anime_uidx").on(t.userId, t.animeId)]
);

export const notifications = sqliteTable("ov_notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  read: integer("read", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
