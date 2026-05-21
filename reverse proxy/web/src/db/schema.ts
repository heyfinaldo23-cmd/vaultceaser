import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("ov_users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  code: text("code").notNull().unique(),
  displayName: text("display_name").notNull().default("Watcher"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookmarks = pgTable(
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ov_bookmarks_user_anime_uidx").on(t.userId, t.animeId)]
);

export const watchProgress = pgTable(
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ov_watch_user_anime_uidx").on(t.userId, t.animeId)]
);

export const notifications = pgTable("ov_notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body"),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
