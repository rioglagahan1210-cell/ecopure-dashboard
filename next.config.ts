import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  
  // Tambahkan baris ini untuk mengizinkan akses dari IP lokal
  allowedDevOrigins: ['192.168.1.7'],

  experimental: {
    agentFeedback: true,
  },
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
};

export default nextConfig;