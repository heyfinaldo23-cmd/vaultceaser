"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, User } from "lucide-react";
import { anilist } from "@/lib/anilist";
import { akSearch } from "@/lib/anikoto-cache";
import { filterAnimeList } from "@/lib/anime-filters";
import { animeTitle } from "@/lib/anime-title";
import { useAuth } from "@/components/AuthProvider";

type SuggestionItem = {
  id: number;
  title: string;
  poster?: string;
};

const normalizeT = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");

export default function Navbar() {
  const router = useRouter();
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const onSearch = (val: string) => {
    setQuery(val);
    if (debounce.current) clearTimeout(debounce.current);
    if (val.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        // Run Anikoto and AniList in parallel
        // Anikoto: best coverage (currently airing, DMC2, Bunny Girl, etc.)
        // AniList: provides MAL IDs needed for routing
        const [akRes, alRes] = await Promise.allSettled([
          akSearch(val.trim()),
          anilist.getSuggestions(val.trim()),
        ]);

        const akList = akRes.status === "fulfilled" ? akRes.value : [];
        const alList = alRes.status === "fulfilled"
          ? filterAnimeList(alRes.value.results || [])
          : [];

        // Build merged list
        // AniList results have idMal → use as MAL ID (our routing)
        // Anikoto-only results: match by title to AniList to get MAL ID
        const seenIds = new Set<number>();
        const list: SuggestionItem[] = [];

        // AniList results first (reliable MAL IDs, good coverage)
        for (const a of alList) {
          if (list.length >= 6) break;
          if (seenIds.has(a.id)) continue;
          seenIds.add(a.id);
          const raw = a as { coverImage?: { large?: string } };
          list.push({ id: a.id, title: animeTitle(a), poster: raw.coverImage?.large || "" });
        }

        // Fill gaps from Anikoto results not yet in list
        for (const ak of akList) {
          if (list.length >= 8) break;
          const normAk = normalizeT(ak.title);
          // Check if already covered by AniList
          const alMatch = alList.find((a) => normalizeT(animeTitle(a)) === normAk);
          if (alMatch) {
            // Replace AniList poster with Anikoto's if not already in list
            const existing = list.find((s) => s.id === alMatch.id);
            if (existing && ak.poster && !existing.poster) existing.poster = ak.poster;
            continue;
          }
          // Not in AniList results — skip (no MAL ID to route to)
        }

        setSuggestions(list.slice(0, 6));
        setOpen(list.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 400);
  };

  const searchBox = (mobile = false) => (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
      <input
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.trim()) {
            router.push(`/browse?q=${encodeURIComponent(query.trim())}`);
            setOpen(false);
          }
        }}
        placeholder="Search anime..."
        className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--card)] pl-8 pr-3 text-sm focus:border-[var(--accent)] focus:outline-none"
      />
      {open && suggestions.length > 0 && (
        <div
          className={`absolute top-full z-50 mt-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg ${
            mobile ? "left-0 right-0" : "w-full"
          }`}
        >
          {suggestions.map((s, i) => (
            <button
              key={`${s.id}-${i}`}
              type="button"
              className="flex w-full items-center gap-2.5 px-2 py-2 text-left hover:bg-[#1a1d24]"
              onClick={() => {
                router.push(`/anime/${s.id}`);
                setOpen(false);
                setQuery("");
              }}
            >
              {s.poster ? (
                <img
                  src={s.poster}
                  alt=""
                  className="h-12 w-8 shrink-0 rounded bg-[#1a1d24] object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="h-12 w-8 shrink-0 rounded bg-[#1a1d24]" />
              )}
              <span className="min-w-0 truncate text-sm">{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <header className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-sm">
      <div ref={ref} className="mx-auto max-w-5xl px-3 sm:px-4">
        <div className="flex h-[52px] items-center gap-3 sm:gap-4">
          <Link href="/" className="shrink-0 font-semibold tracking-tight text-[var(--accent)]">
            OtakuVault
          </Link>

          <div className="hidden flex-1 sm:block">{searchBox(false)}</div>

          <nav className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/browse" className="text-[var(--muted)] hover:text-[var(--foreground)]">
              Browse
            </Link>
            <Link
              href={user ? "/profile" : "/login"}
              className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <User className="h-4 w-4" />
              <span className="hidden sm:inline">{user ? user.displayName : "Login"}</span>
            </Link>
          </nav>
        </div>
        <div className="pb-2 sm:hidden">{searchBox(true)}</div>
      </div>
    </header>
  );
}
