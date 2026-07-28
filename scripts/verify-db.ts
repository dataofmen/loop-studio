/**
 * Smoke-checks the embedded database end to end: fresh data dir → migrate →
 * write → read back → reopen. Run with `bun scripts/verify-db.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-db-verify-"));
process.env.LOOP_DATA_DIR = dir;

const { db, closeDb } = await import("../src/db/index");
const { surveys, questions, appSettings, LOCAL_WORKSPACE_ID } = await import("../src/db/schema");
const { eq } = await import("drizzle-orm");

console.log("data dir:", dir);
// Migrations run as their own process before the server starts.
await Bun.$`node scripts/db-migrate.mjs`.quiet();
console.log("✓ migrated");

const [survey] = await db
  .insert(surveys)
  .values({ workspaceId: LOCAL_WORKSPACE_ID, title: "테스트", researchGoal: "PGlite 확인" })
  .returning();
console.log("✓ insert survey", survey.id, survey.status);

await db.insert(questions).values({
  surveyId: survey.id,
  type: "single",
  order: 0,
  prompt: "잘 되나요?",
  config: { options: [{ id: "o1", label: "예" }] },
});

const qs = await db.select().from(questions).where(eq(questions.surveyId, survey.id));
console.log("✓ jsonb round-trip", JSON.stringify(qs[0].config));

await db.insert(appSettings).values({ id: 1, cli: "cursor", model: "sonnet-4.5" });
const [s] = await db.select().from(appSettings);
console.log("✓ app settings", s.cli, s.model, s.batchSize);

// Regression guard for the 404-after-create bug: the client must live on
// globalThis, not module scope. Next instantiates src/db/index.ts once per
// compilation layer, and two PGlite instances on one directory are two
// diverging copies — a server action's insert became invisible to the page
// that redirected to it.
const g = globalThis as { __loopDb?: unknown; __loopPgliteClient?: unknown };
if (!g.__loopDb || !g.__loopPgliteClient) {
  throw new Error("DB 클라이언트가 globalThis에 없습니다 — 모듈 그래프마다 별도 인스턴스가 생깁니다.");
}
console.log("✓ single client on globalThis");

await closeDb();
console.log("✓ closed");

// closeDb() cleared the module's client, so the next query reopens the same
// directory from disk — the data must still be there.
const again = await db.select().from(surveys);
console.log("✓ reopened, surveys:", again.length, again[0]?.title);
await closeDb();

rmSync(dir, { recursive: true, force: true });
console.log("✓ all good");
