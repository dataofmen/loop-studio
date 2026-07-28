"use client";

import { useEffect, useState, useTransition } from "react";
import type { DisplayLogic, DisplayCondition, DisplayOp } from "@/lib/display-logic";
import { describeLogic } from "@/lib/display-logic";
import type { LintWarning } from "@/lib/logic-lint";
import { normalizeOptions, type ConfigOption } from "@/lib/question-config";
import { compileDisplayLogicAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Native <select> styled to match the shadcn Input aesthetic. */
const selectCls =
  "rounded-md border border-input bg-transparent text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type Q = { id: string; type: QuestionType; prompt: string; config: { options?: ConfigOption[] } };

const CHOICE_OPS: { v: DisplayOp; l: string }[] = [
  { v: "in", l: "다음 중 하나" },
  { v: "not_in", l: "다음 중 하나가 아님" },
  { v: "eq", l: "정확히 같음" },
  { v: "ne", l: "같지 않음" },
];
const NUM_OPS: { v: DisplayOp; l: string }[] = [
  { v: "lte", l: "이하(≤)" },
  { v: "gte", l: "이상(≥)" },
  { v: "lt", l: "미만(<)" },
  { v: "gt", l: "초과(>)" },
  { v: "eq", l: "같음(=)" },
  { v: "ne", l: "다름(≠)" },
];
const TEXT_OPS: { v: DisplayOp; l: string }[] = [
  { v: "contains", l: "포함" },
  { v: "eq", l: "같음" },
  { v: "ne", l: "다름" },
];

function kindOf(t: QuestionType): "choice" | "num" | "text" {
  if (t === "single" || t === "multi" || t === "ranking") return "choice";
  if (t === "scale" || t === "nps") return "num";
  return "text";
}
function opsFor(t: QuestionType) {
  const k = kindOf(t);
  return k === "choice" ? CHOICE_OPS : k === "num" ? NUM_OPS : TEXT_OPS;
}
function defaultValue(ref: Q, op: DisplayOp): DisplayCondition["value"] {
  const firstOpt = normalizeOptions(ref.config.options)[0]?.label;
  // in/not_in default to the first option (a non-empty, satisfiable set) rather
  // than [] — an empty in-set is a broken condition that hides the question.
  if (op === "in" || op === "not_in") return firstOpt ? [firstOpt] : [];
  if (kindOf(ref.type) === "num") return 0;
  return firstOpt ?? "";
}

// describeLogic/describeCondition now live in @/lib/display-logic (pure, shared
// by the map, the linter, and this editor); re-exported for existing importers.
export { describeLogic } from "@/lib/display-logic";

/**
 * Per-question conditional-display editor: manual condition builder plus an
 * "AI가 조건을 만들어줌" flow (describe in Korean → AI compiles → confirm).
 */
export function DisplayLogicEditor({
  surveyId,
  question,
  priorQuestions,
  warnings = [],
  onChange,
}: {
  surveyId: string;
  question: Q;
  priorQuestions: Q[];
  warnings?: LintWarning[];
  onChange: (logic: DisplayLogic | undefined, src?: string) => void;
}) {
  const logic = (question.config as { displayLogic?: DisplayLogic }).displayLogic;
  const hasLogic = !!logic && logic.conditions.length > 0;

  // "조건부 표시" mode is a UI state that does NOT auto-create/persist a condition.
  // A condition is only saved when the user explicitly adds one ("+ 조건 추가").
  const [conditionalMode, setConditionalMode] = useState(hasLogic);
  useEffect(() => {
    if (hasLogic) setConditionalMode(true);
  }, [hasLogic]);
  const conditional = conditionalMode;

  const [nl, setNl] = useState("");
  const [justApplied, setJustApplied] = useState(false);
  const [aiPending, startAi] = useTransition();
  const [aiResult, setAiResult] = useState<
    { logic: DisplayLogic; explanation: string; tests: string[] } | null
  >(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const byId = (id: string) => priorQuestions.find((q) => q.id === id);

  function setLogic(next: DisplayLogic | undefined, src?: string) {
    onChange(next && next.conditions.length > 0 ? next : undefined, src);
  }
  // Enter conditional mode WITHOUT creating/persisting a condition. The user adds
  // conditions explicitly via "+ 조건 추가".
  function enableConditional() {
    setJustApplied(false);
    setConditionalMode(true);
  }
  // Back to "always shown": clear any saved logic AND exit conditional mode.
  function toAlways() {
    setJustApplied(false);
    setConditionalMode(false);
    setLogic(undefined, "clear");
  }
  function updateCond(i: number, patch: Partial<DisplayCondition>) {
    if (!logic) return;
    setJustApplied(false);
    const conditions = logic.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c));
    setLogic({ ...logic, conditions }, "updateCond");
  }
  function addCond() {
    // Prefer a choice/numeric prior question so the seeded condition has a
    // concrete, satisfiable value (a text ref would default to an empty value).
    const first = priorQuestions.find((p) => kindOf(p.type) !== "text") ?? priorQuestions[0];
    if (!first) return;
    setJustApplied(false);
    const op = opsFor(first.type)[0].v;
    const cond = { questionId: first.id, op, value: defaultValue(first, op) };
    setLogic(logic ? { ...logic, conditions: [...logic.conditions, cond] } : { match: "all", conditions: [cond] }, "addCond");
  }
  function removeCond(i: number) {
    if (!logic) return;
    setJustApplied(false);
    setLogic({ ...logic, conditions: logic.conditions.filter((_, j) => j !== i) }, "removeCond");
  }

  function runAi() {
    setAiError(null);
    setAiResult(null);
    startAi(async () => {
      const r = await compileDisplayLogicAction(surveyId, question.id, nl);
      if (r.error) setAiError(r.error);
      else if (r.logic) setAiResult({ logic: r.logic, explanation: r.explanation ?? "", tests: r.tests ?? [] });
    });
  }

  const warningBlock = warnings.length > 0 && (
    <div className="flex flex-col gap-1">
      {warnings.map((w, i) => (
        <p
          key={i}
          className={`rounded-md border px-2 py-1 text-xs ${
            w.severity === "error"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-400"
          }`}
        >
          {w.severity === "error" ? "⛔" : "⚠️"} {w.message}
        </p>
      ))}
    </div>
  );

  if (priorQuestions.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {warningBlock}
        <p className="text-xs text-muted-foreground/70">앞선 문항이 있어야 조건부 표시를 설정할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {warningBlock}
      <div className="flex items-center gap-4 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`dl-mode-${question.id}`}
            checked={!conditional}
            onChange={toAlways}
          />{" "}
          항상 표시
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`dl-mode-${question.id}`}
            checked={conditional}
            onChange={enableConditional}
          />{" "}
          조건부 표시
        </label>
      </div>

      {conditional && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/50 p-3">
          {/* Plain-Korean summary — only once a condition actually exists. Entering
              conditional mode does NOT auto-create a condition. */}
          {logic && logic.conditions.length > 0 ? (
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-primary">현재 적용된 조건</span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={toAlways}
                  className="border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                  title="조건을 삭제하고 항상 표시로 되돌립니다"
                >
                  조건 삭제
                </Button>
              </div>
              <p className="mt-0.5 text-foreground">
                이 문항은 <b>{describeLogic(logic, priorQuestions)}</b> 일 때만 표시됩니다.
              </p>
              {justApplied && <p className="mt-1 text-emerald-600 dark:text-emerald-400">AI가 만든 조건이 적용되었습니다 ✓</p>}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              아래에서 조건을 추가하세요. 조건을 추가하기 전까지는 이 문항이 항상 표시됩니다.
            </p>
          )}
          {logic && logic.conditions.length > 1 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">다음 조건을</span>
              <select
                value={logic.match}
                onChange={(e) => setLogic({ ...logic, match: e.target.value as "all" | "any" }, "match")}
                className={cn(selectCls, "h-7 px-2 text-xs")}
              >
                <option value="all">모두 충족 (AND)</option>
                <option value="any">하나라도 충족 (OR)</option>
              </select>
              <span className="text-muted-foreground">할 때만 이 문항을 표시</span>
            </div>
          )}

          {logic?.conditions.map((c, i) => {
            const ref = byId(c.questionId) ?? priorQuestions[0];
            const kind = kindOf(ref.type);
            const isArrayOp = c.op === "in" || c.op === "not_in";
            return (
              <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                <select
                  value={c.questionId}
                  onChange={(e) => {
                    const nref = byId(e.target.value)!;
                    const op = opsFor(nref.type)[0].v;
                    updateCond(i, { questionId: e.target.value, op, value: defaultValue(nref, op) });
                  }}
                  className={cn(selectCls, "h-7 max-w-[45%] px-2 text-xs")}
                >
                  {priorQuestions.map((pq, k) => (
                    <option key={pq.id} value={pq.id}>
                      Q{k + 1}. {pq.prompt.slice(0, 20)}
                    </option>
                  ))}
                </select>
                <select
                  value={c.op}
                  onChange={(e) =>
                    updateCond(i, { op: e.target.value as DisplayOp, value: defaultValue(ref, e.target.value as DisplayOp) })
                  }
                  className={cn(selectCls, "h-7 px-2 text-xs")}
                >
                  {opsFor(ref.type).map((o) => (
                    <option key={o.v} value={o.v}>
                      {o.l}
                    </option>
                  ))}
                </select>

                {/* value control */}
                {kind === "choice" && isArrayOp ? (
                  <span className="flex flex-wrap gap-1">
                    {normalizeOptions(ref.config.options).map((o) => {
                      const opt = o.label;
                      const arr = Array.isArray(c.value) ? c.value : [];
                      const on = arr.includes(opt);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() =>
                            updateCond(i, { value: on ? arr.filter((x) => x !== opt) : [...arr, opt] })
                          }
                          className={`rounded border px-2 py-0.5 ${on ? "border-primary bg-primary/15 text-primary" : "border-border"}`}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </span>
                ) : kind === "choice" ? (
                  <select
                    value={String(c.value)}
                    onChange={(e) => updateCond(i, { value: e.target.value })}
                    className={cn(selectCls, "h-7 px-2 text-xs")}
                  >
                    {normalizeOptions(ref.config.options).map((o) => (
                      <option key={o.id} value={o.label}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : kind === "num" ? (
                  <Input
                    type="number"
                    value={Number(c.value)}
                    onChange={(e) => updateCond(i, { value: Number(e.target.value) })}
                    className="h-7 w-20 px-2 text-xs md:text-xs"
                  />
                ) : (
                  <Input
                    value={String(c.value)}
                    onChange={(e) => updateCond(i, { value: e.target.value })}
                    className="h-7 w-auto px-2 text-xs md:text-xs"
                  />
                )}

                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeCond(i)}
                  className="text-muted-foreground/70 hover:text-destructive"
                >
                  ✕
                </Button>
              </div>
            );
          })}
          <Button type="button" variant="link" onClick={addCond} className="h-auto self-start p-0 text-xs">
            + 조건 추가
          </Button>
        </div>
      )}

      {/* AI: describe in natural language → compile → confirm */}
      <div className="flex flex-col gap-2 rounded-lg border border-primary/15 bg-primary/5 p-3">
        <span className="text-xs font-medium text-primary">AI로 조건 만들기</span>
        <Textarea
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          rows={2}
          placeholder="예: 만족도 문항에서 '불만족'이나 '매우 불만족'을 고른 사람에게만 이 문항을 보여줘"
          className="min-h-0 px-2 py-1 text-xs md:text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={runAi}
          disabled={aiPending || nl.trim().length < 5}
          className="self-start"
        >
          {aiPending ? "AI 생성 중…" : "AI로 조건 생성"}
        </Button>
        {aiError && <p className="text-xs text-destructive">{aiError}</p>}
        {aiResult && (
          <div className="rounded border border-primary/20 bg-card p-2 text-xs">
            <p className="font-medium text-foreground">{aiResult.explanation}</p>
            {aiResult.tests.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {aiResult.tests.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="xs"
                onClick={() => {
                  setLogic(aiResult.logic, "ai");
                  setAiResult(null);
                  setNl("");
                  setJustApplied(true);
                }}
              >
                적용
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setAiResult(null)}
              >
                취소
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
