import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { constructs, newQuid, questions, surveys, templates } from "@/db/schema";
import { normalizeOptionsFrom } from "@/lib/carry-forward";
import { runLlmJson } from "@/lib/llm";
import { normalizeOptions } from "@/lib/question-config";
import { planDecomposition, structuredSummary } from "@/lib/template-summary";
import type { QConfig, QuestionType, RevisionQuestion } from "@/lib/question-diff";
import { snapshotQuestions } from "@/lib/revisions";
import { remapConfigRefs, remapSnapshotRefs, type DroppedRef } from "@/lib/template-refs";
import type { TemplateRow, TemplateSummary } from "@/lib/template-summary";
import { deriveMetaTags, summarizeTemplate } from "@/lib/template-summary";

// Re-export the pure summary/filter surface so server callers can keep importing
// from `@/lib/templates` (US-009 UI imports the pure module directly).
export type {
  TemplateMetaTags,
  TemplateSummary,
  TemplateRow,
  TemplateFilter,
} from "@/lib/template-summary";
export {
  filterTemplateSummaries,
  collectTagValues,
  summarizeTemplate,
  // Moved to the pure module in US-007 (canonical-vocabulary grouping) so it
  // is unit-testable; server callers keep importing it from here.
  deriveMetaTags,
} from "@/lib/template-summary";

/** Lists all templates in a workspace, newest first, summarized for the library UI (US-009). */
export async function listTemplates(workspaceId: string): Promise<TemplateSummary[]> {
  const rows = await db
    .select({
      id: templates.id,
      name: templates.name,
      description: templates.description,
      kind: templates.kind,
      aiSummary: templates.aiSummary,
      questionsSnapshot: templates.questionsSnapshot,
      metaTags: templates.metaTags,
      createdAt: templates.createdAt,
    })
    .from(templates)
    .where(eq(templates.workspaceId, workspaceId))
    .orderBy(desc(templates.createdAt));
  return rows.map((r) => summarizeTemplate(r as TemplateRow));
}

/** A stored template's persisted snapshot, guarded to a question array. */
function templateSnapshot(raw: unknown): RevisionQuestion[] {
  return Array.isArray(raw) ? (raw as RevisionQuestion[]) : [];
}

/**
 * Lists templates with their per-question quid/type/prompt for the editor
 * insert picker (US-905). Newest first; snapshot ordered by question order.
 */
export async function listTemplateQuestions(workspaceId: string): Promise<
  { id: string; name: string; kind: string; questions: { quid: string; type: string; prompt: string }[] }[]
> {
  const rows = await db
    .select({
      id: templates.id,
      name: templates.name,
      kind: templates.kind,
      questionsSnapshot: templates.questionsSnapshot,
    })
    .from(templates)
    .where(eq(templates.workspaceId, workspaceId))
    .orderBy(desc(templates.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    questions: templateSnapshot(r.questionsSnapshot)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((q) => ({ quid: q.quid, type: q.type, prompt: q.prompt })),
  }));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Seeds a template snapshot into `questions` rows for a survey. Each row gets
 * a FRESH quid (identity is per-survey) while the original template quid is
 * preserved as `config.sourceQuid` for provenance (US-010). Rows are ordered
 * sequentially starting at `startOrder`.
 *
 * Two-stage ref resolution (applyRevision pattern): rows are inserted first,
 * then displayLogic/optionsFrom refs — stored quid-form by saveAsTemplate /
 * createTemplateFromConstructQuestions — are rewritten to the NEW row ids. A
 * ref whose target quid is not in this snapshot (or a legacy template still
 * carrying dead live ids) is dropped and reported via `dropped`.
 */
async function seedQuestions(
  tx: Tx,
  surveyId: string,
  snapshot: RevisionQuestion[],
  startOrder: number,
): Promise<{ dropped: DroppedRef[] }> {
  const ordered = snapshot.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rows = ordered.map((q, i) => ({
    surveyId,
    quid: newQuid(),
    type: q.type,
    order: startOrder + i,
    prompt: q.prompt,
    config: { ...(q.config ?? {}), sourceQuid: q.quid } as QConfig,
  }));
  const inserted = await tx
    .insert(questions)
    .values(rows)
    .returning({ id: questions.id, order: questions.order });
  // RETURNING row order isn't guaranteed — rejoin by the unique `order` values.
  const idByOrder = new Map(inserted.map((r) => [r.order, r.id]));
  const quidToNewId = new Map(
    ordered.map((q, i) => [q.quid, idByOrder.get(startOrder + i) as string]),
  );

  const dropped: DroppedRef[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const config = rows[i].config;
    if (!config.displayLogic && !normalizeOptionsFrom(config.optionsFrom)) continue;
    const remapped = remapConfigRefs(config, quidToNewId, { dropUnmapped: true });
    for (const kind of remapped.droppedKinds) dropped.push({ prompt: ordered[i].prompt, kind });
    await tx
      .update(questions)
      .set({ config: remapped.config })
      .where(eq(questions.id, quidToNewId.get(ordered[i].quid) as string));
  }
  return { dropped };
}

