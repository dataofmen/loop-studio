"use client";

import { callAction } from "@/lib/call-action";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateInsightsAction, type InsightResult } from "./insight-actions";

export function InsightPanel({ surveyId }: { surveyId: string }) {
  const [result, setResult] = useState<InsightResult | null>(null);
  const [pending, startTransition] = useTransition();

  function onGenerate() {
    startTransition(async () => {
      setResult(await callAction(() => generateInsightsAction(surveyId)));
    });
  }

  const data = result?.data;

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">AI 인사이트 요약</h2>
        <Button variant="outline" size="sm" onClick={onGenerate} disabled={pending}>
          {pending ? "분석 중…" : data ? "다시 생성" : "AI 인사이트 생성"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        시뮬레이션 응답 전체를 분석해 핵심 발견·권장 액션을 도출하고, 주관식 응답을 주제별로 묶습니다.
      </p>

      {result?.error && <p className="text-sm text-destructive">{result.error}</p>}

      {data && data.insights.length === 0 && data.themes.length === 0 && (
        <p className="text-sm text-muted-foreground">분석할 응답이 충분하지 않습니다.</p>
      )}

      {data && data.insights.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold">핵심 발견 &amp; 권장 액션</h3>
          <ol className="flex flex-col gap-3">
            {data.insights.map((it, i) => (
              <li key={i} className="rounded-lg border p-3">
                <p className="text-sm font-medium">
                  {i + 1}. {it.finding}
                </p>
                {it.evidence && (
                  <p className="mt-1 text-xs text-muted-foreground">근거: {it.evidence}</p>
                )}
                {it.action && (
                  <p className="mt-1 text-sm text-primary">→ {it.action}</p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {data && data.themes.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">주관식 응답 주제 클러스터</h3>
          <div className="flex flex-col gap-3">
            {data.themes.map((t, i) => (
              <div key={i} className="rounded-lg border p-3">
                <p className="mb-1 text-sm font-medium">
                  {t.theme}{" "}
                  <span className="text-xs font-normal text-muted-foreground/70">({t.count}건)</span>
                </p>
                {t.quotes.length > 0 && (
                  <ul className="ml-4 list-disc text-sm text-muted-foreground">
                    {t.quotes.map((q, j) => (
                      <li key={j}>{q}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
