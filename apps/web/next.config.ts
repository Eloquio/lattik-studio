import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["lattik-studio.dev"],
  transpilePackages: ["@eloquio/lattik-expression"],
};

export default nextConfig;
