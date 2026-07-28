import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { newQuid, questions, surveys, surveyProposals, surveyRevisions } from "@/db/schema";
import { runLlmJson } from "@/lib/llm";
import { lintProposal } from "@/lib/logic-lint";
import { normalizeOptions, optionLabels, promoteSpecialOptions, stampMetaOrigin } from "@/lib/question-config";
import {
  displayLogicToShowIf,
  sanitizeShowIf,
  showIfToDisplayLogic,
  type DisplayLogic,
} from "@/lib/display-logic";
import {
  changeSummaryOf,
  diffQuestions,
  materializeShowIf,
  diffQuestionsDetailed,
  summarizeRevisions,
  type ChangeSummary,
  type QConfig,
  type QuestionChangeDetail,
  type QuestionDiff,
  type QuestionType,
  type RevisionQuestion,
  type RevisionRow,
} from "@/lib/question-diff";

// Re-export the pure diff types/functions so existing importers of
// "@/lib/revisions" (revision-actions, revision-panel) keep working.
export { changeSummaryOf, diffQuestions, diffQuestionsDetailed, summarizeRevisions };
export type { ChangeSummary, QuestionChangeDetail, QuestionDiff, RevisionQuestion, RevisionRow };

const VALID: QuestionType[] = ["single", "multi", "scale", "open", "ranking", "matrix", "nps"];

/** Live question set as a snapshot array (ordered). quid = the stable quid column. */
export async function snapshotQuestions(surveyId: string): Promise<RevisionQuestion[]> {
  const rows = await db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));
  return rows.map((q, i) => ({
    quid: q.quid,
    type: q.type as QuestionType,
    order: i,
    prompt: q.prompt,
    // Normalize options to the canonical {id,label}[] so snapshots/diffs compare
    // like-for-like regardless of whether the row predates object options.
    config: withNormalizedOptions((q.config ?? {}) as QConfig),
  }));
}

/** Returns config with its `options` normalized to {id,label}[] (if present). */
function withNormalizedOptions(config: QConfig): QConfig {
  if (!Array.isArray(config.options)) return config;
  return { ...config, options: normalizeOptions(config.options) };
}

/**
 * Carries stable quids from a reference set onto a freshly-proposed set so a
 * question keeps its identity across an AI revision (the proposal has no quids):
 *   1) exact prompt match → reuse the reference quid (unchanged / reordered)
 *   2) leftover proposed matched to leftover reference by position → reuse quid (edited)
 *   3) anything still unmatched → a brand-new quid (genuinely added)
 */
function carryQuids(proposed: RevisionQuestion[], reference: RevisionQuestion[]): RevisionQuestion[] {
  const usedRef = new Set<number>();
  const result: (string | null)[] = proposed.map(() => null);

  proposed.forEach((p, i) => {
    const j = reference.findIndex((r, ri) => !usedRef.has(ri) && r.prompt === p.prompt);
    if (j >= 0) {
      usedRef.add(j);
      result[i] = reference[j].quid;
    }
  });
  const freeRef = reference.map((_, ri) => ri).filter((ri) => !usedRef.has(ri));
  let fr = 0;
  proposed.forEach((_, i) => {
    if (result[i] == null && fr < freeRef.length) {
      result[i] = reference[freeRef[fr++]].quid;
    }
  });
  return proposed.map((p, i) => ({ ...p, quid: result[i] ?? newQuid() }));
}

/**
 * The model sees options as plain labels, so its echo loses option identity
 * and behavior flags (stable id, special "기타"/"없음" anchoring, noText).
 * Re-attach them by label from the current question with the same quid, so an
 * option the proposal KEPT keeps its id and special behavior. Renamed options
 * degrade gracefully (fresh derived id, no special) — same as before.
 */
