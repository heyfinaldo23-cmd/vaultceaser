"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, User } from "lucide-react";
import { api } from "@/lib/api";
import { filterAnimeList } from "@/lib/anime-filters";
import { animeTitle } from "@/lib/anime-title";
import { useAuth } from "@/components/AuthProvider";

type SuggestionItem = {
  id: number;
  title: string;
  poster?: string;
};

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
    if (val.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const data = await api.getSuggestions(val.trim());
        const list = filterAnimeList(data.results || []).slice(0, 6);
        setSuggestions(
          list.map((a) => {
            const raw = a as {
              poster?: string;
              coverImage?: { large?: string };
            };
            return {
              id: a.id,
              title: animeTitle(a),
              poster: raw.poster || raw.coverImage?.large || "",
            };
          })
        );
        setOpen(true);
      } catch {
        setSuggestions([]);
      }
    }, 280);
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
