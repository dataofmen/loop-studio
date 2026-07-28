"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ConstructResults } from "@/lib/construct-analytics";
import {
  buildConstructResultsView,
  shortDate,
  type ConstructResultsView,
} from "@/lib/construct-results-view";
import type { ConstructQuestionResult } from "@/lib/construct-stats";
import { questionCode } from "@/lib/question-code";
import { constructResultsAction } from "./actions";

/**
 * US-002: lazy-loaded cross-survey results of one construct, shown in the
 * same detail area as the member-question list. Real responses only — the
 * synthetic count is surfaced as a label, never as numbers.
 */
export function ConstructResultsPanel({ constructId }: { constructId: string }) {
  const [results, setResults] = useState<ConstructResults | null | "loading">("loading");
  useEffect(() => {
    let alive = true;
    constructResultsAction(constructId).then((r) => {
      if (alive) setResults(r);
    });
    return () => {
      alive = false;
    };
  }, [constructId]);

  if (results === "loading")
    return <p className="mt-2 text-xs text-muted-foreground/70">결과 불러오는 중…</p>;
  if (results === null)
    return <p className="mt-2 text-xs text-muted-foreground/70">결과를 불러올 수 없습니다.</p>;

  const view = buildConstructResultsView(results.memberCount, results.aggregate);
  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-2">
      <ResultsBody view={view} />
    </div>
  );
}

function ResultsBody({ view }: { view: ConstructResultsView }) {
  if (view.status === "no-questions")
    return <p className="text-xs text-muted-foreground/70">이 construct를 참조하는 문항이 없습니다.</p>;
  if (view.status === "no-responses")
    return (
      <p className="text-xs text-muted-foreground">
        아직 응답이 없습니다. 이 개념을 쓰는 설문의 시뮬레이션을 돌리면 개념 단위 결과가
        여기에 누적됩니다.
      </p>
    );
  if (view.status === "synthetic-only")
    return (
      <p className="text-xs text-muted-foreground">
        아직 실제 응답이 없습니다 — 합성 응답 {view.syntheticResponseCount}건만 있어 통계에
        포함하지 않았습니다 (실제 응답만 ground truth).
      </p>
    );

  return (
    <>
      <p className="text-xs text-muted-foreground">
        실제 응답 <span className="font-medium text-foreground">{view.realResponseCount}건</span>{" "}
        기준
        {view.syntheticResponseCount > 0 && (
          <span className="text-muted-foreground/70"> · 합성 {view.syntheticResponseCount}건 제외</span>
        )}
      </p>

      {view.numericGroups.map((g) => (
        <div key={g.scaleKey} className="rounded-md bg-muted/50 p-2.5">
          <p className="text-xs font-medium text-foreground">
            {g.scaleKey} 통합 평균{" "}
            <span className="text-sm font-semibold text-foreground">
              {g.overall.mean ?? "—"}
            </span>{" "}
            <span className="font-normal text-muted-foreground/70">(응답 {g.overall.n}건)</span>
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {g.points.map((p) => (
              <li key={`${p.surveyId}:${p.quid}`} className="flex items-baseline gap-2 text-xs">
                <span className="w-20 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {shortDate(p.surveyCreatedAt)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={p.prompt}>
                  {p.surveyTitle} · <span className="font-mono text-[10px]">{questionCode(p.quid)}</span>
                </span>
                <span className="shrink-0 font-medium text-foreground">
                  {p.mean ?? "—"}
                </span>
                <span className="w-14 shrink-0 text-right text-muted-foreground/70">n={p.n}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {view.choice.map((r) => (
        <ChoiceResult key={`${r.surveyId}:${r.quid}`} r={r} />
      ))}

      {view.open.length > 0 && (
        <div className="rounded-md bg-muted/50 p-2.5">
          <p className="text-xs font-medium text-foreground">주관식</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {view.open.map((o) => (
              <li key={o.quid} className="truncate text-xs text-muted-foreground">
                <span className="font-mono text-[10px] text-muted-foreground/70">{questionCode(o.quid)}</span>{" "}
                {o.prompt} <span className="text-muted-foreground/70">— 응답 {o.answered}건</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Per survey·question distribution — labels are never merged across surveys. */
function ChoiceResult({ r }: { r: ConstructQuestionResult }) {
  const d = r.distribution;
  return (
    <div className="rounded-md bg-muted/50 p-2.5">
      <p className="truncate text-xs font-medium text-foreground" title={r.prompt}>
        <Link href={`/surveys/${r.surveyId}/edit`} className="hover:underline">
          {r.surveyTitle}
        </Link>{" "}
        · <span className="font-mono text-[10px] text-muted-foreground/70">{questionCode(r.quid)}</span>{" "}
        {r.prompt} <span className="font-normal text-muted-foreground/70">(n={d.n})</span>
      </p>
      <div className="mt-1.5 flex flex-col gap-1">
        {d.counts.map((c) => (
          <div key={c.label} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-muted-foreground" title={c.label}>
              {c.label}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${c.pct}%` }} />
            </div>
            <span className="w-9 shrink-0 text-right text-muted-foreground">{c.pct}%</span>
          </div>
        ))}
        {d.avgRanks && d.avgRanks.length > 0 && (
          <p className="text-[11px] text-muted-foreground/70">
            평균 순위: {d.avgRanks.map((x) => `${x.label} ${x.avg}`).join(" · ")}
          </p>
        )}
        {d.matrix && d.matrix.length > 0 && (
          <div className="flex flex-col gap-0.5 border-l-2 border-border pl-2">
            {d.matrix.map((row) => (
              <p key={row.row} className="text-[11px] text-muted-foreground">
                <span className="font-medium">{row.row}</span>:{" "}
                {row.counts.filter((c) => c.count > 0).map((c) => `${c.label} ${c.pct}%`).join(", ") || "—"}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