function reattachOptionMeta(
  proposed: RevisionQuestion[],
  reference: RevisionQuestion[],
): RevisionQuestion[] {
  const refByQuid = new Map(reference.map((r) => [r.quid, r]));
  return proposed.map((p) => {
    if (!Array.isArray(p.config.options)) return p;
    const ref = refByQuid.get(p.quid);
    const refOpts = ref && Array.isArray(ref.config.options) ? normalizeOptions(ref.config.options) : [];
    if (refOpts.length === 0) return p;
    const byLabel = new Map(refOpts.map((o) => [o.label, o]));
    const used = new Set<string>();
    const options = normalizeOptions(p.config.options).map((o) => {
      const match = byLabel.get(o.label);
      if (!match || used.has(match.id)) return o;
      used.add(match.id);
      return match;
    });
    return { ...p, config: { ...p.config, options } };
  });
}

function validate(qs: unknown): RevisionQuestion[] {
  if (!Array.isArray(qs) || qs.length === 0) throw new Error("제안된 문항이 없습니다.");
  return qs.map((q, i) => {
    const x = q as RevisionQuestion;
    if (!VALID.includes(x.type)) throw new Error(`잘못된 문항 타입: ${x.type}`);
    if (!x.prompt) throw new Error("문항 내용 누락");
    const showIf = sanitizeShowIf(x.showIf);
    const ofr = (x as { optionsFromRef?: { ref?: unknown } }).optionsFromRef;
    const optionsFromRef =
      ofr && Number.isInteger(Number(ofr.ref)) && Number(ofr.ref) >= 1
        ? { ref: Number(ofr.ref), mode: "selected" as const }
        : undefined;
    // Metadata trust tier (US-003): meta without an origin came from the AI
    // proposal path, so default it to "ai"; an echoed origin:"human" on kept
    // questions passes through untouched (human meta is never downgraded).
    const meta = stampMetaOrigin(x.config?.meta, "ai");
    return {
      quid: x.quid || newQuid(),
      type: x.type,
      order: i,
      prompt: String(x.prompt),
      // Ref-form logic rides along for applyRevision to resolve (not stored).
      ...(showIf ? { showIf } : {}),
      ...(optionsFromRef ? { optionsFromRef } : {}),
      config: {
        ...(x.type === "single" || x.type === "multi"
          ? { options: normalizeOptions(x.config?.options) }
          : x.type === "ranking"
          ? { options: normalizeOptions(x.config?.options), ...(x.config?.limit ? { limit: x.config.limit } : {}) }
          : x.type === "scale"
            ? { scale: x.config?.scale ?? { min: 1, max: 5 } }
            : x.type === "matrix"
              ? { rows: x.config?.rows ?? [], columns: x.config?.columns ?? [] }
              : {}),
        // Preserve researcher/AI metadata across revisions (Artifact 2).
        ...(meta ? { meta } : {}),
        // Preserve conditional display logic across revisions.
        ...(x.config?.displayLogic ? { displayLogic: x.config.displayLogic } : {}),
        // Preserve probing + option-display settings across revisions/reverts
        // (dropping them here silently reset the features on revert).
        ...(x.config?.probe ? { probe: x.config.probe } : {}),
        ...(x.config?.randomizeOptions ? { randomizeOptions: true } : {}),
      },
    };
  });
}

/**
 * The live questions with stable quids. Since quid is now a first-class column
 * (US-001) preserved in place across revisions by writeQuestions, the live
 * snapshot already carries stable identity — no prompt-matching needed.
 */
export async function currentStable(surveyId: string): Promise<RevisionQuestion[]> {
  return snapshotQuestions(surveyId);
}

/**
 * Asks the claude CLI to propose a revised question set that addresses the
 * human feedback. Returns a PROPOSAL only — nothing is applied here.
 */
