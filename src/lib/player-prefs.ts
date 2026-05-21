const KEY = "ov-player-prefs";

export type PlayerPrefs = {
  autoNext: boolean;
  autoPlay: boolean;
  autoSkip: boolean;
  focus: boolean;
};

const defaults: PlayerPrefs = {
  autoNext: true,
  autoPlay: true,
  autoSkip: false,
  focus: false,
};

export function loadPlayerPrefs(): PlayerPrefs {
  if (typeof window === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as Partial<PlayerPrefs>;
    return { ...defaults, ...stored, focus: false };
  } catch {
    return defaults;
  }
}

export function savePlayerPrefs(patch: Partial<PlayerPrefs>) {
  const next = { ...loadPlayerPrefs(), ...patch };
  const stored = {
    autoNext: next.autoNext,
    autoPlay: next.autoPlay,
    autoSkip: next.autoSkip,
  };
  localStorage.setItem(KEY, JSON.stringify(stored));
  return next;
}
