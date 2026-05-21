/** Sites to hide from overview Links & resources (paid streaming we don't embed). */
const BLOCKED_SITE_PATTERNS = [
  /crunchyroll/i,
  /netflix/i,
  /hulu/i,
  /amazon\s*prime/i,
  /prime\s*video/i,
];

const BLOCKED_URL_PATTERNS = [
  /crunchyroll\.com/i,
  /netflix\.com/i,
  /hulu\.com/i,
  /primevideo\.com/i,
  /amazon\.com\/gp\/video/i,
];

export type ExternalLink = { url: string; site: string; type?: string };

export function isBlockedExternalLink(link: { url?: string; site?: string }): boolean {
  const site = link.site || "";
  const url = link.url || "";
  if (BLOCKED_SITE_PATTERNS.some((p) => p.test(site))) return true;
  if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) return true;
  return false;
}

export function filterExternalLinks<T extends ExternalLink>(links: T[]): T[] {
  return links.filter((l) => l.url && !isBlockedExternalLink(l));
}
