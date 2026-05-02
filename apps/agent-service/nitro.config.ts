import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
  srcDir: "src",
  compatibilityDate: "2026-05-02",
  // Vercel deployment auto-detected via NITRO_PRESET=vercel in CI; locally the
  // dev server listens on :3000 by default via nitropack dev.
  experimental: {
    asyncContext: true,
  },
});
