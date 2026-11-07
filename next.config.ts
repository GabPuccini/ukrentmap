import type { NextConfig } from "next";

// GitHub Pages serves the site from /ukrentmap/. Locally it runs from /.
// Set NEXT_PUBLIC_BASE_PATH=/ukrentmap when building for Pages
// (npm run build:pages does this, and so does the deploy workflow).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const config: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default config;
