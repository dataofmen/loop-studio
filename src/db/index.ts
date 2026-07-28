import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDataDirLock } from "./lock";
import * as schema from "./schema";

/**
 * Embedded Postgres (PGlite) living inside the app process.
 *
 * There is no server to install or run: the whole database is one directory
 * the user can copy to back up or move machines. `LOOP_DATA_DIR` points at it —
 * the desktop shell passes the OS app-data path; a bare `bun run dev` falls
 * back to ~/.loop.
 *
 * PGlite loads the database into memory and flushes it back to the directory,
 * so opening the same directory twice does not give you two connections to one
 * database — it gives you two DIVERGING COPIES that silently overwrite each
 * other. Exactly one PGlite instance may exist per process.
 *
 * That is why the client hangs off `globalThis` rather than module scope. Next
 * instantiates the same module once per compilation layer (server components
 * and server actions are separate graphs), so a module-scoped singleton is not
 * a singleton at all: a survey inserted by a server action landed in one copy
 * while the page that redirected to it read the other and returned 404.
 *
 * It is also why migrations run as their own process before the server starts
 * (scripts/db-migrate.ts) — that process exits before this one opens anything.
 *
 * The client is created on FIRST USE, not at import time: plenty of pure
 * modules sit downstream of something that imports `db`, and opening a database
 * just to import them would break unit tests and any process that never
 * queries.
 */

export function dataDir(): string {
  return process.env.LOOP_DATA_DIR || join(homedir(), ".loop");
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Cross-module-graph home for the one allowed PGlite instance. */
const globalForDb = globalThis as typeof globalThis & {
  __loopPgliteClient?: PGlite;
  __loopDb?: Db;
  __loopDbDir?: string;
};

function connect(): Db {
  const dir = join(dataDir(), "db");
  if (globalForDb.__loopDb) {
    // A data-dir change at runtime means a different database entirely; only
    // tests do this, but silently serving the old one would be a trap.
    if (globalForDb.__loopDbDir === dir) return globalForDb.__loopDb;
    throw new Error(
      `데이터 폴더가 실행 중에 바뀌었습니다 (${globalForDb.__loopDbDir} → ${dir}). 앱을 다시 시작하세요.`,
    );
  }
  // PGlite creates the leaf directory but not missing parents.
  mkdirSync(dir, { recursive: true });
  // Refuse to be the second process in this directory — see ./lock.ts.
  acquireDataDirLock(dataDir(), "server");
  globalForDb.__loopPgliteClient = new PGlite(dir);
  globalForDb.__loopDb = drizzle(globalForDb.__loopPgliteClient, { schema });
  globalForDb.__loopDbDir = dir;
  return globalForDb.__loopDb;
}

/** The raw PGlite handle — shutdown needs it. */
export function pgliteClient(): PGlite {
  connect();
  return globalForDb.__loopPgliteClient as PGlite;
}

/** Flushes and closes the database. Called when the desktop shell exits. */
export async function closeDb(): Promise<void> {
  if (!globalForDb.__loopPgliteClient) return;
  await globalForDb.__loopPgliteClient.close();
  globalForDb.__loopPgliteClient = undefined;
  globalForDb.__loopDb = undefined;
  globalForDb.__loopDbDir = undefined;
}

export const db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(connect(), prop, receiver);
  },
});

export { schema };
