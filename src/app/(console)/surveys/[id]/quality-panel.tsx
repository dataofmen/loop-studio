"use client";

import { callAction } from "@/lib/call-action";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  analyzeQualityAction,
  applyFixAction,
  type QualityResult,
} from "./quality-actions";
import type { Distribution, Warning } from "@/lib/quality";

const SEVERITY: Record<string, string> = {
  high: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  low: "bg-muted text-muted-foreground",
};

function DistBars({ d }: { d: Distribution }) {
  if (d.type === "open") {
    return <p className="text-xs text-muted-foreground">주관식 — 응답 {d.answered}건</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {d.counts.map((c) => (
        <div key={c.label} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 truncate text-muted-foreground" title={c.label}>
            {c.label}
          </span>
          <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary" style={{ width: `${c.pct}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right text-muted-foreground">{c.pct}%</span>
        </div>
      ))}
      {d.mean != null && <p className="text-xs text-muted-foreground/70">평균 {d.mean}</p>}
      {d.npsScore != null && (
        <p className="text-xs font-medium text-muted-foreground">NPS {d.npsScore > 0 ? "+" : ""}{d.npsScore}</p>
      )}
      {d.avgRanks && d.avgRanks.length > 0 && (
        <p className="text-xs text-muted-foreground/70">
          평균 순위: {d.avgRanks.map((r) => `${r.label} ${r.avg}`).join(" · ")}
        </p>
      )}
      {d.matrix && d.matrix.length > 0 && (
        <div className="mt-1 flex flex-col gap-1 border-l-2 border-border pl-2">
          {d.matrix.map((row) => (
            <p key={row.row} className="text-xs text-muted-foreground">
              <span className="font-medium">{row.row}</span>:{" "}
              {row.counts.filter((c) => c.count > 0).map((c) => `${c.label} ${c.pct}%`).join(", ")}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function QualityPanel({ surveyId }: { surveyId: string }) {
  const [result, setResult] = useState<QualityResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  function onAnalyze() {
    startTransition(async () => {
      const r = await callAction(() => analyzeQualityAction(surveyId));
      setResult(r);
      setApplied({});
    });
  }

  function onApply(w: Warning) {
    startTransition(async () => {
      const r = await callAction(() => applyFixAction(surveyId, w.questionId, w.suggestion));
      if (r.ok) setApplied((a) => ({ ...a, [w.questionId]: true }));
    });
  }

  const warnByQ = new Map((result?.warnings ?? []).map((w) => [w.questionId, w]));

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">문항 품질 리포트</h2>
        <Button variant="outline" onClick={onAnalyze} disabled={pending}>
          {pending ? "분석 중…" : result ? "다시 분석" : "AI 품질 분석"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        합성 응답 분포에서 편향·쏠림·모호성을 찾아 발송 전에 경고합니다.
      </p>

      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}

      {result?.distributions && (
        <ol className="flex flex-col gap-4">
          {result.distributions.map((d, i) => {
            const w = warnByQ.get(d.questionId);
            return (
              <li key={d.questionId} className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">
                  {i + 1}. {d.prompt}{" "}
                  <span className="text-xs font-normal text-muted-foreground/70">(n={d.n})</span>
                </p>
                <DistBars d={d} />
                {w && (
                  <div className="mt-3 rounded-md bg-muted/50 p-2">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge variant="secondary" className={SEVERITY[w.severity]}>
                        {w.severity}
                      </Badge>
                      <span className="text-sm">{w.message}</span>
                    </div>
                    {w.suggestion.action !== "none" && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {w.suggestion.action === "rewrite_prompt"
                            ? `제안 문구: ${w.suggestion.newPrompt}`
                            : `제안 보기: ${w.suggestion.newOptions.join(", ")}`}
                        </span>
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => onApply(w)}
                          disabled={pending || applied[d.questionId]}
                          className="shrink-0 font-normal"
                        >
                          {applied[d.questionId] ? "적용됨 ✓" : "수정 적용"}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
