/** Genre tags */
export default function GenreChips({
  genres,
  max = 8,
  className = "",
  variant = "default",
}: {
  genres?: string[];
  max?: number;
  className?: string;
  variant?: "default" | "hero";
}) {
  const list = (genres || []).slice(0, max);
  if (!list.length) return null;
  const chip =
    variant === "hero"
      ? "rounded-full border border-white/15 bg-black/35 px-2.5 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm"
      : "rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[11px] text-[var(--foreground)]/90";
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {list.map((g) => (
        <span key={g} className={chip}>
          {g}
        </span>
      ))}
    </div>
  );
}
