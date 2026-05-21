"use client";

import {
  Maximize2,
  Moon,
  FastForward,
  PlayCircle,
  Scissors,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlayerPrefs } from "@/lib/player-prefs";

type Props = {
  prefs: PlayerPrefs;
  onToggle: (key: keyof PlayerPrefs) => void;
  onExpand: () => void;
  expanded: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
};

function Btn({
  icon: Icon,
  label,
  active,
  accent,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  accent?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 font-mono text-[11px] font-semibold transition-colors sm:gap-2 sm:px-3 sm:text-xs",
        disabled && "cursor-not-allowed opacity-40",
        active
          ? "border-[#e8621a] bg-[#e8621a]/20 text-[#e8621a]"
          : accent
            ? "border-[#e8621a]/50 bg-[#1a1d24] text-[#e8621a] hover:bg-[#e8621a]/10"
            : "border-[var(--border)] bg-[#1a1d24] text-[var(--foreground)] hover:border-[var(--muted)]"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </button>
  );
}

export default function PlayerToolbar({
  prefs,
  onToggle,
  onExpand,
  expanded,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}: Props) {
  return (
    <div
      className="relative -mt-1 rounded-xl border border-[var(--border)] bg-[#12141a] p-4 shadow-lg shadow-black/30"
      aria-label="Player settings"
    >
      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">
        Player
      </p>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Btn
          icon={Maximize2}
          label={expanded ? "Shrink" : "Expand"}
          accent
          onClick={onExpand}
        />
        <Btn
          icon={Moon}
          label="Focus"
          active={prefs.focus}
          onClick={() => onToggle("focus")}
        />
        <Btn
          icon={FastForward}
          label="AutoNext"
          active={prefs.autoNext}
          onClick={() => onToggle("autoNext")}
        />
        <Btn
          icon={PlayCircle}
          label="AutoPlay"
          active={prefs.autoPlay}
          onClick={() => onToggle("autoPlay")}
        />
        <Btn
          icon={Scissors}
          label="AutoSkip"
          active={prefs.autoSkip}
          onClick={() => onToggle("autoSkip")}
        />
        <span className="mx-0.5 hidden h-8 w-px bg-[var(--border)] sm:block" />
        <Btn icon={SkipBack} label="Prev" onClick={onPrev} disabled={!hasPrev} />
        <Btn icon={SkipForward} label="Next" onClick={onNext} disabled={!hasNext} />
      </div>
    </div>
  );
}
