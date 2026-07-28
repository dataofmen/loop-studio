"use client";

import { useMemo } from "react";
import { describeLogic, hasDisplayLogic, type DisplayLogic } from "@/lib/display-logic";
import type { LintWarning } from "@/lib/logic-lint";
import type { ConfigOption } from "@/lib/question-config";
import { scrollToQuestion } from "./scroll-to-question";

type QuestionType = "single" | "multi" | "scale" | "open" | "ranking" | "matrix" | "nps";
type Q = {
  id: string;
  type: QuestionType;
  order: number;
  prompt: string;
  config: { options?: ConfigOption[]; displayLogic?: DisplayLogic };
};

// Layout constants — questions are linearly ordered, so nodes stack vertically
// and conditional dependencies are drawn as arcs bowing into a right-hand gutter.
const NH = 48; // node height
const GAP = 22; // vertical gap between nodes
const NW = 300; // node width
const GUTTER = 130; // right area for dependency arcs
const STEP = NH + GAP;

/**
 * SVG branching diagram of the survey's conditional logic. Each question is a
 * node; an arrow ref→target means "the answer to `ref` gates whether `target`
 * is shown". Read-only; clicking a node scrolls to that question in the editor.
 */
export function LogicFlowDiagram({
  questions,
  warnings = [],
}: {
  questions: Q[];
  warnings?: LintWarning[];
}) {
  const warnByQ = useMemo(() => {
    const m: Record<string, "error" | "warning" | undefined> = {};
    for (const w of warnings) {
      if (m[w.questionId] !== "error") m[w.questionId] = w.severity;
    }
    return m;
  }, [warnings]);

  const { nodes, edges, height } = useMemo(() => {
    const idxById = new Map(questions.map((q, i) => [q.id, i]));
    const nodes = questions.map((q, i) => ({
      id: q.id,
      num: i + 1,
      prompt: q.prompt,
      conditional: hasDisplayLogic(q.config.displayLogic),
      severity: warnByQ[q.id],
      y: i * STEP,
    }));
    const edges: { from: number; to: number; label: string; broken: boolean }[] = [];
    questions.forEach((q, i) => {
      const logic = q.config.displayLogic;
      if (!hasDisplayLogic(logic)) return;
      const refIds = Array.from(new Set(logic!.conditions.map((c) => c.questionId)));
      for (const rid of refIds) {
        const from = idxById.get(rid);
        const label = describeLogic(
          { match: logic!.match, conditions: logic!.conditions.filter((c) => c.questionId === rid) },
          questions.slice(0, i),
        );
        if (from === undefined) edges.push({ from: -1, to: i, label, broken: true });
        else edges.push({ from, to: i, label, broken: false });
      }
    });
    return { nodes, edges, height: Math.max(STEP * questions.length, STEP) };
  }, [questions, warnByQ]);

  if (questions.length === 0) {
    return <p className="text-xs text-muted-foreground/70">문항이 없습니다.</p>;
  }

  const cx = NW; // arcs start/end at the node's right edge
  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width: NW + GUTTER, height }}>
        {/* arcs */}
        <svg
          className="pointer-events-none absolute inset-0"
          width={NW + GUTTER}
          height={height}
          aria-hidden
        >
          <defs>
            <marker id="lf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="fill-primary" />
            </marker>
            <marker id="lf-arrow-broken" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="fill-destructive" />
            </marker>
          </defs>
          {edges.map((e, k) => {
            const yTo = e.to * STEP + NH / 2;
            const span = e.from >= 0 ? Math.abs(e.to - e.from) : 1;
            const depth = 20 + Math.min(span - 1, 5) * 16 + (k % 3) * 6;
            if (e.broken) {
              // No source node — draw a short stub with a rose arrowhead into the target.
              const x0 = cx + depth;
              return (
                <path
                  key={k}
                  d={`M ${x0} ${yTo} L ${cx + 4} ${yTo}`}
                  fill="none"
                  className="stroke-destructive"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  markerEnd="url(#lf-arrow-broken)"
                />
              );
            }
            const yFrom = e.from * STEP + NH / 2;
            const x = cx + depth;
            return (
              <path
                key={k}
                d={`M ${cx} ${yFrom} C ${x} ${yFrom}, ${x} ${yTo}, ${cx + 4} ${yTo}`}
                fill="none"
                className="stroke-primary/50"
                strokeWidth={1.5}
                markerEnd="url(#lf-arrow)"
              >
                <title>{e.label}</title>
              </path>
            );
          })}
        </svg>

        {/* nodes */}
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => scrollToQuestion(n.id)}
            title="문항으로 이동"
            className={`absolute flex items-center gap-2 rounded-lg border-2 bg-card px-3 text-left text-xs transition hover:shadow-sm ${
              n.severity === "error"
                ? "border-destructive/40"
                : n.severity === "warning"
                  ? "border-amber-300 dark:border-amber-400/50"
                  : n.conditional
                    ? "border-primary/40"
                    : "border-border"
            }`}
            style={{ top: n.y, left: 0, width: NW, height: NH }}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                n.conditional ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {n.num}
            </span>
            <span className="flex-1 truncate text-foreground">{n.prompt || "(제목 없음)"}</span>
            {n.conditional && <span className="shrink-0 text-[10px] text-primary">조건부</span>}
            {n.severity && <span className="shrink-0">{n.severity === "error" ? "⛔" : "⚠️"}</span>}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/70">
        화살표: 참조 문항의 응답이 대상 문항의 표시를 결정합니다. 화살표에 마우스를 올리면 조건을 볼 수 있어요.
      </p>
    </div>
  );
}
