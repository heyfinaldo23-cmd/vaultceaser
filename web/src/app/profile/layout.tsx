import { Suspense } from "react";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<p className="p-8 text-center text-sm">Loading…</p>}>{children}</Suspense>;
}
