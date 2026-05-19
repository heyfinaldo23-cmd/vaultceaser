import type { NextConfig } from "next";

// Backend FastAPI server. Set BACKEND_URL in Vercel env vars.
// Rewrites proxy all /api/* traffic (except Next.js own routes) through Vercel
// so the browser never makes HTTP calls to a plain IP (fixes mixed-content issues).
const BACKEND = process.env.BACKEND_URL || "http://37.114.37.107:8080";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        // Forward everything under /api/ EXCEPT the Next.js-owned routes
        source: "/api/:path((?!auth|me).*)",
        destination: `${BACKEND}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