export async function proposeRevision(
  surveyId: string,
  feedback: string,
): Promise<{
  rationale: string;
  questions: RevisionQuestion[];
  current: RevisionQuestion[];
  diff: QuestionDiff;
  /** Unresolved display-logic errors after self-repair (show before apply). */
  lintWarnings: string[];
  /** Live question id → prompt (renders displayLogic references readably). */
  questionPrompts: Record<string, string>;
}> {
  const [survey] = await db.select().from(surveys).where(eq(surveys.id, surveyId));
  const current = await currentStable(surveyId);

  // Display logic references live question row ids; the model instead sees and
  // returns 1-based index refs ("showIf"), so map ids ↔ current positions.
  const liveIds = (
    await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.surveyId, surveyId))
      .orderBy(asc(questions.order))
  ).map((r) => r.id);
  const refOfId = new Map(liveIds.map((id, i) => [id, i + 1]));

  // Present options as plain label arrays to the model (it thinks in strings)
  // and display logic in ref form; the returned proposal is re-normalized by
  // validate() and refs are resolved back to ids at apply time.
  const currentForPrompt = current.map((q) => {
    const { displayLogic, optionsFrom, ...restConfig } = q.config;
    const showIf = displayLogic
      ? displayLogicToShowIf(displayLogic as DisplayLogic, (id) => refOfId.get(id))
      : undefined;
    const ofRef = optionsFrom?.questionId ? refOfId.get(optionsFrom.questionId) : undefined;
    return {
      ...q,
      config: Array.isArray(restConfig.options)
        ? { ...restConfig, options: optionLabels(restConfig.options) }
        : restConfig,
      ...(showIf ? { showIf } : {}),
      ...(ofRef ? { optionsFromRef: { ref: ofRef, mode: "selected" as const } } : {}),
    };
  });

  const prompt = `You are revising an existing survey based on human feedback. Keep what works; change only what the feedback calls for.

Research goal: "${survey?.researchGoal ?? ""}"

Current questions (JSON):
${JSON.stringify(currentForPrompt, null, 0)}

Human feedback: "${feedback}"

Some questions carry a "config.meta" object (construct = concept measured, topic, population, source, validatedScale, notes, origin). Honor it: do not reword a question whose source is "validated"/"adapted" beyond what the feedback demands, keep each question measuring its stated construct, and use notes as design intent. Preserve config.meta unchanged (including "origin") on questions you keep. Every question you ADD MUST include "config.meta" with at least "construct" (the single concept it measures) and "topic" (a short tag), written in the survey's language — reuse an existing question's construct wording verbatim when the new question measures the same concept.

Return ONLY a JSON object (no prose, no fences):
{
  "rationale": "<one-sentence Korean summary of what you changed and why>",
  "questions": [
    { "type": "single|multi|scale|open|ranking|matrix|nps", "prompt": "...", "config": { "options": ["..."] | "scale": {"min":1,"max":5} | "rows": ["..."], "columns": ["..."] }, "showIf": { "match": "all|any", "conditions": [{ "ref": <1-based index into YOUR returned questions list>, "op": "eq|ne|in|not_in|gte|lte|gt|lt|contains", "value": "<string | number | string[]>" }] } }
  ]
}
Keep 5-10 questions, mixed types. single/multi/ranking need config.options; ranking may add config.limit (integer, top-N to rank; omit to rank all); scale needs config.scale; matrix needs config.rows + config.columns; nps/open need no config.

"optionsFromRef" (optional, choice questions): {"ref": N, "mode": "selected"} makes the question's options BE the options the respondent selected in question N (carry-forward — e.g. "이 중 가장 결정적인 이유 1가지" showing only reasons picked before). Use it whenever a question asks to pick among "위에서 선택한" items; such a question needs no config.options of its own. N must be an EARLIER choice question in YOUR returned list.

"showIf" (optional) gates a question so respondents only see it when the condition on an EARLIER question's answer holds. Rules:
- "ref" is the 1-based position of the referenced question in YOUR returned list (it must come before the gated question). For choice questions use the exact option label strings as values.
- Some current questions carry a "showIf" — keep it (adjusting refs to your new ordering) unless the feedback asks otherwise. Dropping it silently is wrong.
- If you rename, split, or remove an OPTION, you MUST update every showIf condition value that referenced the old label. After your changes, every condition value must EXACTLY match one of the referenced question's option labels in YOUR returned list — a condition citing a label that no longer exists can never trigger.
- When you ADD a screening/branching question (e.g. subscription status), ADD matching showIf to the questions that only make sense for a subset (e.g. ask tenure only of current subscribers). Think about which existing questions become conditional because of your changes.`;

  // A proposal can rewrite/expand the whole survey (e.g. 10 review issues at
  // once) — that's a long generation, well past the 120s default. A malformed
  // JSON reply is a transient model slip — retry the whole call once.
  let out: { rationale?: string; questions?: unknown };
  try {
    out = await runLlmJson(prompt, { timeoutMs: 300_000 });
  } catch (e) {
    if (e instanceof Error && e.message.includes("유효하지 않은 JSON")) {
      out = await runLlmJson(prompt, { timeoutMs: 300_000 });
    } else {
      throw e;
    }
  }
  // Carry the current questions' quids onto the proposal so identity is stable
  // (enables an accurate delete/reorder/edit diff and a stable stored snapshot).
  let proposed = carryQuids(validate(out.questions), current);
  let rationale = String(out.rationale ?? "");

  // Deterministic verification + ONE self-repair round: the classic LLM slip
  // is renaming/splitting an option without updating conditions that cited the
  // old label. lintProposal catches it; the model gets one shot to fix itself.
  // Every lint finding is repair-worthy in a FRESH proposal (a warning like
  // value_not_in_options means a condition that can never trigger).
  let issues = lintProposal(proposed);
  if (issues.length > 0) {
    try {
      const repairPrompt = `Your survey-revision JSON has display-logic errors. Return the SAME JSON shape ({"rationale", "questions"}) with ONLY these problems fixed — keep every other question, wording, and showIf identical.

Errors (question numbers are 1-based positions in your "questions" array):
${issues.map((w) => `- Q${w.questionId}: ${w.message}`).join("\n")}

Your previous JSON:
${JSON.stringify({ rationale, questions: proposed })}`;
      const out2 = await runLlmJson<{ rationale?: string; questions?: unknown }>(repairPrompt, {
        timeoutMs: 180_000,
      });
      const repaired = carryQuids(validate(out2.questions), current);
      const issues2 = lintProposal(repaired);
      if (issues2.length < issues.length) {
        proposed = repaired;
        rationale = String(out2.rationale ?? rationale);
        issues = issues2;
      }
    } catch {
      // repair is best-effort — surface the remaining issues instead
    }
  }
  const lintWarnings = issues.map(
    (w) => `제안 ${w.questionId}번 문항: ${w.message}`,
  );
  // Resolve echoed conditions back to stored shape so diffs compare
  // like-for-like (prevents the false "표시 조건 → 없음" change lines), and
  // re-attach option identity/special flags the label-only echo dropped.
  // Then promote label-detected specials ("기타(직접 입력)" 등) the model
  // ADDED as plain strings — ids from reattach are preserved.
  const quidToLiveId = new Map(current.map((q, i) => [q.quid, liveIds[i]]));
  const withSpecials = reattachOptionMeta(proposed, current).map((q) =>
    Array.isArray(q.config.options)
      ? { ...q, config: { ...q.config, options: promoteSpecialOptions(normalizeOptions(q.config.options)) } }
      : q,
  );
  const materialized = materializeShowIf(withSpecials, quidToLiveId);
  return {
    rationale,
    questions: materialized,
    current,
    diff: diffQuestions(current, materialized),
    lintWarnings,
    questionPrompts: Object.fromEntries(liveIds.map((id, i) => [id, current[i]?.prompt ?? ""])),
  };
}

