const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  "http://37.114.37.107:8080"
).replace(/\/$/, "");

const BACKEND_ORIGIN = new URL(BACKEND).origin;

export const runtime = "nodejs";

function isM3U8(contentType: string, targetUrl: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes("mpegurl") ||
    ct.includes("m3u8") ||
    targetUrl.toLowerCase().includes(".m3u8")
  );
}

function filterHeaders(headers: Headers, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = new Set(["content-encoding", "transfer-encoding", "connection", "keep-alive"]);
  headers.forEach((v, k) => {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  });
  return { ...out, ...extra };
}

export async function HEAD(request: Request) {
  const url = new URL(request.url);
  const backendUrl = `${BACKEND}/api/cdn-hls${url.search}`;
  try {
    const res = await fetch(backendUrl, { method: "HEAD", cache: "no-store" });
    return new Response(null, { status: res.status, headers: filterHeaders(res.headers) });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const backendUrl = `${BACKEND}/api/cdn-hls${url.search}`;

  const forwardHeaders: Record<string, string> = {};
  const range = request.headers.get("range");
  if (range) forwardHeaders["Range"] = range;

  let res: Response;
  try {
    res = await fetch(backendUrl, { headers: forwardHeaders, cache: "no-store" });
  } catch (e) {
    return new Response(`Backend unreachable: ${e}`, { status: 502 });
  }

  const ct = res.headers.get("content-type") || "";
  const targetU = url.searchParams.get("u") || "";

  if (res.ok && isM3U8(ct, targetU)) {
    const text = await res.text();

    // Replace absolute backend URLs with the same-origin URL so HLS.js
    // fetches segment/variant requests through Next.js proxy, not cross-origin.
    const requestOrigin = url.origin;
    const rewritten = text.replaceAll(BACKEND_ORIGIN, requestOrigin);

    return new Response(rewritten, {
      status: res.status,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store, max-age=0",
      },
    });
  }

  // Binary segments / VTT / other — stream through as-is
  return new Response(res.body, {
    status: res.status,
    headers: filterHeaders(res.headers, { "cache-control": "no-store" }),
  });
}
