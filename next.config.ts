import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["whatsapp-web.js", "puppeteer"],
  async headers() {
    return [
      {
        // PLAN.md §46.7's named risk: a caching misconfiguration serving a
        // stale or broken widget to a business's real customers. The embed
        // snippet references `/widget.js?v=<WIDGET_SCRIPT_VERSION>`, so a
        // version bump is a new URL and bypasses every cache; within one
        // version, a short shared-cache lifetime lets an in-place fix reach
        // customers within minutes while still absorbing traffic.
        source: "/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=3600" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