/**
 * Current revision version of a survey — the latest survey_revisions entry,
 * or 1 (implicit baseline) when the survey was never revised. Stamped onto
 * response rows at collection time (metadata: which version answered).
 */
export async function currentSurveyVersion(surveyId: string): Promise<number> {
  const [row] = await db
    .select({ v: sql<number | null>`max(${surveyRevisions.version})::int` })
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId));
  return row?.v ?? 1;
}

/**
 * Lazily records a v1 baseline of the current questions if no revisions exist.
 * Manual-edit callers must invoke this BEFORE mutating so v1 captures the
 * pre-edit state (calling it after would stamp the edited set as the baseline).
 */
export async function ensureBaseline(surveyId: string, workspaceId: string) {
  const [{ c }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId));
  if (c === 0) {
    await db.insert(surveyRevisions).values({
      workspaceId,
      surveyId,
      version: 1,
      reason: "초기 버전",
      questionsSnapshot: await snapshotQuestions(surveyId),
    });
  }
}

const MANUAL_REASON = "직접 수정";
// Consecutive manual edits within this window fold into one version, so a
// debounced autosave stream (per-keystroke flushes) yields one version per
// editing session instead of one per flush.
const MANUAL_COALESCE_MS = 10 * 60 * 1000;

/**
 * Records the current question set as a "직접 수정" version after a manual
 * editor change (question add/delete/reorder, prompt/option/config edits).
 * Call AFTER the mutation, with ensureBaseline() called BEFORE it. No-ops when
 * nothing actually changed vs the latest version; extends the latest version
 * in place (snapshot + timestamp) when it is a recent manual edit.
 */
