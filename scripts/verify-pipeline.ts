/**
 * End-to-end smoke test of design → personas → simulation → analysis against a
 * scratch database and the real agent CLI.
 *
 * Run with `bun scripts/verify-pipeline.ts`. Set PERSONA_DB_PATH to exercise
 * the corpus path; without it the persona step uses the CLI fallback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "loop-pipeline-"));
process.env.LOOP_DATA_DIR = dir;
await Bun.$`node scripts/db-migrate.mjs`.quiet();
console.log("✓ migrated", dir);

const { db } = await import("../src/db/index");
const { surveys, questions, personas, responses, simulationJobs, LOCAL_WORKSPACE_ID } =
  await import("../src/db/schema");
const { eq, asc } = await import("drizzle-orm");
const { generateSurvey } = await import("../src/lib/surveys");
const { generatePersonas } = await import("../src/lib/personas");
const { corpusAvailable } = await import("../src/lib/persona-corpus");
const { runSimulation } = await import("../src/lib/simulate");
const { getResponseAnalysis } = await import("../src/lib/analysis");
const { saveAgentSettings, getAgentSettings, engineLabel } = await import("../src/lib/settings");
const { detectCli } = await import("../src/lib/agent-cli");

const cli = await detectCli("claude");
console.log("cli:", cli.available ? `${cli.path} ${cli.version}` : "NOT FOUND");
if (!cli.available) process.exit(1);
console.log("corpus:", corpusAvailable() ? "installed" : "absent → CLI fallback");

// Small batches keep the smoke test quick.
await saveAgentSettings({ cli: "claude", model: "sonnet", concurrency: 3, batchSize: 3 });

let t = Date.now();
const surveyId = await generateSurvey(LOCAL_WORKSPACE_ID, "배달앱 사용자의 재주문 결정 요인을 파악한다");
const qs = await db.select().from(questions).where(eq(questions.surveyId, surveyId)).orderBy(asc(questions.order));
console.log(`✓ 설계 ${((Date.now() - t) / 1000).toFixed(1)}s — 문항 ${qs.length}개`);

t = Date.now();
const personaCount = await generatePersonas(LOCAL_WORKSPACE_ID, surveyId, "20~40대 배달앱 이용자", 6);
const ps = await db.select().from(personas).where(eq(personas.surveyId, surveyId));
console.log(`✓ 페르소나 ${((Date.now() - t) / 1000).toFixed(1)}s — ${personaCount}명`);
for (const p of ps.slice(0, 3)) {
  const a = p.attributes as Record<string, unknown>;
  console.log(`   - ${a.sex ?? "?"} ${a.age ?? "?"} ${a.province ?? "?"} / ${a.occupation ?? "?"}`);
}

t = Date.now();
const settings = await getAgentSettings();
const [job] = await db
  .insert(simulationJobs)
  .values({
    workspaceId: LOCAL_WORKSPACE_ID,
    surveyId,
    model: engineLabel(settings),
    total: ps.length,
    status: "running",
  })
  .returning({ id: simulationJobs.id });
await runSimulation(job.id, surveyId);
const [done] = await db.select().from(simulationJobs).where(eq(simulationJobs.id, job.id));
const rs = await db.select().from(responses).where(eq(responses.surveyId, surveyId));
console.log(
  `✓ 시뮬레이션 ${((Date.now() - t) / 1000).toFixed(1)}s — ${done.status}, 응답 ${rs.length}건` +
    (done.error ? ` (경고: ${done.error})` : ""),
);

const analysis = await getResponseAnalysis(surveyId);
console.log(`✓ 분석 — n=${analysis.responseCount}, 분포 ${analysis.distributions.length}문항`);
for (const d of analysis.distributions.slice(0, 3)) {
  const top = d.counts.slice(0, 3).map((c) => `${c.label} ${c.count}`).join(", ");
  console.log(`   - [${d.type}] ${d.prompt.slice(0, 34)}… → ${top}`);
}

const [s] = await db.select().from(surveys).where(eq(surveys.id, surveyId));
console.log(`✓ 상태: ${s.status}`);

rmSync(dir, { recursive: true, force: true });
console.log("✓ done");
