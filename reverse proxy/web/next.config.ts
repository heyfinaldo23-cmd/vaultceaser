import type { NextConfig } from "next";
import path from "node:path";

const DEFAULT_BACKEND = "http://37.114.37.107:8080";
const BACKEND = (
  process.env.BACKEND_URL ||
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  DEFAULT_BACKEND
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  async rewrites() {
    return [
      // Static assets from Python backend (synthetic player, etc.)
      {
        source: "/static/:path*",
        destination: `${BACKEND}/static/:path*`,
      },
    ];
  },
  allowedDevOrigins: ["37.114.37.107", "37.114.37.107:3456"],
};

export default nextConfig;
