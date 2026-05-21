"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { clientApi, type AuthUser } from "@/lib/client-api";

type AuthCtx = {
  user: AuthUser | null;
  loading: boolean;
  db: boolean;
  refresh: () => Promise<void>;
  setUser: (u: AuthUser | null) => void;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [db, setDb] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await clientApi.me();
      setDb(r.db);
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, db, refresh, setUser }),
    [user, loading, db, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
