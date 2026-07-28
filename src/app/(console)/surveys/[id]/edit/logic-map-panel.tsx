"use client";

import { useMemo, useState } from "react";
import { describeLogic, hasDisplayLogic } from "@/lib/display-logic";
import type { DisplayLogic } from "@/lib/display-logic";
import type { LintWarning } from "@/lib/logic-lint";
import type { ConfigOption } from "@/lib/question-config";
import { questionCode } from "@/lib/question-code";
import { scrollToQuestion } from "./scroll-to-question";
import { LogicFlowDiagram } from "./logic-flow-diagram";
import { buildExcalidrawScene } from "@/lib/excalidraw-export";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type Q = {
  id: string;
  // Permanent quid (US-001); source of the stable display code (US-004).
  quid: string;
  type: QuestionType;
  order: number;
  prompt: string;
  config: { options?: ConfigOption[]; displayLogic?: DisplayLogic };
};

/**
 * Read-only whole-survey conditional-flow map, derived purely from the editor's
 * local `questions` state (no server round-trip) so it stays live as the author
 * edits. Editing stays in the per-question DisplayLogicEditor.
 */
export function LogicMapPanel({
  questions,
  warnings = [],
}: {
  questions: Q[];
  warnings?: LintWarning[];
}) {
  const warningsByQ = useMemo(() => {
    const map: Record<string, LintWarning[]> = {};
    for (const w of warnings) (map[w.questionId] ??= []).push(w);
    return map;
  }, [warnings]);

  const rows = useMemo(() => {
    return questions.map((q, i) => {
      const logic = q.config.displayLogic;
      const conditional = hasDisplayLogic(logic);
      const prior = questions.slice(0, i);
      // Distinct referenced questions → their 1-based position (null = deleted).
      const refs =
        conditional && logic
          ? Array.from(new Set(logic.conditions.map((c) => c.questionId))).map((qid) => {
              const idx = questions.findIndex((x) => x.id === qid);
              return {
                id: qid,
                num: idx >= 0 ? idx + 1 : null,
                code: idx >= 0 ? questionCode(questions[idx].quid) : null,
              };
            })
          : [];
      return {
        id: q.id,
        num: i + 1,
        code: questionCode(q.quid),
        prompt: q.prompt,
        conditional,
        description: conditional && logic ? describeLogic(logic, prior) : "",
        refs,
        warnings: warningsByQ[q.id] ?? [],
      };
    });
  }, [questions, warningsByQ]);

  const conditionalCount = rows.filter((r) => r.conditional).length;
  const [view, setView] = useState<"list" | "diagram">("list");

  function exportExcalidraw() {
    const scene = buildExcalidrawScene(questions);
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "survey-logic.excalidraw";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <details className="rounded-xl border bg-card text-card-foreground shadow-sm" open>
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-foreground">
        로직 맵 — 조건부 문항 흐름{" "}
        <span className="text-muted-foreground/70">
          ({conditionalCount > 0 ? `조건부 ${conditionalCount}개` : "조건부 없음"})
        </span>
      </summary>
      <div className="border-t px-4 py-3">
        {/* view toggle + export */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setView("list")}
              className={`px-2.5 py-1 ${view === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
            >
              리스트
            </button>
            <button
              type="button"
              onClick={() => setView("diagram")}
              className={`border-l px-2.5 py-1 ${view === "diagram" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
            >
              다이어그램
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={exportExcalidraw}
            className="font-normal text-muted-foreground"
            title="분기 구조를 Excalidraw 파일(.excalidraw)로 내려받아 편집"
          >
            ⬇ Excalidraw로 내보내기
          </Button>
        </div>

        {conditionalCount === 0 && (
          <p className="mb-3 text-xs text-muted-foreground/70">
            조건부 문항이 없습니다 — 모든 문항이 항상 표시됩니다. 각 문항의 &ldquo;표시 조건&rdquo;에서
            특정 응답일 때만 노출되도록 설정할 수 있습니다.
          </p>
        )}

        {view === "diagram" ? (
          <LogicFlowDiagram questions={questions} warnings={warnings} />
        ) : (
        <ol className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => scrollToQuestion(r.id)}
                  className={cn(
                    "min-w-0 text-left text-sm hover:underline",
                    r.conditional ? "font-medium text-foreground" : "font-normal text-muted-foreground/70",
                  )}
                  title="문항으로 이동"
                >
                  <span className="mr-1 font-mono text-xs text-muted-foreground/70">{r.code}</span>
                  Q{r.num}. {r.prompt || "(제목 없음)"}
                </button>
                {r.conditional ? (
                  <Badge variant="secondary" className="bg-primary/10 text-primary">
                    조건부
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground/50">항상 표시</span>
                )}
                {r.refs.map((ref) => (
                  <Button
                    key={ref.id}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => ref.num !== null && scrollToQuestion(ref.id)}
                    className={cn(
                      "h-5 px-1.5 font-normal",
                      ref.num !== null
                        ? "border-primary/30 text-primary hover:bg-primary/5 hover:text-primary"
                        : "border-destructive/30 text-destructive hover:text-destructive",
                    )}
                    title={ref.num !== null ? `참조 문항으로 이동 (${ref.code})` : "참조 문항이 삭제됨"}
                  >
                    ← {ref.num !== null ? `Q${ref.num} ${ref.code}` : "삭제된 문항"}
                  </Button>
                ))}
              </div>
              {r.conditional && (
                <p className="pl-3 text-xs text-muted-foreground">{r.description} 일 때만 표시</p>
              )}
              {r.warnings.map((w, wi) => (
                <p
                  key={wi}
                  className={`pl-3 text-xs ${
                    w.severity === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {w.severity === "error" ? "⛔" : "⚠️"} {w.message}
                </p>
              ))}
            </li>
          ))}
        </ol>
        )}
      </div>
    </details>
  );
}
