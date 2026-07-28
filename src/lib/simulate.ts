import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { surveys, questions, personas, responses, simulationJobs } from "@/db/schema";
import { computeDistributions } from "@/lib/quality";
import { runAgentJson } from "@/lib/agent-cli";
import { getAgentSettings, type AgentSettings } from "@/lib/settings";
import { questionVisible, hasDisplayLogic, type DisplayLogic } from "@/lib/display-logic";
import { optionLabels, type ConfigOption } from "@/lib/question-config";
import { carriedOptionLabels, clampCarriedAnswer, normalizeOptionsFrom } from "@/lib/carry-forward";
import { coerceSimAnswer, emptyFor, type QuestionType } from "@/lib/sim-answers";
import { otherOption, sanitizeOtherTexts } from "@/lib/other-text";
import { clampNoneExclusive, noneOption } from "@/lib/none-exclusive";
import { currentSurveyVersion } from "@/lib/revisions";
import { normalizeOcean, oceanPromptLine } from "@/lib/ocean";

type QConfig = {
  options?: ConfigOption[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
  rows?: string[];
  columns?: string[];
  limit?: number;
  displayLogic?: DisplayLogic;
  optionsFrom?: unknown;
};
type QRow = { id: string; type: QuestionType; order: number; prompt: string; config: QConfig };

/** Builds the survey description + required answer shape, using stable q1..qN keys. */
function buildQuestionsBlock(qs: QRow[]): { text: string; keyToId: Record<string, string> } {
  const keyToId: Record<string, string> = {};
  const idToKey = new Map(qs.map((x, xi) => [x.id, `q${xi + 1}`]));
  const carriedNote = (q: QRow): string => {
    const from = normalizeOptionsFrom(q.config.optionsFrom);
    if (!from) return "";
    const srcKey = idToKey.get(from.questionId);
    return srcKey ? ` (반드시 ${srcKey}에서 본인이 고른 보기 중에서만 선택)` : "";
  };
  const lines = qs.map((q, i) => {
    const key = `q${i + 1}`;
    keyToId[key] = q.id;
    // US-002: when a question has a special "other" option (with text input
    // on), ask for the concrete content in a separate `others` map (answers
    // keep the label). Applies to single/multi/ranking.
    const otherNote = (q: QRow): string => {
      const o = otherOption(q.config.options);
      return o && !o.noText ? ` ("${o.label}"를 고르면 others.${key}에 그 내용을 짧은 구절로)` : "";
    };
    if (q.type === "single")
      return `${key} (단일 선택, 보기 중 하나의 문자열${carriedNote(q)}${otherNote(q)}): ${q.prompt} 보기=${JSON.stringify(optionLabels(q.config.options))}`;
    if (q.type === "multi")
      return `${key} (복수 선택, 보기들의 배열${carriedNote(q)}${otherNote(q)}): ${q.prompt} 보기=${JSON.stringify(optionLabels(q.config.options))}`;
    if (q.type === "scale") {
      const s = q.config.scale ?? { min: 1, max: 5 };
      return `${key} (척도 정수 ${s.min}~${s.max}): ${q.prompt}`;
    }
    if (q.type === "nps")
      return `${key} (NPS 정수 0~10, 추천 의향): ${q.prompt}`;
    if (q.type === "ranking") {
      const opts = optionLabels(q.config.options);
      const lim = q.config.limit && q.config.limit > 0 ? Math.min(q.config.limit, opts.length) : opts.length;
      return lim < opts.length
        ? `${key} (순위, 선호 순서대로 상위 ${lim}개만 고른 배열, 정확히 ${lim}개${otherNote(q)}): ${q.prompt} 보기=${JSON.stringify(opts)}`
        : `${key} (순위, 보기 전체를 선호 순서대로 정렬한 배열${otherNote(q)}): ${q.prompt} 보기=${JSON.stringify(opts)}`;
    }
    if (q.type === "matrix")
      return `${key} (행렬, 각 행마다 열 중 하나를 고른 객체 {"행":"열"}): ${q.prompt} 행=${JSON.stringify(q.config.rows ?? [])} 열=${JSON.stringify(q.config.columns ?? [])}`;
    return `${key} (주관식, 한 문장 이내로 매우 짧게): ${q.prompt}`;
  });
  return { text: lines.join("\n"), keyToId };
}

type PersonaRow = { id: string; profile: string; attributes?: unknown };

const SYSTEM_BASE = "당신은 설문 응답자 역할을 정확히 연기합니다.";

/**
 * Condensed persona description for the prompt: the core profile lines plus
 * any distinctive Big-Five disposition. Trimming keeps a batch prompt small
 * enough that the model's attention stays on the questions.
 */
function personaBlock(persona: PersonaRow): string {
  let condensed = persona.profile.split("\n").slice(0, 3).join(" / ");
  const ocean = normalizeOcean((persona.attributes as { ocean?: unknown } | undefined | null)?.ocean);
  if (ocean) {
    const line = oceanPromptLine(ocean);
    if (line) condensed += ` / ${line}`;
  }
  return condensed;
}

/**
 * Turns one persona's raw `{q1: …}` answers into stored answers + other-texts,
 * applying the same integrity rules a real submission goes through.
 */
function shapeAnswers(
  raw: Record<string, unknown>,
  rawOthers: Record<string, unknown>,
  keyToId: Record<string, string>,
  qByKey: Record<string, QRow>,
): { answers: Record<string, unknown>; otherTexts: Record<string, string> } {
  const answers: Record<string, unknown> = {};
  for (const [key, qid] of Object.entries(keyToId)) {
    // coerceSimAnswer keeps open answers scalar — simulation omits probing,
    // so synthetic responses never store `{answer, probes}`.
    answers[qid] = coerceSimAnswer(qByKey[key].type, raw[key]);
  }
  // Respect conditional display: a question whose displayLogic isn't satisfied by
  // this persona's answers was never "shown", so blank it (matching real skips).
  // Evaluated against the full answer set (model answered everything up front).
  const answerMap = answers as Record<string, string | number | string[] | Record<string, string>>;
  for (const key of Object.keys(keyToId)) {
    const qrow = qByKey[key];
    if (hasDisplayLogic(qrow.config.displayLogic) && !questionVisible(qrow.config.displayLogic, answerMap)) {
      answers[qrow.id] = emptyFor(qrow.type);
    }
  }
  // Carry-forward integrity: a persona's answer must stay within its OWN
  // source selections; empty source selection blanks the dependent question.
  const rowsById = new Map(Object.values(qByKey).map((r) => [r.id, r]));
  for (const qrow of Object.values(qByKey)) {
    const from = normalizeOptionsFrom(qrow.config.optionsFrom);
    if (!from) continue;
    const src = rowsById.get(from.questionId);
    const carried = src ? carriedOptionLabels(src.config.options, answers[src.id]) : [];
    answers[qrow.id] =
      carried.length === 0 ? emptyFor(qrow.type) : clampCarriedAnswer(qrow.type, answers[qrow.id], carried);
  }
  // "없음" exclusivity clamp on synthetic multi answers. Rule (same as the
  // server re-sanitization): none + other picks → drop the none label.
  for (const qrow of Object.values(qByKey)) {
    if (qrow.type !== "multi") continue;
    const none = noneOption(qrow.config.options);
    if (!none) continue;
    const v = answers[qrow.id];
    if (Array.isArray(v)) answers[qrow.id] = clampNoneExclusive(v.map((x) => String(x)), none.label);
  }
  // Synthetic "other" texts, re-keyed q1..qN → question id, then run through
  // the same sanitizer as real submissions — a text survives only when the
  // FINAL answer (after display-logic blanking / carry clamps) still selects
  // the "other" option. Missing texts are graceful (label only).
  const othersByQid: Record<string, unknown> = {};
  for (const [key, qid] of Object.entries(keyToId)) {
    if (rawOthers[key] != null) othersByQid[qid] = rawOthers[key];
  }
  const otherTexts = sanitizeOtherTexts(
    othersByQid,
    Object.values(qByKey).map((r) => ({ id: r.id, type: r.type, config: { options: r.config.options } })),
    answers,
  );
  return { answers, otherTexts };
}

export type BatchResult = {
  persona: PersonaRow;
  answers: Record<string, unknown>;
  otherTexts: Record<string, string>;
};

/**
 * Answers the survey as every persona in `batch`, in ONE CLI call.
 *
 * Batching exists because a CLI round trip costs seconds of process startup
 * regardless of prompt size, so one persona per call makes a 1,000-persona run
 * impractical. The trade-off is that personas sharing a context can drift
 * toward each other; the prompt pushes back explicitly, and batchSize=1
 * remains available when independence matters more than speed.
 *
 * Personas the model skips or mangles are simply absent from the result — the
 * caller counts them as failures rather than substituting made-up answers.
 */
async function simulateBatch(
  questionsText: string,
  keyToId: Record<string, string>,
  qByKey: Record<string, QRow>,
  batch: PersonaRow[],
  settings: AgentSettings,
): Promise<BatchResult[]> {
  // Mention the `others` map only when some question actually has an "other"
  // option with text input on — keeps the prompt lean for the common case.
  const anyOther = Object.values(qByKey).some((r) => {
    const o = otherOption(r.config.options);
    return o != null && !o.noText;
  });
  const respondentShape = anyOther
    ? `{"i": <번호>, "answers": {"q1": <답>, ...}, "others": {"qN": "기타를 고른 문항의 구체적 내용"}}`
    : `{"i": <번호>, "answers": {"q1": <답>, ...}}`;

  const peopleBlock = batch.map((p, i) => `${i + 1}. ${personaBlock(p)}`).join("\n");

  const prompt = `${SYSTEM_BASE}

아래 ${batch.length}명 각각의 입장에서 같은 설문에 답하세요.

[응답자 목록]
${peopleBlock}

[문항]
${questionsText}

규칙:
- 각 사람의 가치관·생활환경에서 벗어나지 말 것.
- 사람마다 독립적으로 판단할 것 — 앞사람의 답을 따라가지 말고, 실제 표본처럼 서로 다르게 답할 것.
- 주관식은 한 문장 이내, 그 사람의 말투로.
- ${batch.length}명 전원에 대해 빠짐없이 답할 것. i는 위 목록의 번호.

다른 텍스트 없이 아래 JSON만 반환하세요:
{"respondents": [${respondentShape}, ...]}`;

  const parsed = await runAgentJson<{
    respondents?: { i?: unknown; answers?: unknown; others?: unknown }[];
  }>(prompt, {
    cli: settings.cli,
    model: settings.model,
    binPath: settings.cliPath,
    // A batch is a bigger ask than a single persona; scale the patience with it.
    timeoutMs: 90_000 + batch.length * 20_000,
  });

  const out: BatchResult[] = [];
  const seen = new Set<number>();
  for (const r of parsed.respondents ?? []) {
    const idx = Number(r.i) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length || seen.has(idx)) continue;
    if (r.answers == null || typeof r.answers !== "object" || Array.isArray(r.answers)) continue;
    seen.add(idx);
    const rawOthers =
      r.others && typeof r.others === "object" && !Array.isArray(r.others)
        ? (r.others as Record<string, unknown>)
        : {};
    const { answers, otherTexts } = shapeAnswers(
      r.answers as Record<string, unknown>,
      rawOthers,
      keyToId,
      qByKey,
    );
    out.push({ persona: batch[idx], answers, otherTexts });
  }
  return out;
}

