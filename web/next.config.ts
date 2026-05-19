import type { NextConfig } from "next";

// FastAPI runs on the same machine. Default: localhost:8080.
// Override with BACKEND_URL env var if running on a different port.
const BACKEND = process.env.BACKEND_URL || "http://localhost:8080";

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