/** Loads a template within the workspace or throws. */
async function loadTemplate(templateId: string, workspaceId: string) {
  const [tpl] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, templateId), eq(templates.workspaceId, workspaceId)))
    .limit(1);
  if (!tpl) throw new Error("템플릿을 찾을 수 없습니다.");
  return tpl;
}

/**
 * Creates a new draft survey seeded from a template's question set (US-010).
 * Each question gets a fresh quid (sourceQuid links back to the template) so
 * the new survey has independent identity while remaining traceable.
 */
export async function createSurveyFromTemplate(
  workspaceId: string,
  templateId: string,
  title?: string,
): Promise<{ id: string; dropped: DroppedRef[] }> {
  const tpl = await loadTemplate(templateId, workspaceId);
  const snapshot = templateSnapshot(tpl.questionsSnapshot);
  if (snapshot.length === 0) throw new Error("템플릿에 문항이 없습니다.");
  const [survey] = await db
    .insert(surveys)
    .values({
      workspaceId,
      title: (title?.trim() || tpl.name).slice(0, 200),
      researchGoal: `템플릿 "${tpl.name}"에서 생성`,
      status: "draft",
    })
    .returning({ id: surveys.id });
  const { dropped } = await db.transaction((tx) => seedQuestions(tx, survey.id, snapshot, 0));
  return { id: survey.id, dropped };
}

/**
 * Inserts a template's questions into an existing survey at `atIndex` (US-010).
 * Existing questions keep their relative order; inserted questions get fresh
 * quids (sourceQuid preserved). `atIndex` is a 0-based insertion position among
 * the current questions (0 = front, undefined/>=count = append). The whole set
 * is re-indexed in one transaction so orders stay a clean 0..N-1 permutation.
 */
export async function insertTemplateQuestions(
  surveyId: string,
  workspaceId: string,
  templateId: string,
  atIndex?: number,
  opts: { quids?: string[] } = {},
): Promise<{ inserted: number; dropped: DroppedRef[] }> {
  const [survey] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!survey) throw new Error("설문을 찾을 수 없습니다.");

  const tpl = await loadTemplate(templateId, workspaceId);
  const full = templateSnapshot(tpl.questionsSnapshot);
  if (full.length === 0) throw new Error("템플릿에 문항이 없습니다.");
  // US-905: optional subset insert. Keep the template's order; refs to
  // non-selected questions drop at seed time (seedQuestions, dropUnmapped).
  const snapshot =
    opts.quids && opts.quids.length > 0
      ? (() => {
          const want = new Set(opts.quids);
          const picked = full.filter((q) => want.has(q.quid));
          // Renumber so seedQuestions lays them out contiguously in template order.
          return picked
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((q, i) => ({ ...q, order: i }));
        })()
      : full;
  if (snapshot.length === 0) throw new Error("삽입할 문항을 선택하세요.");

  const live = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));

  const n = snapshot.length;
  const pos =
    atIndex == null || atIndex > live.length ? live.length : Math.max(0, Math.floor(atIndex));

  const { dropped } = await db.transaction(async (tx) => {
    // Re-index existing rows: those before `pos` keep their index; those at/after
    // shift down by `n` to open a contiguous gap for the inserted questions.
    for (let i = 0; i < live.length; i++) {
      const newOrder = i < pos ? i : i + n;
      await tx.update(questions).set({ order: newOrder }).where(eq(questions.id, live[i].id));
    }
    return seedQuestions(tx, surveyId, snapshot, pos);
  });
  await db.update(surveys).set({ updatedAt: new Date() }).where(eq(surveys.id, surveyId));
  return { inserted: n, dropped };
}

/** One selected question row to snapshot into a block/question template. */
type BlockSourceRow = {
  id: string;
  quid: string;
  type: string;
  prompt: string;
  config: unknown;
};

/**
 * Shared core (US-901/904): turns selected live question rows into a template
 * snapshot. Each snapshot question is minted a FRESH quid, keeps its live quid
 * as `config.sourceQuid` (provenance), and its displayLogic/optionsFrom refs
 * are rewritten to targets' fresh quids WHEN the target is also in the
 * selection — refs to unselected questions are dropped and reported (silent
 * loss forbidden). Rows should arrive in the desired snapshot order.
 */
