/**
 * Assembles a self-contained, runnable app bundle from a production build.
 *
 * This is exactly what the desktop shell wraps: a Next standalone server plus
 * the few files it reads at runtime. Keeping it a separate step means the
 * bundle can be tested on its own — `dist/app/run.sh` starts the same server
 * the packaged app will.
 *
 * Usage:
 *   bun run build
 *   bun scripts/package-app.ts [outDir]     # default: dist/app
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/**
 * Strips what a running app never reads. Next's dependency tracing is
 * deliberately generous — it keeps optional peers and debug artifacts — and on
 * a desktop bundle that is tens of megabytes the user downloads for nothing.
 */
function prune(dir: string): void {
  // Whole packages: typescript is an optional peer of next/drizzle (compile
  // time only); sharp powers Next's image optimizer, which next.config turns
  // off because this app serves no optimized images; caniuse-lite feeds
  // browserslist during compilation.
  for (const pkg of ["typescript", "sharp", "@img", "caniuse-lite"]) {
    rmSync(join(dir, "node_modules", pkg), { recursive: true, force: true });
  }

  // Build-time machinery Next ships inside its runtime package. Verified by
  // removing it and starting the bundle with the SAME environment the desktop
  // shell uses (NODE_ENV=production) — see run.sh.
  //
  // Two neighbours that look equally removable are NOT, and both fail only
  // under NODE_ENV=production, which is why run.sh sets it:
  //   - next/dist/next-devtools — required from patch-error-inspect.js
  //   - next/dist/compiled/babel — next-devtools/server/shared.js requires
  //     babel/code-frame at load
  rmSync(join(dir, "node_modules/next/dist/compiled/amphtml-validator"), {
    recursive: true,
    force: true,
  });

  // Source maps and PGlite's optional Postgres extension archives (none are
  // loaded — the schema uses no extensions).
  let removed = 0;
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      // Type declarations are compile-time only; .map/.tar.gz are debug
      // artifacts and PGlite's unused Postgres extension archives.
      if (
        entry.name.endsWith(".map") ||
        entry.name.endsWith(".tar.gz") ||
        entry.name.endsWith(".d.ts") ||
        entry.name.endsWith(".d.cts") ||
        entry.name.endsWith(".d.mts")
      ) {
        removed += statSync(p).size;
        rmSync(p, { force: true });
      }
    }
  };
  walk(join(dir, "node_modules"));
  console.log(`pruned ${(removed / 1024 / 1024).toFixed(1)}MB of maps/types/archives`);
}

const root = process.cwd();
const out = resolve(root, process.argv[2] || "dist/app");
const standalone = join(root, ".next/standalone");

if (!existsSync(standalone)) {
  console.error("빌드 결과가 없습니다. 먼저 `bun run build`를 실행하세요.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The standalone output omits these three by design — Next expects the caller
// to place them alongside server.js.
cpSync(standalone, out, { recursive: true });
mkdirSync(join(out, ".next"), { recursive: true });
cpSync(join(root, ".next/static"), join(out, ".next/static"), { recursive: true });
if (existsSync(join(root, "public"))) {
  cpSync(join(root, "public"), join(out, "public"), { recursive: true });
}

// A build-time .env is developer configuration, not part of the product.
rmSync(join(out, ".env"), { force: true });

// Read at runtime, so they travel with the bundle.
cpSync(join(root, "drizzle"), join(out, "drizzle"), { recursive: true });
mkdirSync(join(out, "scripts"), { recursive: true });
for (const f of ["db-migrate.mjs", "sample-personas.mjs"]) {
  cpSync(join(root, "scripts", f), join(out, "scripts", f));
}

// The migration script runs OUTSIDE the Next graph, so its one dependency was
// never traced into the standalone node_modules. (It deliberately avoids
// drizzle-orm — see scripts/db-migrate.mjs — so the ~1 MB subset Next traced
// stays instead of the full 11 MB package.)
cpSync(
  join(root, "node_modules/@electric-sql/pglite"),
  join(out, "node_modules/@electric-sql/pglite"),
  { recursive: true },
);

// An optional persona corpus is a drop-in: put personas.db in data/ and the
// app switches from invented personas to corpus sampling on next start.
if (existsSync(join(root, "data"))) {
  cpSync(join(root, "data"), join(out, "data"), { recursive: true });
}

prune(out);

const runner = `#!/bin/sh
# Loop Studio launcher. Runs the migration first (PGlite allows one connection,
# so migrating and serving must not overlap), then the server on loopback only.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
export LOOP_DATA_DIR="\${LOOP_DATA_DIR:-$HOME/.loop}"
export LOOP_MIGRATIONS_DIR="$here/drizzle"
export LOOP_SAMPLER_SCRIPT="$here/scripts/sample-personas.mjs"
export PERSONA_DB_PATH="\${PERSONA_DB_PATH:-$here/data/personas.db}"
export HOSTNAME=127.0.0.1
export PORT="\${PORT:-3000}"
# Match the desktop shell exactly: some Next runtime requires only happen under
# production, so a launcher without this silently validates a different app.
export NODE_ENV=production

node "$here/scripts/db-migrate.mjs"
exec node "$here/server.js"
`;
writeFileSync(join(out, "run.sh"), runner);
chmodSync(join(out, "run.sh"), 0o755);

console.log(`packaged → ${out}`);
console.log(`실행: ${join(out, "run.sh")}`);
