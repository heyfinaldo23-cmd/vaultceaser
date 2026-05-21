import {
  staticAnime,
  staticFilter,
  staticGenres,
  staticHomepage,
  staticMeta,
  staticRecommendations,
  staticRelations,
  staticSearch,
  staticSection,
  staticSuggestions,
} from "@/lib/static-catalog";

const DEFAULT_BACKEND = "http://37.114.37.107:8080";
const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  DEFAULT_BACKEND
).replace(/\/$/, "");

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      ...init?.headers,
    },
    status: init?.status,
  });
}

function notFound() {
  return json({ detail: "Not found" }, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
}

function sectionKey(pathname: string) {
  switch (pathname) {
    case "trending":
      return "trending";
    case "popular":
      return "popular";
    case "upcoming":
      return "upcoming";
    case "recent":
    case "latest-releases":
      return "recent";
    case "fresh":
      return "fresh";
    case "recently-completed":
      return "recentlyCompleted";
    default:
      return null;
  }
}

async function proxyToBackend(request: Request, path: string[]) {
  const url = new URL(request.url);
  const backendUrl = `${BACKEND}/api/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("host", new URL(BACKEND).host);
  headers.delete("connection");

  const res = await fetch(backendUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    cache: "no-store",
    // Next requires this when forwarding a streamed request body.
    duplex: "half",
  } as RequestInit & { duplex?: "half" });

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export async function GET(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  const pathname = path.join("/");
  const url = new URL(request.url);

  if (pathname === "_static-meta") return json(staticMeta());
  if (pathname === "search") return json(staticSearch(url.searchParams));
  if (pathname === "suggestions") return json(staticSuggestions(url.searchParams));
  if (pathname === "filter") return json(staticFilter(url.searchParams));
  if (pathname === "genres") return json(staticGenres());
  if (pathname === "homepage") return json(staticHomepage());
  if (pathname === "spotlight") return json({ results: staticSection("trending", url.searchParams).results.slice(0, 10) });
  if (pathname === "schedule") return json({ page: 1, perPage: 20, total: 0, hasNextPage: false, results: [] });

  const collection = sectionKey(pathname);
  if (collection) return json(staticSection(collection, url.searchParams));

  const animeMatch = pathname.match(/^anime\/(\d+)$/);
  if (animeMatch) {
    const payload = staticAnime(Number(animeMatch[1]));
    return payload ? json(payload) : notFound();
  }

  const relationsMatch = pathname.match(/^anime\/(\d+)\/relations$/);
  if (relationsMatch) return json(staticRelations(Number(relationsMatch[1])));

  const recommendationsMatch = pathname.match(/^anime\/(\d+)\/recommendations$/);
  if (recommendationsMatch) return json(staticRecommendations(Number(recommendationsMatch[1]), url.searchParams));

  return proxyToBackend(request, path);
}

export async function HEAD(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function POST(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function PUT(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}

export async function DELETE(request: Request, context: RouteContext) {
  const { path = [] } = await context.params;
  return proxyToBackend(request, path);
}