function buildBlockSnapshot(rows: BlockSourceRow[]): {
  snapshot: RevisionQuestion[];
  dropped: DroppedRef[];
} {
  const freshQuids = rows.map(() => newQuid());
  const idToFreshQuid = new Map(rows.map((q, i) => [q.id, freshQuids[i]]));
  const dropped: DroppedRef[] = [];
  const snapshot: RevisionQuestion[] = rows.map((q, i) => {
    const remapped = remapConfigRefs((q.config ?? {}) as QConfig, idToFreshQuid, {
      dropUnmapped: true,
    });
    for (const kind of remapped.droppedKinds) dropped.push({ prompt: q.prompt, kind });
    const config = remapped.config;
    if (Array.isArray(config.options)) config.options = normalizeOptions(config.options);
    return {
      quid: freshQuids[i],
      type: q.type as QuestionType,
      order: i,
      prompt: q.prompt,
      config: { ...config, sourceQuid: q.quid },
    };
  });
  return { snapshot, dropped };
}

/**
 * Saves a hand-picked subset of a survey's questions as a reusable block
 * (US-904) or single question (US-906, kind='question'). Selection is by quid
 * within one survey; the survey must belong to the workspace. construct/topic
 * tags are derived from the selected questions' meta.
 */
export async function saveQuestionsAsBlock(
  surveyId: string,
  workspaceId: string,
  quids: string[],
  name: string,
  opts: { description?: string | null; kind?: "block" | "question" } = {},
): Promise<{ id: string; dropped: DroppedRef[] }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("이름을 입력하세요.");
  const wanted = [...new Set(quids)];
  if (wanted.length === 0) throw new Error("문항을 1개 이상 선택하세요.");

  // Scope to the survey AND its workspace so a forged surveyId can't leak rows.
  const rows = await db
    .select({
      id: questions.id,
      quid: questions.quid,
      type: questions.type,
      prompt: questions.prompt,
      config: questions.config,
      order: questions.order,
    })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(
      and(
        eq(questions.surveyId, surveyId),
        eq(surveys.workspaceId, workspaceId),
        inArray(questions.quid, wanted),
      ),
    )
    .orderBy(asc(questions.order));
  if (rows.length !== wanted.length) {
    throw new Error("선택한 문항 중 이 설문에 없는 문항이 있습니다.");
  }

  const { snapshot, dropped } = buildBlockSnapshot(rows);
  const [row] = await db
    .insert(templates)
    .values({
      workspaceId,
      name: trimmed.slice(0, 200),
      description: opts.description?.trim() || null,
      kind: opts.kind ?? "block",
      questionsSnapshot: snapshot,
      metaTags: deriveMetaTags(snapshot),
    })
    .returning({ id: templates.id });
  return { id: row.id, dropped };
}

/**
 * US-908: inserts the block/question sub-templates that a survey save is
 * decomposed into. `snapshot` is the survey template's stored snapshot (refs in
 * quid form); each planned unit's questions are re-minted with FRESH quids via
 * the shared buildBlockSnapshot core (keyed by original quid so in-unit refs
 * survive and cross-unit refs drop-with-notice). Derived rows carry
 * `metaTags.derivedFrom` = the parent survey template id for provenance/badging.
 * Runs inside the caller's transaction. A survey that decomposes into a single
 * unit covering every question is skipped — that unit just re-states the survey.
 */
async function decomposeSurveyTemplate(
  tx: Tx,
  workspaceId: string,
  parentId: string,
  snapshot: RevisionQuestion[],
): Promise<{ blocks: number; questions: number }> {
  const units = planDecomposition(snapshot);
  if (units.length <= 1 && (units[0]?.quids.length ?? 0) >= snapshot.length) {
    return { blocks: 0, questions: 0 };
  }
  const byQuid = new Map(snapshot.map((q) => [q.quid, q]));
  let blocks = 0;
  let questions = 0;
  for (const unit of units) {
    const rows: BlockSourceRow[] = unit.quids
      .map((quid) => byQuid.get(quid))
      .filter((q): q is RevisionQuestion => !!q)
      .map((q) => ({ id: q.quid, quid: q.quid, type: q.type, prompt: q.prompt, config: q.config }));
    if (rows.length === 0) continue;
    // Snapshot refs are in quid form, so keying buildBlockSnapshot by quid
    // (id = quid) remaps in-unit refs and drops refs to other units.
    const { snapshot: unitSnapshot } = buildBlockSnapshot(rows);
    const metaTags: Record<string, unknown> = {
      ...deriveMetaTags(unitSnapshot),
      derivedFrom: parentId,
    };
    if (unit.kind === "block") {
      metaTags.construct = unit.construct;
      if (unit.constructId) metaTags.constructId = unit.constructId;
    }
    await tx.insert(templates).values({
      workspaceId,
      name: unit.name.slice(0, 200),
      description: null,
      kind: unit.kind,
      questionsSnapshot: unitSnapshot,
      metaTags,
    });
    if (unit.kind === "block") blocks++;
    else questions++;
  }
  return { blocks, questions };
}

