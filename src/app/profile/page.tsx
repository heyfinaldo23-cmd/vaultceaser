"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import {
  clientApi,
  type BookmarkRow,
  type NotificationRow,
  type WatchRow,
} from "@/lib/client-api";
import {
  listQualifiedLocalWatchProgress,
  type LocalWatchProgress,
} from "@/lib/watch-progress";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "continue", label: "Continue Watching" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "notifications", label: "Notifications" },
  { id: "import", label: "Import/Export" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type ContinueItem = {
  id: string;
  animeId: number;
  episodeNumber: number;
  category: string;
  title?: string | null;
  animeTitle?: string | null;
  poster?: string | null;
  positionSeconds?: number | null;
  updatedAt: string;
};

function localWatchToContinueItem(w: LocalWatchProgress): ContinueItem {
  return {
    id: `local-${w.animeId}-${w.category}-${w.episodeNumber}`,
    animeId: w.animeId,
    episodeNumber: w.episodeNumber,
    category: w.category,
    title: w.title,
    animeTitle: w.animeTitle,
    poster: w.poster,
    positionSeconds: w.positionSeconds,
    updatedAt: w.updatedAt,
  };
}

function mergeContinueItems(items: ContinueItem[]) {
  const seen = new Set<number>();
  return [...items]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((item) => {
      if (seen.has(item.animeId)) return false;
      seen.add(item.animeId);
      return true;
    });
}

function formatResumeTime(seconds?: number | null) {
  if (!seconds || seconds < 1) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function buildMalXml(bookmarks: BookmarkRow[], watch: WatchRow[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<myanimelist>",
  ];
  const seen = new Set<number>();
  for (const b of bookmarks) {
    if (seen.has(b.animeId)) continue;
    seen.add(b.animeId);
    lines.push("  <anime>");
    lines.push(`    <series_animedb_id>${b.animeId}</series_animedb_id>`);
    lines.push("    <my_status>Plan to Watch</my_status>");
    lines.push("  </anime>");
  }
  for (const w of watch) {
    if (seen.has(w.animeId)) continue;
    seen.add(w.animeId);
    lines.push("  <anime>");
    lines.push(`    <series_animedb_id>${w.animeId}</series_animedb_id>`);
    lines.push("    <my_status>Watching</my_status>");
    lines.push(`    <my_watched_episodes>${w.episodeNumber}</my_watched_episodes>`);
    lines.push("  </anime>");
  }
  lines.push("</myanimelist>");
  return lines.join("\n");
}

export default function ProfilePage() {
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get("tab") as TabId) || "profile";
  const { user, loading, db, refresh } = useAuth();

  const [name, setName] = useState("");
  const [watch, setWatch] = useState<WatchRow[]>([]);
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkRow[]>([]);
  const [notes, setNotes] = useState<NotificationRow[]>([]);
  const [msg, setMsg] = useState("");

  const loadData = useCallback(async () => {
    if (!user) return;
    try {
      const [w, b, n] = await Promise.all([
        clientApi.getWatch(),
        clientApi.getBookmarks(),
        clientApi.getNotifications(),
      ]);
      setWatch(w.items);
      setContinueItems(
        mergeContinueItems(listQualifiedLocalWatchProgress(50).map(localWatchToContinueItem))
      );
      setBookmarks(b.items);
      setNotes(n.items);
    } catch {
      setContinueItems(listQualifiedLocalWatchProgress(50).map(localWatchToContinueItem));
    }
  }, [user]);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (user) {
      setName(user.displayName);
      loadData();
    }
  }, [user, loadData]);

  const setTab = (id: TabId) => {
    router.push(`/profile?tab=${id}`);
  };

  const saveName = async () => {
    try {
      await clientApi.updateProfile(name.trim() || "Watcher");
      await refresh();
      setMsg("Profile saved");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    }
  };

  const logout = async () => {
    await clientApi.logout();
    await refresh();
    router.push("/login");
  };

  const exportJson = () => {
    window.open("/api/me/export", "_blank");
  };

  const exportMal = () => {
    const xml = buildMalXml(bookmarks, watch);
    const blob = new Blob([xml], { type: "application/xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `otakuvault-mal-${Date.now()}.xml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await clientApi.importData(data);
      setMsg(`Imported ${r.imported.bookmarks} bookmarks, ${r.imported.watch} watch entries`);
      loadData();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Import failed");
    }
  };

  if (loading) {
    return <p className="p-8 text-center text-sm text-[var(--muted)]">Loading…</p>;
  }
  if (!user) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold">Account</h1>
      {!db && (
        <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          Database not configured. Set DATABASE_URL on Vercel to enable sync.
        </p>
      )}

      <nav className="mt-6 flex flex-wrap gap-1 border-b border-[var(--border)] pb-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded px-3 py-1.5 text-sm ${
              tab === t.id
                ? "bg-[var(--accent)] text-black"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {msg && <p className="mt-4 text-sm text-[var(--accent)]">{msg}</p>}

      {tab === "profile" && (
        <section className="mt-6 space-y-4">
          <p className="text-sm text-[var(--muted)]">
            Display name shown in the app. Your login is your 16-digit code only.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full max-w-sm rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
            maxLength={64}
          />
          <button
            type="button"
            onClick={saveName}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-black"
          >
            Save name
          </button>
        </section>
      )}

      {tab === "continue" && (
        <section className="mt-6 space-y-2">
          {continueItems.length === 0 && (
            <p className="text-sm text-[var(--muted)]">Nothing yet. Start an episode.</p>
          )}
          {continueItems.map((w) => {
            const resumeTime = formatResumeTime(w.positionSeconds);
            return (
              <Link
                key={w.id}
                href={`/anime/${w.animeId}/watch?ep=${w.episodeNumber}&cat=${w.category}`}
                className="flex items-center gap-3 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm hover:border-[var(--accent)]"
              >
                {w.poster ? (
                  <img
                    src={w.poster}
                    alt=""
                    className="h-14 w-10 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {w.animeTitle || `Anime #${w.animeId}`}
                  </span>
                  <span className="text-[var(--muted)]">
                    EP {w.episodeNumber} ({w.category})
                    {resumeTime ? ` · ${resumeTime}` : ""}
                  </span>
                </span>
              </Link>
            );
          })}
        </section>
      )}

      {tab === "bookmarks" && (
        <section className="mt-6 space-y-2">
          {bookmarks.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No bookmarks.</p>
          )}
          {bookmarks.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2"
            >
              <Link href={`/anime/${b.animeId}`} className="text-sm hover:text-[var(--accent)]">
                {b.titleEnglish || b.titleRomaji || `Anime ${b.animeId}`}
              </Link>
              <button
                type="button"
                className="text-xs text-red-400"
                onClick={() =>
                  clientApi.removeBookmark(b.animeId).then(loadData)
                }
              >
                Remove
              </button>
            </div>
          ))}
        </section>
      )}

      {tab === "notifications" && (
        <section className="mt-6 space-y-2">
          <p className="text-sm text-[var(--muted)]">
            In-app notices. Supabase realtime can be wired here later.
          </p>
          {notes.length === 0 && (
            <p className="text-sm text-[var(--muted)]">No notifications.</p>
          )}
          {notes.map((n) => (
            <div
              key={n.id}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm"
            >
              <p className="font-medium">{n.title}</p>
              {n.body && <p className="text-[var(--muted)]">{n.body}</p>}
            </div>
          ))}
        </section>
      )}

      {tab === "import" && (
        <section className="mt-6 space-y-4 text-sm">
          <button
            type="button"
            onClick={exportJson}
            className="mr-2 rounded border border-[var(--border)] px-4 py-2 hover:bg-[var(--card)]"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={exportMal}
            className="rounded border border-[var(--border)] px-4 py-2 hover:bg-[var(--card)]"
          >
            Export MAL XML
          </button>
          <div className="mt-4">
            <label className="block text-[var(--muted)]">Import OtakuVault JSON</label>
            <input
              type="file"
              accept="application/json"
              className="mt-2 text-xs"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImportFile(f);
              }}
            />
          </div>
        </section>
      )}

      {tab === "settings" && (
        <section className="mt-6 space-y-4 text-sm">
          <p className="text-[var(--muted)]">
            Session lasts 30 days in this browser. Comments will use Supabase when enabled.
          </p>
          <button
            type="button"
            onClick={logout}
            className="rounded border border-red-500/50 px-4 py-2 text-red-400"
          >
            Log out
          </button>
        </section>
      )}
    </div>
  );
}
