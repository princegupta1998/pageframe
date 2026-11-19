import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // puppeteer-core and @sparticuz/chromium are kept out of the bundle automatically.
  // Chromium's compressed binary is read from disk at runtime, which the file tracer
  // can miss, so it is listed explicitly for the screenshot route, along with
  // the extra fonts in /fonts (see src/lib/browser.ts).
  outputFileTracingIncludes: {
    "/api/shot": ["./node_modules/@sparticuz/chromium/bin/**/*", "./fonts/**/*"],
  },
};

export default nextConfig;
