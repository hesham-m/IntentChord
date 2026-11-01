import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development uses a separate generated directory so a production .next
  // build can never block `npm run dev` on Windows.
  distDir: process.env.INTENTCHORD_NEXT_DIST_DIR || ".next",
};

export default nextConfig;
