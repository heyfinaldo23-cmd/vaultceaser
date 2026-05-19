import {
  pgTable,
  uuid,
  varchar,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("ov_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: varchar("code", { length: 16 }).notNull().unique(),
  displayName: varchar("display_name", { length: 64 }).notNull().default("Watcher"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const bookmarks = pgTable(
  "ov_bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    titleRomaji: text("title_romaji"),
    titleEnglish: text("title_english"),
    poster: text("poster"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("ov_bookmarks_user_anime_uidx").on(t.userId, t.animeId)]
);

export const watchProgress = pgTable(
  "ov_watch_progress",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    animeId: integer("anime_id").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    episodeId: text("episode_id").notNull(),
    category: varchar("category", { length: 8 }).notNull().default("sub"),
    title: text("title"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("ov_watch_user_anime_uidx").on(t.userId, t.animeId)]
);

export const notifications = pgTable("ov_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body"),
  read: boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
