export type AuthUser = {
  id: string;
  displayName: string;
  createdAt?: string;
};

export type WatchProgressInput = {
  animeId: number;
  episodeNumber: number;
  episodeId: string;
  category: string;
  title?: string;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || res.statusText);
  }
  return body as T;
}

export const clientApi = {
  me: () => json<{ user: AuthUser | null; db: boolean }>("/api/auth/me"),

  register: () =>
    json<{ ok: boolean; code: string; message: string }>("/api/auth/register", {
      method: "POST",
    }),

  login: (code: string) =>
    json<{ ok: boolean; displayName: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  logout: () => json<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  updateProfile: (displayName: string) =>
    json<{ ok: boolean }>("/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),

  getWatch: () =>
    json<{ items: WatchRow[]; db: boolean }>("/api/me/watch"),

  saveWatch: (data: WatchProgressInput, init?: RequestInit) =>
    json<{ ok: boolean }>("/api/me/watch", {
      method: "POST",
      body: JSON.stringify(data),
      ...init,
    }),

  saveWatchBeacon: (data: WatchProgressInput) => {
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      return navigator.sendBeacon("/api/me/watch", blob);
    }
    if (typeof fetch !== "undefined") {
      void fetch("/api/me/watch", {
        method: "POST",
        body: JSON.stringify(data),
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        keepalive: true,
      }).catch(() => {});
    }
    return false;
  },

  getBookmarks: () =>
    json<{ items: BookmarkRow[]; db: boolean }>("/api/me/bookmarks"),

  addBookmark: (data: {
    animeId: number;
    titleRomaji?: string;
    titleEnglish?: string;
    poster?: string;
  }) =>
    json<{ ok: boolean }>("/api/me/bookmarks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  removeBookmark: (animeId: number) =>
    json<{ ok: boolean }>(`/api/me/bookmarks?animeId=${animeId}`, {
      method: "DELETE",
    }),

  getNotifications: () =>
    json<{ items: NotificationRow[]; db: boolean }>("/api/me/notifications"),

  importData: (payload: unknown) =>
    json<{ ok: boolean; imported: { bookmarks: number; watch: number } }>(
      "/api/me/import",
      { method: "POST", body: JSON.stringify(payload) }
    ),
};

export type WatchRow = {
  id: string;
  animeId: number;
  episodeNumber: number;
  episodeId: string;
  category: string;
  title: string | null;
  updatedAt: string;
};

export type BookmarkRow = {
  id: string;
  animeId: number;
  titleRomaji: string | null;
  titleEnglish: string | null;
  poster: string | null;
};

export type NotificationRow = {
  id: string;
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
};