/**
 * Runs every persona of a survey through the agent CLI in batches, with
 * bounded concurrency, updating the job row as it goes.
 */
export async function runSimulation(jobId: string, surveyId: string): Promise<void> {
  try {
    const qs = (await db
      .select()
      .from(questions)
      .where(eq(questions.surveyId, surveyId))
      .orderBy(asc(questions.order))) as unknown as QRow[];
    const { text: questionsText, keyToId } = buildQuestionsBlock(qs);
    const qByKey: Record<string, QRow> = {};
    qs.forEach((q, i) => (qByKey[`q${i + 1}`] = q));

    const [survey] = await db.select().from(surveys).where(eq(surveys.id, surveyId));
    const settings = await getAgentSettings();

    const ps = await db
      .select({ id: personas.id, profile: personas.profile, attributes: personas.attributes })
      .from(personas)
      .where(eq(personas.surveyId, surveyId));

    // Provenance for synthetic rows: survey version/content snapshot at run
    // start + the generating job (joins to the engine used).
    const surveyVersion = await currentSurveyVersion(surveyId);
    const surveyContentAt = survey.updatedAt;

    // Fresh run: clear prior synthetic responses for this survey.
    await db
      .delete(responses)
      .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)));

    // Split personas into CLI batches. Each batch is one call; workers pull
    // batches off a shared cursor so a slow batch doesn't stall the others.
    const batches: PersonaRow[][] = [];
    for (let at = 0; at < ps.length; at += settings.batchSize) {
      batches.push(ps.slice(at, at + settings.batchSize));
    }

    let completed = 0;
    let succeeded = 0;
    let lastError = "";
    let aborted = false;
    // Systemic-failure brake: a sporadic bad batch is skipped gracefully, but
    // when NOTHING has succeeded after this many batches the CLI itself is
    // broken (not installed, not signed in, rate-limited) — burning through
    // the remaining hundreds of calls would only hide the error.
    const FAIL_FAST_BATCHES = 3;
    let attemptedBatches = 0;
    let cursor = 0;

    async function worker() {
      while (!aborted && cursor < batches.length) {
        const batch = batches[cursor++];
        try {
          const results = await simulateBatch(questionsText, keyToId, qByKey, batch, settings);
          if (results.length > 0) {
            await db.insert(responses).values(
              results.map((r) => ({
                surveyId,
                personaId: r.persona.id,
                isSynthetic: true,
                answers: r.answers,
                otherTexts: r.otherTexts,
                surveyVersion,
                surveyContentAt,
                simulationJobId: jobId,
              })),
            );
          }
          succeeded += results.length;
          // Personas the model dropped from the batch are failures too, but
          // there is no per-persona error to report.
          if (results.length < batch.length && !lastError) {
            lastError = "일부 응답자가 모델 응답에서 누락되었습니다.";
          }
        } catch (e) {
          // Skip a failed batch; continue the run — but remember why.
          lastError = e instanceof Error ? e.message : String(e);
        }
        completed += batch.length;
        attemptedBatches++;
        if (succeeded === 0 && attemptedBatches >= FAIL_FAST_BATCHES) aborted = true;
        await db
          .update(simulationJobs)
          .set({ completed, updatedAt: new Date() })
          .where(eq(simulationJobs.id, jobId));
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(settings.concurrency, batches.length || 1) }, worker),
    );

    if (aborted) {
      throw new Error(
        `AI 도구 오류로 조기 중단 — 처음 ${completed}건이 모두 실패했습니다. 마지막 오류: ${lastError}`,
      );
    }

    // Snapshot the aggregated distributions so this run stays reviewable later
    // even after a future run clears the raw synthetic responses.
    const resultSummary = await computeDistributions(surveyId);
    const skipped = completed - succeeded;
    await db
      .update(simulationJobs)
      .set({
        status: "completed",
        completed,
        resultSummary,
        // Partial failures complete the run but must stay visible — the
        // 1000-run/2-response incident looked like a clean "1000/1000 ✓".
        error: skipped > 0 ? `${skipped}/${completed}명 실패 — 마지막 오류: ${lastError}` : null,
        updatedAt: new Date(),
      })
      .where(eq(simulationJobs.id, jobId));
    // draft/reviewed → simulated. No updatedAt bump: simulation doesn't modify
    // the survey definition, and updatedAt drives the review-gate stale check.
    await db
      .update(surveys)
      .set({ status: "simulated" })
      .where(and(eq(surveys.id, surveyId), ne(surveys.status, "simulated")));
  } catch (e) {
    await db
      .update(simulationJobs)
      .set({ status: "failed", error: e instanceof Error ? e.message : "unknown", updatedAt: new Date() })
      .where(eq(simulationJobs.id, jobId));
  }
}
