const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  "http://37.114.37.107:8080"
).replace(/\/$/, "");

export const runtime = "nodejs";

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Walk JSON and replace all string values that start with the backend origin
 * with a relative path. This ensures HLS.js fetches manifests same-origin
 * through Next.js (which proxies /api/* to the backend) instead of hitting
 * the backend directly cross-origin and getting CORS errors.
 */
function makeRelative(obj: unknown, backendOrigin: string): unknown {
  if (typeof obj === "string") {
    return obj.startsWith(backendOrigin) ? obj.slice(backendOrigin.length) : obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => makeRelative(v, backendOrigin));
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, makeRelative(v, backendOrigin)])
    );
  }
  return obj;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const backendUrl = `${BACKEND}/api/mp/stream/getSources${url.search}`;

  const forwardHeaders: Record<string, string> = { "cache-control": "no-cache" };
  const referer = request.headers.get("referer");
  if (referer) forwardHeaders["referer"] = referer;
  const ua = request.headers.get("user-agent");
  if (ua) forwardHeaders["user-agent"] = ua;

  let res: Response;
  try {
    res = await fetch(backendUrl, { headers: forwardHeaders, cache: "no-store" });
  } catch (e) {
    return Response.json({ error: "Backend unreachable", detail: String(e) }, { status: 502 });
  }

  if (!res.ok) {
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return Response.json({ error: "Invalid JSON from backend" }, { status: 502 });
  }

  // Normalize sources dict → array
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.sources != null && !Array.isArray(d.sources)) {
      d.sources = [d.sources];
    }
    data = d;
  }

  // Rewrite absolute backend URLs → relative so HLS.js stays same-origin
  // (avoids CORS errors when the iframe runs from localhost:3456 but the
  //  cdn-hls URLs point to 37.114.37.107:8080)
  const backendOrigin = new URL(BACKEND).origin;
  data = makeRelative(data, backendOrigin);

  return Response.json(data, {
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
