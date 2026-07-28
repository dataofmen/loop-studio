import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't infer ~/ (a stray ~/package.json
  // exists) as the root and mis-resolve files.
  outputFileTracingRoot: import.meta.dirname,
  // The desktop shell runs the built server from a bundled Node sidecar.
  output: "standalone",
  // PGlite ships WASM that cannot survive being bundled — keep it a real
  // Node require.
  serverExternalPackages: ["@electric-sql/pglite", "drizzle-orm"],
  // No remote or optimized images anywhere in the app, and the optimizer's
  // sharp dependency is 16MB of the download. Serve images as authored.
  images: { unoptimized: true },
};

export default nextConfig;