/**
 * Builds a construct question-bank template from hand-picked member questions
 * of one construct, possibly spanning several surveys (US-004 construct loop).
 *
 * Unlike saveAsTemplate (whole-survey snapshot keeps live quids), the selected
 * rows come from different surveys, so each snapshot question is minted a
 * FRESH quid and keeps its live quid as `config.sourceQuid` (the same
 * provenance contract seedQuestions applies when a template seeds a survey).
 * displayLogic/optionsFrom refs whose target question is ALSO in the selection
 * are rewritten to the target's fresh snapshot quid (resolved to new row ids
 * at seed time); refs to unselected questions are dropped and reported via
 * `dropped` — silent loss is forbidden.
 *
 * metaTags.construct/constructId are pinned to the given construct (the page
 * invoking this is the construct's own member list), with topic still derived
 * from the snapshot. Ownership is enforced twice: the construct must belong to
 * the workspace, and every selected question must resolve through its survey's
 * workspace — any foreign/unknown id fails the whole call.
 */
export async function createTemplateFromConstructQuestions(
  workspaceId: string,
  constructId: string,
  questionIds: string[],
  name: string,
): Promise<{ id: string; constructName: string; dropped: DroppedRef[] }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("템플릿 이름을 입력하세요.");
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) throw new Error("문항을 1개 이상 선택하세요.");

  const [construct] = await db
    .select({ id: constructs.id, name: constructs.name })
    .from(constructs)
    .where(and(eq(constructs.id, constructId), eq(constructs.workspaceId, workspaceId)))
    .limit(1);
  if (!construct) throw new Error("construct를 찾을 수 없습니다.");

  // Same ordering as the construct member list (survey title, question order)
  // so the template reads in the order the user picked from.
  const rows = await db
    .select({
      id: questions.id,
      quid: questions.quid,
      type: questions.type,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .innerJoin(surveys, eq(questions.surveyId, surveys.id))
    .where(and(eq(surveys.workspaceId, workspaceId), inArray(questions.id, ids)))
    .orderBy(asc(surveys.title), asc(questions.order));
  if (rows.length !== ids.length) {
    throw new Error("선택한 문항 중 이 워크스페이스에 없는 문항이 있습니다.");
  }

  // Shared block-snapshot core (fresh quid + sourceQuid + in-selection ref
  // remap + option normalize); construct pin is layered on top of the tags.
  const { snapshot, dropped } = buildBlockSnapshot(rows);

  const [row] = await db
    .insert(templates)
    .values({
      workspaceId,
      name: trimmed.slice(0, 200),
      description: `construct "${construct.name}" 문항 뱅크 (문항 ${snapshot.length}개 선택 저장)`,
      kind: "block",
      questionsSnapshot: snapshot,
      metaTags: {
        ...deriveMetaTags(snapshot),
        construct: construct.name,
        constructId: construct.id,
      },
    })
    .returning({ id: templates.id });
  return { id: row.id, constructName: construct.name, dropped };
}

/**
 * Saves the survey's current question set as a reusable template (US-008).
 * The snapshot preserves quid + option ids + config.meta so a template can
 * later seed a new survey or be inserted into an existing one (US-010).
 *
 * displayLogic/optionsFrom refs pointing at questions INSIDE the snapshot are
 * rewritten from live row ids to snapshot quids so they survive seeding
 * (seedQuestions resolves them to new row ids). Refs to questions no longer in
 * the survey are kept verbatim and dropped-with-notice at seed time.
 *
 * US-908: unless `opts.decompose === false`, the same save also auto-derives
 * smaller reuse units — construct groups become `block` templates and the rest
 * become `question` templates (see planDecomposition/decomposeSurveyTemplate) —
 * in the same transaction, so one survey save populates the library at every
 * granularity. `derived` reports how many of each were created.
 */
export async function saveAsTemplate(
  surveyId: string,
  workspaceId: string,
  name: string,
  description: string | null,
  opts: { decompose?: boolean } = {},
): Promise<{ id: string; derived: { blocks: number; questions: number } }> {
  const snapshot = await snapshotQuestions(surveyId);
  if (snapshot.length === 0) throw new Error("저장할 문항이 없습니다.");
  const liveRows = await db
    .select({ id: questions.id, quid: questions.quid })
    .from(questions)
    .where(eq(questions.surveyId, surveyId));
  const idToQuid = new Map(liveRows.map((r) => [r.id, r.quid]));
  const { questions: remapped } = remapSnapshotRefs(snapshot, idToQuid, { dropUnmapped: false });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(templates)
      .values({
        workspaceId,
        name,
        description: description || null,
        kind: "survey",
        questionsSnapshot: remapped,
        metaTags: deriveMetaTags(remapped),
      })
      .returning({ id: templates.id });
    const derived =
      opts.decompose === false
        ? { blocks: 0, questions: 0 }
        : await decomposeSurveyTemplate(tx, workspaceId, row.id, remapped);
    return { id: row.id, derived };
  });
}

