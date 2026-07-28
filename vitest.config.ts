import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    globals: true,
    // Only this project's tests. `vendor/` holds an extracted Node source tree
    // (for the small-icu runtime build) whose own thousands of test files would
    // otherwise be collected and reported as ours.
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
});
