"use client";

import { ExportMenu } from "./export-menu";
import { FallbackBars } from "./fallback-bars";
import { FlintChart } from "./flint-chart";
import {
  distributionToBarSpec,
  likertToStackedSpec,
  matrixToStackedSpec,
  npsToStackedSpec,
  rankingToStackedSpec,
  topBoxSummary,
  withReversedColorRamp,
} from "@/lib/charts/flint-specs";
import type { ChartAssemblyInput } from "flint-chart/core";
import type { ResponseAnalysis } from "@/lib/analysis";
import type { Distribution } from "@/lib/quality";

/**
 * Survey-metric chart per question type (tasks/research-survey-viz.md):
 * response-rate bars, Likert 100% stack, NPS segments, rank composition,
 * per-row matrix stacks. null → keep the CSS fallback bars.
 */
function specFor(d: Distribution): ChartAssemblyInput | null {
  switch (d.type) {
    case "single":
    case "multi":
      return distributionToBarSpec(d);
    case "scale":
      return likertToStackedSpec(d);
    case "nps":
      return npsToStackedSpec(d);
    case "ranking":
      return rankingToStackedSpec(d);
    case "matrix":
      return d.matrix ? matrixToStackedSpec(d.matrix) : null;
    default:
      return null;
  }
}

function QuestionDist({
  dist,
  index,
  otherTexts,
  surveyTitle,
}: {
  dist: Distribution;
  index: number;
  otherTexts?: string[];
  surveyTitle: string;
}) {
  if (dist.type === "open") return null;
  const spec = specFor(dist);
  const topBox = dist.type === "scale" ? topBoxSummary(dist.counts) : null;
  return (
    <li className="rounded-lg border p-3">
      <p className="mb-2 text-sm font-medium">
        {index + 1}. {dist.prompt}{" "}
        <span className="text-xs font-normal text-muted-foreground/70">(n={dist.n})</span>
        {/* Never let a thin sample read as a solid finding */}
        {dist.n > 0 && dist.n < 30 && (
          <span className="ml-1 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            표본 작음
          </span>
        )}
      </p>
      {/* 척도 긍정률 헤드라인 — 설문 보고의 1차 지표 (research-survey-viz.md) */}
      {topBox && (
        <p className="mb-1.5 text-sm">
          <span className="font-semibold text-primary">
            긍정 {topBox.topPct}% ({topBox.boxLabel})
          </span>
          <span className="ml-2 text-xs text-muted-foreground">부정 {topBox.bottomPct}%</span>
        </p>
      )}
      {spec ? (
        <FlintChart
          input={spec}
          downloadName={`${surveyTitle}-Q${index + 1}`}
          // 1순위가 가장 진한 색 (Evergreen)
          patchVegaSpec={dist.type === "ranking" ? withReversedColorRamp : undefined}
          fallback={<FallbackBars counts={dist.counts} />}
        />
      ) : (
        <FallbackBars counts={dist.counts} />
      )}
      {dist.type === "multi" && (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          복수응답 — 보기별 응답률 합계가 100%를 넘을 수 있습니다.
        </p>
      )}
      {dist.mean != null && (
        <p className="mt-1 text-xs text-muted-foreground/70">평균 {dist.mean}</p>
      )}
      {dist.npsScore != null && (
        <p className="mt-1 text-xs font-medium text-muted-foreground">
          NPS {dist.npsScore > 0 ? "+" : ""}
          {dist.npsScore}
        </p>
      )}
      {dist.avgRanks && dist.avgRanks.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground/70">
          평균 순위: {dist.avgRanks.map((r) => `${r.label} ${r.avg}`).join(" · ")}
        </p>
      )}
      {otherTexts && otherTexts.length > 0 && (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">기타 입력 ({otherTexts.length}건)</p>
          <ul className="ml-4 list-disc text-xs text-muted-foreground">
            {otherTexts.map((t, j) => (
              <li key={j}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

export function AnalysisPanel({
  surveyId,
  surveyTitle,
  initial,
}: {
  surveyId: string;
  surveyTitle: string;
  initial: ResponseAnalysis;
}) {
  const otherByQ = new Map(initial.otherTexts.map((o) => [o.questionId, o.texts]));

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">응답 분포</h2>
        <ExportMenu surveyId={surveyId} />
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        시뮬레이션 응답 {initial.responseCount}건의 문항별 분포입니다. 합성 데이터이며 실제 응답이 아닙니다.
      </p>

      <ol className="flex flex-col gap-3">
        {initial.distributions.map((d, i) => (
          <QuestionDist
            key={d.questionId}
            dist={d}
            index={i}
            otherTexts={otherByQ.get(d.questionId)}
            surveyTitle={surveyTitle}
          />
        ))}
      </ol>

      {initial.openResponses.some((o) => o.answers.length > 0) && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">주관식 응답</h3>
          <div className="flex flex-col gap-3">
            {initial.openResponses
              .filter((o) => o.answers.length > 0)
              .map((o) => (
                <div key={o.questionId} className="rounded-lg border p-3">
                  <p className="mb-1 text-sm font-medium">{o.prompt}</p>
                  <ul className="ml-4 list-disc text-sm text-muted-foreground">
                    {o.answers.map((a, j) => (
                      <li key={j}>
                        {a.text}
                        {a.probes.length > 0 && (
                          <ul className="mb-1.5 mt-1 flex list-none flex-col gap-1">
                            {a.probes.map((p, k) => (
                              <li key={k} className="rounded-md bg-primary/5 px-2 py-1 text-xs text-muted-foreground">
                                <span className="mr-1 rounded bg-primary/15 px-1 py-0.5 font-medium text-primary">
                                  AI 후속 {k + 1}
                                </span>
                                <span className="text-muted-foreground">Q. {p.q}</span>
                                <span className="mx-1 text-muted-foreground/50">→</span>
                                <span>A. {p.a}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
