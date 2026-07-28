/**
 * Applies pending migrations to the embedded database, then exits.
 *
 * Runs as its OWN process before the server starts, for two reasons:
 *   - PGlite allows a single connection, so migrating and serving must not
 *     overlap; sequencing two processes is simpler than sharing one.
 *   - Next compiles `instrumentation.ts` for the edge runtime too, and a
 *     migrator that reads node:fs cannot survive that bundle.
 *
 * It deliberately does NOT use drizzle's migrator: pulling `drizzle-orm` in
 * here meant shipping the whole 11 MB package (every SQL dialect) next to the
 * ~1 MB subset Next actually traces. The bookkeeping below is byte-compatible
 * with drizzle's — same `drizzle.__drizzle_migrations` table, same sha256 hash
 * of the file text, same "apply everything newer than the last `created_at`"
 * rule — so either migrator can pick up where the other left off.
 *
 * Usage: node scripts/db-migrate.mjs   (LOOP_DATA_DIR selects the database)
 */
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.LOOP_DATA_DIR || join(homedir(), ".loop");
const migrationsFolder = process.env.LOOP_MIGRATIONS_DIR || join(process.cwd(), "drizzle");
const dbDir = join(dataDir, "db");

/** Ordered migrations from the drizzle journal, with drizzle's own hashes. */
function readMigrations() {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) throw new Error(`_journal.json이 없습니다: ${journalPath}`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  return (journal.entries ?? []).map((entry) => {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    const text = readFileSync(sqlPath, "utf8");
    return {
      tag: entry.tag,
      when: entry.when,
      statements: text.split("--> statement-breakpoint"),
      hash: createHash("sha256").update(text).digest("hex"),
    };
  });
}

/**
 * Fingerprint of the migration set. Stored inside the db directory so that
 * deleting the database also invalidates it — a marker that outlived its
 * database would skip the very migrations a fresh one needs.
 */
const MARKER = join(dbDir, ".loop-migrations");

function fingerprint(migrations) {
  return createHash("sha256")
    .update(migrations.map((m) => `${m.tag}:${m.hash}`).join("\n"))
    .digest("hex");
}

const migrations = readMigrations();
const fp = fingerprint(migrations);

// Fast path: nothing to do, and worth detecting WITHOUT opening the database —
// a PGlite cold boot costs ~1.5s, which is most of the app's startup time.
if (existsSync(MARKER) && readFileSync(MARKER, "utf8").trim() === fp) {
  console.log(`db up to date: ${dbDir}`);
  process.exit(0);
}

mkdirSync(dbDir, { recursive: true });

/**
 * Same exclusive claim the server takes (src/db/lock.ts) — two PGlite
 * instances on one directory overwrite each other's data. Duplicated rather
 * than imported because this script runs outside the Next graph.
 */
const lockFile = join(dataDir, "db.lock");
function liveHolder() {
  try {
    const pid = Number(JSON.parse(readFileSync(lockFile, "utf8")).pid);
    if (!Number.isInteger(pid)) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e) {
      return e.code === "EPERM" ? pid : null;
    }
  } catch {
    return null;
  }
}
const holder = liveHolder();
if (holder !== null && holder !== process.pid) {
  console.error(
    `데이터 폴더가 다른 프로세스(pid ${holder})에서 사용 중입니다: ${dataDir}\n` +
      "실행 중인 Loop Studio를 먼저 종료하세요.",
  );
  process.exit(1);
}
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, label: "migrate" }));
process.once("exit", () => rmSync(lockFile, { force: true }));

const client = new PGlite(dbDir);

await client.exec(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
await client.exec(`
  CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )
`);

const { rows } = await client.query(
  `select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`,
);
const lastApplied = rows[0]?.created_at != null ? Number(rows[0].created_at) : null;

let applied = 0;
for (const m of migrations) {
  if (lastApplied !== null && lastApplied >= m.when) continue;
  // One transaction per migration: a half-applied schema is worse than a
  // failed startup, which the shell reports and the user can retry.
  await client.transaction(async (tx) => {
    for (const stmt of m.statements) {
      const sql = stmt.trim();
      if (sql) await tx.exec(sql);
    }
    await tx.query(
      `insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)`,
      [m.hash, m.when],
    );
  });
  applied++;
}

await client.close();
writeFileSync(MARKER, fp);

console.log(`db ready: ${dbDir}${applied ? ` (${applied} migration(s) applied)` : ""}`);