/**
 * US-908 (retroactive): decomposes an EXISTING survey template into block/
 * question sub-templates from its stored snapshot — the same derivation a fresh
 * survey save performs, for templates saved before auto-decompose existed or
 * whenever an operator wants to (re)generate the smaller units on demand. Only
 * survey-kind templates decompose. Refuses when this template already has
 * derived children so a repeat click can't duplicate them.
 */
export async function decomposeTemplateById(
  templateId: string,
  workspaceId: string,
): Promise<{ blocks: number; questions: number }> {
  const tpl = await loadTemplate(templateId, workspaceId);
  if (tpl.kind !== "survey") throw new Error("설문 템플릿만 분해할 수 있습니다.");
  const snapshot = templateSnapshot(tpl.questionsSnapshot);
  if (snapshot.length === 0) throw new Error("템플릿에 문항이 없습니다.");
  const existing = await db
    .select({ meta: templates.metaTags })
    .from(templates)
    .where(eq(templates.workspaceId, workspaceId));
  if (existing.some((r) => (r.meta as Record<string, unknown>)?.derivedFrom === templateId)) {
    throw new Error("이미 이 템플릿에서 분해된 블록/문항이 있습니다.");
  }
  const derived = await db.transaction((tx) =>
    decomposeSurveyTemplate(tx, workspaceId, templateId, snapshot),
  );
  if (derived.blocks + derived.questions === 0) {
    throw new Error("분해할 단위가 없습니다(단일 개념 또는 단일 문항 설문).");
  }
  return derived;
}

/**
 * US-907: generates a one-line Korean summary of a template's question set via
 * the operator-side claude CLI and stores it in templates.ai_summary. The
 * structured composition is fed in so the model describes what is measured, not
 * just paraphrases prompts. Throws on empty template / LLM failure (caller
 * surfaces the error; existing ai_summary is left intact on failure).
 */
export async function generateTemplateSummary(
  templateId: string,
  workspaceId: string,
): Promise<{ summary: string }> {
  const tpl = await loadTemplate(templateId, workspaceId);
  const snapshot = templateSnapshot(tpl.questionsSnapshot);
  if (snapshot.length === 0) throw new Error("템플릿에 문항이 없습니다.");
  const s = structuredSummary(snapshot);
  const composition = s.typeCounts.map((c) => `${c.type} ${c.count}`).join(", ");
  const prompts = snapshot
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((q, i) => `${i + 1}. [${q.type}] ${q.prompt}`)
    .join("\n");
  const prompt = [
    "다음은 설문 템플릿의 문항 목록입니다. 이 템플릿이 무엇을 측정하는지",
    "한국어 한 문장(80자 이내)으로 요약하세요. 측정 개념 중심으로 쓰고,",
    "문항 나열이나 '이 템플릿은' 같은 군더더기는 넣지 마세요.",
    `\n구성: ${composition}`,
    s.constructs.length ? `측정 개념: ${s.constructs.join(", ")}` : "",
    `\n문항:\n${prompts}`,
    '\nJSON으로만 답하세요: {"summary": "..."}',
  ]
    .filter(Boolean)
    .join("\n");

  const result = await runLlmJson<{ summary?: string }>(prompt);
  const summary = (result.summary ?? "").trim().slice(0, 200);
  if (!summary) throw new Error("요약 생성에 실패했습니다.");
  await db.update(templates).set({ aiSummary: summary }).where(eq(templates.id, templateId));
  return { summary };
}
