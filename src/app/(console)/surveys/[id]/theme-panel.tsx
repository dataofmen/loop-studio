"use client";

import { callAction } from "@/lib/call-action";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { generateThemesAction } from "./theme-actions";
import type { ThemeQuestionView, OpenTextTheme } from "@/lib/themes";

function ThemeCard({ theme }: { theme: OpenTextTheme }) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{theme.name}</p>
        <span className="shrink-0 text-xs text-muted-foreground">응답 {theme.evidence.length}건</span>
      </div>
      {theme.summary && <p className="mt-1 text-sm text-muted-foreground">{theme.summary}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-primary">
          근거 응답 보기 ({theme.evidence.length})
        </summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {theme.evidence.map((e) => (
            <li key={e.responseId} className="rounded-md bg-muted/40 px-2.5 py-1.5 text-sm">
              <p className="break-words">{e.text}</p>
              {e.probes.map((p, i) => (
                <p key={i} className="mt-0.5 text-xs text-muted-foreground">
                  ↳ {p.q} — {p.a}
                </p>
              ))}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ThemePanel({
  surveyId,
  initial,
}: {
  surveyId: string;
  initial: ThemeQuestionView[];
}) {
  const [views, setViews] = useState<ThemeQuestionView[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function generate(questionId: string) {
    setError(null);
    setPendingQ(questionId);
    startTransition(async () => {
      const res = await callAction(() => generateThemesAction(surveyId, questionId));
      if (res.error) setError(res.error);
      if (res.data) setViews(res.data);
      setPendingQ(null);
    });
  }

  if (views.length === 0) return null;

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-2 text-lg font-semibold">주관식 테마 분석</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        시뮬레이션 주관식 응답을 AI가 주제별로 묶습니다. 모든 테마는 근거 응답으로 역추적할 수 있습니다.
      </p>

      {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

      <div className="flex flex-col gap-4">
        {views.map((v) => (
          <div key={v.questionId}>
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{v.prompt}</p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={pending || v.answerCount < 3}
                onClick={() => generate(v.questionId)}
              >
                {pendingQ === v.questionId ? "분석 중…" : v.analysis ? "다시 생성" : "테마 생성"}
              </Button>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              주관식 응답 {v.answerCount}건
              {v.answerCount < 3 && " — 테마 분석에는 최소 3건이 필요합니다"}
              {v.analysis?.stale && (
                <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  응답 수 변동 — 다시 생성 권장
                </span>
              )}
              {v.analysis?.sampled && " · 표본 추출됨(200건 초과)"}
            </p>
            {v.analysis && v.analysis.themes.length > 0 && (
              <ul className="flex flex-col gap-2">
                {v.analysis.themes.map((t, i) => (
                  <ThemeCard key={i} theme={t} />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
