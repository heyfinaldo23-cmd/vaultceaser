/** Turn API enums like NOT_YET_RELEASED → "Not Yet Released". */
export function formatLabel(value?: string | null): string {
  if (!value) return "";
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export const FORMAT_OPTIONS = [
  { value: "", label: "Type" },
  { value: "TV", label: "TV" },
  { value: "TV_SHORT", label: "TV Short" },
  { value: "MOVIE", label: "Movie" },
  { value: "OVA", label: "OVA" },
  { value: "ONA", label: "ONA" },
  { value: "SPECIAL", label: "Special" },
] as const;

export const STATUS_OPTIONS = [
  { value: "", label: "Status" },
  { value: "RELEASING", label: "Releasing" },
  { value: "FINISHED", label: "Finished" },
  { value: "NOT_YET_RELEASED", label: "Not Yet Released" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "HIATUS", label: "Hiatus" },
] as const;

export const SEASON_OPTIONS = [
  { value: "", label: "All Seasons" },
  { value: "WINTER", label: "Winter" },
  { value: "SPRING", label: "Spring" },
  { value: "SUMMER", label: "Summer" },
  { value: "FALL", label: "Fall" },
] as const;