export async function recordManualRevision(surveyId: string, workspaceId: string): Promise<void> {
  const [latest] = await db
    .select()
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId))
    .orderBy(desc(surveyRevisions.version))
    .limit(1);
  if (!latest) return; // no baseline to diff against (ensureBaseline not called)

  const snap = await snapshotQuestions(surveyId);
  const summary = changeSummaryOf(latest.questionsSnapshot as RevisionQuestion[], snap);
  if (!summary || summary.added + summary.deleted + summary.changed + summary.reordered === 0) return;

  // Named checkpoints are user-pinned states — never coalesce over them.
  const isRecentManual =
    latest.reason === MANUAL_REASON &&
    !latest.label &&
    Date.now() - latest.createdAt.getTime() < MANUAL_COALESCE_MS;
  if (isRecentManual) {
    await db
      .update(surveyRevisions)
      .set({ questionsSnapshot: snap, createdAt: new Date() })
      .where(eq(surveyRevisions.id, latest.id));
    return;
  }
  await db.insert(surveyRevisions).values({
    workspaceId,
    surveyId,
    version: latest.version + 1,
    reason: MANUAL_REASON,
    questionsSnapshot: snap,
  });
}

async function nextVersion(surveyId: string): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${surveyRevisions.version}), 0)` })
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId));
  return (max ?? 0) + 1;
}

/**
 * Reconciles the live questions to `proposed`, matching by quid (then by prompt
 * as a fallback for reverts). Matched questions are UPDATED in place so their
 * question.id — and therefore any responses already keyed by that id — survive
 * the revision. Only genuinely-new questions are inserted; removed ones deleted.
 * Returns the live question ids in proposed order (for showIf ref resolution).
 */
async function writeQuestions(surveyId: string, proposed: RevisionQuestion[]): Promise<string[]> {
  const liveRows = await db
    .select({ id: questions.id, quid: questions.quid, prompt: questions.prompt })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order));

  // Live rows are keyed by their first-class quid column (US-001), so identity
  // survives moves/edits directly — no prompt-matching against snapshots needed.
  const quidToId = new Map<string, string>();
  for (const lr of liveRows) quidToId.set(lr.quid, lr.id);
  const promptToIds = new Map<string, string[]>();
  for (const lr of liveRows) {
    const arr = promptToIds.get(lr.prompt) ?? [];
    arr.push(lr.id);
    promptToIds.set(lr.prompt, arr);
  }

  const usedLive = new Set<string>();
  const idsInOrder: string[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < proposed.length; i++) {
      const p = proposed[i];
      let liveId = quidToId.get(p.quid);
      if (liveId && usedLive.has(liveId)) liveId = undefined;
      if (!liveId) {
        // Revert path: a restored snapshot's quid may not exist live — reuse a
        // same-prompt row and re-stamp it with the restored quid below.
        liveId = (promptToIds.get(p.prompt) ?? []).find((id) => !usedLive.has(id));
      }
      if (liveId) {
        usedLive.add(liveId);
        await tx
          .update(questions)
          .set({ type: p.type, order: i, prompt: p.prompt, config: p.config, quid: p.quid })
          .where(eq(questions.id, liveId));
        idsInOrder.push(liveId);
      } else {
        const [inserted] = await tx
          .insert(questions)
          .values({ surveyId, type: p.type, order: i, prompt: p.prompt, config: p.config, quid: p.quid })
          .returning({ id: questions.id });
        idsInOrder.push(inserted.id);
      }
    }
    for (const lr of liveRows) {
      if (!usedLive.has(lr.id)) await tx.delete(questions).where(eq(questions.id, lr.id));
    }
  });
  return idsInOrder;
}

/** Applies a proposed revision: snapshots baseline, swaps questions, records the version. */
export async function applyRevision(
  surveyId: string,
  workspaceId: string,
  proposed: RevisionQuestion[],
  reason: string,
): Promise<number> {
  await ensureBaseline(surveyId, workspaceId);
  const version = await nextVersion(surveyId);

  const current = await snapshotQuestions(surveyId);
  const currentByQuid = new Map(current.map((q) => [q.quid, q]));
  const qs = validate(proposed);
  // A proposal that neither returns showIf nor echoes displayLogic must not
  // silently strip a kept question's existing display condition.
  for (const q of qs) {
    if (q.showIf || q.config.displayLogic) continue;
    const cur = currentByQuid.get(q.quid);
    if (cur?.config.displayLogic) q.config = { ...q.config, displayLogic: cur.config.displayLogic };
  }

  const ids = await writeQuestions(surveyId, qs);

  // Resolve ref-form showIf / optionsFromRef (1-based index into the proposed
  // list) to real question ids, now that every proposed question has a live row.
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (!q.showIf && !q.optionsFromRef) continue;
    const config = { ...q.config };
    if (q.showIf) {
      const logic = showIfToDisplayLogic(q.showIf, (ref) => ids[ref - 1], i + 1);
      if (logic) config.displayLogic = logic;
      else delete config.displayLogic;
    }
    if (q.optionsFromRef) {
      const srcId = q.optionsFromRef.ref !== i + 1 ? ids[q.optionsFromRef.ref - 1] : undefined;
      if (srcId) config.optionsFrom = { questionId: srcId, mode: "selected" };
      else delete config.optionsFrom;
    }
    await db.update(questions).set({ config }).where(eq(questions.id, ids[i]));
  }

  await db.insert(surveyRevisions).values({
    workspaceId,
    surveyId,
    version,
    reason: reason || "AI 수정 적용",
    // Snapshot the reconciled DB state (includes resolved display logic).
    questionsSnapshot: await snapshotQuestions(surveyId),
  });
  await db.update(surveys).set({ updatedAt: new Date() }).where(eq(surveys.id, surveyId));
  return version;
}

export async function listRevisions(surveyId: string): Promise<RevisionRow[]> {
  // Ascending so each row can diff against the previous (adjacent) snapshot.
  const rows = await db
    .select()
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId))
    .orderBy(asc(surveyRevisions.version));
  return summarizeRevisions(
    rows.map((r) => ({
      version: r.version,
      reason: r.reason,
      label: r.label,
      createdAt: r.createdAt,
      questionsSnapshot: r.questionsSnapshot as RevisionQuestion[],
    })),
  );
}

/** Sets or clears a version's user-given checkpoint name. */
export async function setRevisionLabel(
  surveyId: string,
  workspaceId: string,
  version: number,
  label: string | null,
): Promise<void> {
  const trimmed = label?.trim().slice(0, 60) || null;
  const [row] = await db
    .update(surveyRevisions)
    .set({ label: trimmed })
    .where(
      and(
        eq(surveyRevisions.surveyId, surveyId),
        eq(surveyRevisions.workspaceId, workspaceId),
        eq(surveyRevisions.version, version),
      ),
    )
    .returning({ version: surveyRevisions.version });
  if (!row) throw new Error("해당 버전을 찾을 수 없습니다.");
}

/**
 * Saves the CURRENT question set as a named checkpoint. If nothing changed
 * since the latest version, that version is named instead of duplicating the
 * snapshot; otherwise a new labeled version is recorded. Either way the named
 * version is protected from manual-edit coalescing.
 */
export async function saveNamedVersion(
  surveyId: string,
  workspaceId: string,
  name: string,
): Promise<number> {
  const trimmed = name.trim().slice(0, 60);
  if (trimmed.length < 2) throw new Error("버전 이름을 2자 이상 입력해 주세요.");
  await ensureBaseline(surveyId, workspaceId);
  const snap = await snapshotQuestions(surveyId);
  const [latest] = await db
    .select()
    .from(surveyRevisions)
    .where(eq(surveyRevisions.surveyId, surveyId))
    .orderBy(desc(surveyRevisions.version))
    .limit(1);
  const summary = latest
    ? changeSummaryOf(latest.questionsSnapshot as RevisionQuestion[], snap)
    : null;
  const unchanged =
    summary != null &&
    summary.added + summary.deleted + summary.changed + summary.reordered === 0;
  if (latest && unchanged) {
    await setRevisionLabel(surveyId, workspaceId, latest.version, trimmed);
    return latest.version;
  }
  const version = latest ? latest.version + 1 : 1;
  await db.insert(surveyRevisions).values({
    workspaceId,
    surveyId,
    version,
    reason: "버전 저장",
    label: trimmed,
    questionsSnapshot: snap,
  });
  return version;
}

/**
 * Field/option-level comparison between two versions of a survey (US-006).
 * `fromVersion` should be the older baseline, `toVersion` the newer target;
 * the returned details describe how `to` differs from `from`.
 */
export async function compareRevisions(
  surveyId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{
  from: number;
  to: number;
  details: QuestionChangeDetail[];
  // Full snapshots so the UI can show added/deleted question content.
  fromSnapshot: RevisionQuestion[];
  toSnapshot: RevisionQuestion[];
  // Live question id → prompt, for rendering display-logic references.
  questionPrompts: Record<string, string>;
}> {
  const rows = await db
    .select()
    .from(surveyRevisions)
    .where(and(eq(surveyRevisions.surveyId, surveyId), inArray(surveyRevisions.version, [fromVersion, toVersion])));
  const byVersion = new Map(rows.map((r) => [r.version, r.questionsSnapshot as RevisionQuestion[]]));
  const fromSnap = byVersion.get(fromVersion);
  const toSnap = byVersion.get(toVersion);
  if (!fromSnap || !toSnap) throw new Error("비교할 버전을 찾을 수 없습니다.");
  const live = await db
    .select({ id: questions.id, prompt: questions.prompt })
    .from(questions)
    .where(eq(questions.surveyId, surveyId));
  return {
    from: fromVersion,
    to: toVersion,
    details: diffQuestionsDetailed(fromSnap, toSnap),
    fromSnapshot: fromSnap,
    toSnapshot: toSnap,
    questionPrompts: Object.fromEntries(live.map((q) => [q.id, q.prompt])),
  };
}

/** Restores a prior version's questions as a new version (non-destructive history). */
export async function revertToRevision(
  surveyId: string,
  workspaceId: string,
  targetVersion: number,
): Promise<number> {
  await ensureBaseline(surveyId, workspaceId);
  const [target] = await db
    .select()
    .from(surveyRevisions)
    .where(and(eq(surveyRevisions.surveyId, surveyId), eq(surveyRevisions.version, targetVersion)))
    .limit(1);
  if (!target) throw new Error("해당 버전을 찾을 수 없습니다.");
  const snap = validate(target.questionsSnapshot);
  const version = await nextVersion(surveyId);
  await writeQuestions(surveyId, snap);
  await db.insert(surveyRevisions).values({
    workspaceId,
    surveyId,
    version,
    reason: `v${targetVersion}(으)로 되돌림`,
    questionsSnapshot: snap,
  });
  await db.update(surveys).set({ updatedAt: new Date() }).where(eq(surveys.id, surveyId));
  return version;
}

// ── Persisted AI proposals: nothing is lost on partial apply / reject ───────

export type ProposalStatus = "pending" | "applied" | "partial" | "rejected";
export type ProposalDecisions = Record<string, "applied" | "skipped">;

export type ProposalListItem = {
  id: string;
  feedback: string;
  rationale: string;
  status: ProposalStatus;
  createdAt: Date;
  /** Questions the author skipped at the last action (re-openable). */
  skippedCount: number;
};

/** Persists a fresh proposal (status pending). Returns its id. */
export async function saveProposal(
  surveyId: string,
  workspaceId: string,
  feedback: string,
  rationale: string,
  proposed: RevisionQuestion[],
): Promise<string> {
  const [row] = await db
    .insert(surveyProposals)
    .values({ workspaceId, surveyId, feedback, rationale, proposedSnapshot: proposed })
    .returning({ id: surveyProposals.id });
  return row.id;
}

/** Records what happened to a proposal (applied/partial/rejected + per-quid outcomes). */
export async function markProposalOutcome(
  proposalId: string,
  workspaceId: string,
  status: ProposalStatus,
  decisions: ProposalDecisions,
): Promise<void> {
  await db
    .update(surveyProposals)
    .set({ status, decisions })
    .where(and(eq(surveyProposals.id, proposalId), eq(surveyProposals.workspaceId, workspaceId)));
}

/** Recent proposals of a survey, newest first. */
export async function listProposals(
  surveyId: string,
  workspaceId: string,
): Promise<ProposalListItem[]> {
  const rows = await db
    .select()
    .from(surveyProposals)
    .where(and(eq(surveyProposals.surveyId, surveyId), eq(surveyProposals.workspaceId, workspaceId)))
    .orderBy(desc(surveyProposals.createdAt))
    .limit(20);
  return rows.map((r) => ({
    id: r.id,
    feedback: r.feedback,
    rationale: r.rationale,
    status: r.status as ProposalStatus,
    createdAt: r.createdAt,
    skippedCount: Object.values((r.decisions ?? {}) as ProposalDecisions).filter(
      (d) => d === "skipped",
    ).length,
  }));
}

/**
 * Reopens a stored proposal against the CURRENT questions: already-applied
 * items now diff as unchanged, so only the remaining differences light up.
 */
export async function reopenProposal(
  proposalId: string,
  workspaceId: string,
): Promise<{
  surveyId: string;
  feedback: string;
  rationale: string;
  proposed: RevisionQuestion[];
  current: RevisionQuestion[];
  diff: QuestionDiff;
  questionPrompts: Record<string, string>;
} | null> {
  const [row] = await db
    .select()
    .from(surveyProposals)
    .where(and(eq(surveyProposals.id, proposalId), eq(surveyProposals.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  const current = await currentStable(row.surveyId);
  const liveIds = (
    await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.surveyId, row.surveyId))
      .orderBy(asc(questions.order))
  ).map((r) => r.id);
  const quidToLiveId = new Map(current.map((q, i) => [q.quid, liveIds[i]]));
  const proposed = materializeShowIf(row.proposedSnapshot as RevisionQuestion[], quidToLiveId);
  return {
    surveyId: row.surveyId,
    feedback: row.feedback,
    rationale: row.rationale,
    proposed,
    current,
    diff: diffQuestions(current, proposed),
    questionPrompts: Object.fromEntries(liveIds.map((id, i) => [id, current[i]?.prompt ?? ""])),
  };
}
