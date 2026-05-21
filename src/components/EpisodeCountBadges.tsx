import { Captions, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLabel } from "@/lib/format-labels";

/** Miruro-style sub / dub / total pills — sub & dub = released streams; total = planned eps. */
export default function EpisodeCountBadges({
  subCount = 0,
  dubCount = 0,
  total,
  format,
  className = "",
  size = "default",
}: {
  subCount?: number;
  dubCount?: number;
  /** AniList planned episode count (how many the show will have). */
  total?: number | null;
  format?: string | null;
  className?: string;
  size?: "default" | "compact";
}) {
  const compact = size === "compact";
  const formatShort = format
    ? format === "TV_SHORT"
      ? "TV"
      : format.replace(/_/g, "")
    : "";
  const totalLabel = total != null && total > 0 ? total : subCount || dubCount;
  const hasReleasedCounts = subCount > 0 || dubCount > 0;

  const pill = compact
    ? "h-[20px] gap-0.5 px-1.5 text-[10px]"
    : "h-[22px] gap-1 px-2 text-[11px]";
  const icon = compact ? "h-2.5 w-2.5" : "h-3 w-3";

  return (
    <div
      className={cn("flex flex-wrap items-center justify-between gap-1.5", className)}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {hasReleasedCounts ? (
          <>
            <span
              className={cn(
                "inline-flex items-center rounded-full border border-[#e07a3a] bg-[#e07a3a]/10 font-mono font-bold text-[#e07a3a]",
                pill
              )}
            >
              <Captions className={cn(icon, "shrink-0")} strokeWidth={2.5} />
              {subCount}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border font-mono font-bold",
                pill,
                dubCount > 0
                  ? "border-[#3ddc84] bg-[#3ddc84]/10 text-[#3ddc84]"
                  : "border-[#3ddc84]/40 bg-[#3ddc84]/5 text-[#3ddc84]/60"
              )}
            >
              <Mic className={cn(icon, "shrink-0")} strokeWidth={2.5} />
              {dubCount}
            </span>
          </>
        ) : null}
        {totalLabel > 0 && (
          <span
            className={cn(
              "font-sans font-extrabold tracking-tight text-white/95",
              compact ? "text-[11px]" : "text-[12px]"
            )}
          >
            {totalLabel}
          </span>
        )}
      </div>
      {formatShort ? (
        <span
          className={cn(
            "font-semibold uppercase tracking-wider text-[var(--muted)]",
            compact ? "text-[10px]" : "text-[10px]"
          )}
        >
          {formatShort.length <= 6
            ? formatShort
            : formatLabel(format || "")
                .slice(0, 3)
                .toUpperCase()}
        </span>
      ) : null}
    </div>
  );
}
