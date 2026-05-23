const OTAKUBOX = "https://otakubox.otakuboxapi.workers.dev";

export const runtime = "edge";

export async function HEAD() {
  return new Response(null, { status: 200, headers: { "content-type": "application/json" } });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = `${OTAKUBOX}/api/mp/stream/getSources${url.search}`;

  let res: Response;
  try {
    res = await fetch(target, { cache: "no-store" });
  } catch (e) {
    return Response.json({ error: "Otakubox unreachable", detail: String(e) }, { status: 502 });
  }

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
      "cache-control": "no-store, max-age=0",
      "access-control-allow-origin": "*",
    },
  });
}
