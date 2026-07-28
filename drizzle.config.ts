import { defineConfig } from "drizzle-kit";

/**
 * Only `generate` is used: migration SQL is checked in and applied in-process
 * at app start (src/db/migrate.ts) against the embedded PGlite database.
 * There is no external database to point credentials at.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
  strict: true,
});
