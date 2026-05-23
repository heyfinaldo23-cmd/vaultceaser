"use client";

import {
  Maximize2,
  Moon,
  FastForward,
  PlayCircle,
  Scissors,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
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
  onSeekBack?: () => void;
  onSeekForward?: () => void;
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
        "flex min-w-0 items-center justify-center gap-1 rounded-md border px-2 py-1 font-mono text-[9px] font-semibold transition-colors sm:px-2.5 sm:text-[10px]",
        disabled && "cursor-not-allowed opacity-40",
        active
          ? "border-[#e8621a]/70 bg-[#e8621a]/15 text-[#e8621a]"
          : accent
            ? "border-[#e8621a]/40 bg-[#171a21] text-[#e8621a] hover:bg-[#e8621a]/10"
            : "border-white/10 bg-[#171a21] text-[var(--foreground)] hover:border-white/20 hover:bg-white/5"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
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
  onSeekBack,
  onSeekForward,
}: Props) {
  return (
    <div
      className="relative rounded-lg border border-white/10 bg-[#10131a]/85 p-2.5 shadow-lg shadow-black/20"
      aria-label="Player settings"
    >
      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]">
        Player
      </p>
      <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
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
        <span className="mx-0.5 hidden h-7 w-px bg-white/10 sm:block" />
        <Btn icon={RotateCcw} label="-10s" onClick={onSeekBack} disabled={!onSeekBack} />
        <Btn icon={RotateCw} label="+10s" onClick={onSeekForward} disabled={!onSeekForward} />
        <span className="mx-0.5 hidden h-7 w-px bg-white/10 sm:block" />
        <Btn icon={SkipBack} label="Prev" onClick={onPrev} disabled={!hasPrev} />
        <Btn icon={SkipForward} label="Next" onClick={onNext} disabled={!hasNext} />
      </div>
    </div>
  );
}
