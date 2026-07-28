"use client";

import { callAction } from "@/lib/call-action";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { reviewSurveyAction } from "./review-actions";
import type { SurveyReviewReport, ReviewReportItem } from "@/lib/review-ai";
import { questionCode } from "@/lib/question-code";

const SEVERITY_GROUPS: {
  key: ReviewReportItem["severity"];
  label: string;
  tone: string;
  badge: string;
}[] = [
  { key: "error", label: "오류", tone: "border-destructive/30 bg-destructive/5", badge: "bg-destructive/15 text-destructive" },
  { key: "warning", label: "경고", tone: "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950", badge: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300" },
  { key: "suggestion", label: "제안", tone: "border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950", badge: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300" },
  { key: "info", label: "참고", tone: "border-border bg-muted/50", badge: "bg-muted text-muted-foreground" },
];

/** Feedback text sent to the AI-revision flow (design tab prefill). */
function toRevisionFeedback(item: ReviewReportItem): string {
  const target = item.quid ? `${questionCode(item.quid)} 문항: ` : "설문 전체: ";
  const fix = item.suggestion ? ` 수정 방향: ${item.suggestion}` : "";
  return `[AI 검토] ${target}${item.message}${fix}`;
}

/** Several checked issues composed into ONE revision-feedback text. */
function toBulkRevisionFeedback(items: ReviewReportItem[]): string {
  const lines = items.map((it, i) => {
    const target = it.quid ? `${questionCode(it.quid)} 문항` : "설문 전체";
    const fix = it.suggestion ? ` (수정 방향: ${it.suggestion})` : "";
    return `${i + 1}. ${target}: ${it.message}${fix}`;
  });
  return `[AI 검토 — 선택 이슈 ${items.length}건] 아래 이슈를 모두 반영해 주세요.\n${lines.join("\n")}`;
}

function ReviewItem({
  surveyId,
  item,
  checked,
  onToggle,
}: {
  surveyId: string;
  item: ReviewReportItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-lg border bg-card p-2.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 shrink-0"
          aria-label="이슈 선택"
        />
        <span className="min-w-0 flex-1">
          {item.quid && (
            <span className="mr-1 font-mono text-[10px] text-muted-foreground/70">{questionCode(item.quid)}</span>
          )}
          {item.message}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {item.source === "deterministic" ? "구조 검사" : "AI 검토"}
        </span>
      </div>
      {item.prompt && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground/70" title={item.prompt}>
          {item.prompt}
        </p>
      )}
      {item.suggestion && (
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="text-muted-foreground/70">→ 제안:</span> {item.suggestion}
        </p>
      )}
      {item.source === "ai" && (
        <Link
          href={`/surveys/${surveyId}/edit?feedback=${encodeURIComponent(toRevisionFeedback(item))}`}
          className="mt-1.5 inline-block rounded border px-2 py-0.5 text-xs font-medium text-primary hover:bg-muted"
          title="설계 탭으로 이동해 이 이슈를 반영한 AI 수정안을 바로 생성합니다 (적용 전 전/후 비교 확인)"
        >
          수정안 생성 ↗
        </Link>
      )}
    </li>
  );
}

export function ReviewPanel({
  surveyId,
  initialReport = null,
  initialReviewedAt = null,
  surveyUpdatedAt = null,
}: {
  surveyId: string;
  /** Last persisted review (surveys.last_review) — survives navigation/refresh. */
  initialReport?: SurveyReviewReport | null;
  initialReviewedAt?: string | null;
  /** survey.updatedAt — flags the stored report as stale after later edits. */
  surveyUpdatedAt?: string | null;
}) {
  const [report, setReport] = useState<SurveyReviewReport | null>(initialReport);
  const [reviewedAt, setReviewedAt] = useState<string | null>(initialReviewedAt);
  // Checked issue indexes (into report.items) for the bulk send-to-revision.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // The AI reads the whole survey in one call — minutes, not seconds. Without
  // a ticking counter a working review is indistinguishable from a hung one.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [pending]);

  function onRun() {
    setError(null);
    startTransition(async () => {
      const r = await callAction(() => reviewSurveyAction(surveyId));
      if (r.error) setError(r.error);
      else if (r.report) {
        setReport(r.report);
        setReviewedAt(r.at ?? null);
        setSelected(new Set());
      }
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">설문 검토</h2>
        <span className="flex items-center gap-2">
          {reviewedAt && (
            <span className="text-xs text-muted-foreground/70">
              마지막 검토 {new Date(reviewedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={onRun} disabled={pending}>
            {pending
              ? `검토 중… ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`
              : report
                ? "다시 검토"
                : "AI 검토 실행"}
          </Button>
        </span>
      </div>

      {pending && (
        <p className="mb-3 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          AI가 설문 전체를 한 번에 읽습니다 — 보통 2~5분 걸립니다. 이 화면을 벗어나도 검토는 계속
          진행되며, 결과는 저장되어 다시 들어오면 보입니다.
        </p>
      )}

      <p className="mb-3 text-xs text-muted-foreground">
        시뮬레이션을 돌리기 전에 설문 전체를 두 층으로 점검합니다 — ① 결정적 구조 검사(도달 불가 문항·모순 조건·보기 문제)
        ② AI 종합 검토(유도 질문·이중 질문·보기 누락 등). 이슈를 선택하면 설계 탭에서 수정안이 바로 생성됩니다.
      </p>

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {report &&
        reviewedAt &&
        surveyUpdatedAt &&
        new Date(surveyUpdatedAt).getTime() > new Date(reviewedAt).getTime() && (
          <p className="mb-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-2 text-xs text-amber-700 dark:text-amber-300">
            검토 이후 설문이 수정되었습니다 — 아래 결과는 이전 상태 기준이니 다시
            검토하세요.
          </p>
        )}

      {report && (
        <div className="flex flex-col gap-3">
          {report.aiStatus === "failed" && (
            <p className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-2 text-xs text-amber-700 dark:text-amber-300">
              AI 검토를 실행하지 못해 결정적 검사 결과만 표시합니다
              {report.aiError ? ` — ${report.aiError}` : ""}.
            </p>
          )}

          {report.items.length === 0 ? (
            // An AI-failed review is PARTIAL — a clean deterministic layer
            // alone must not read as "이대로 진행해도 좋습니다".
            report.aiStatus === "failed" ? (
              <p className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 p-2 text-sm text-amber-700 dark:text-amber-300">
                구조·로직 검사에서는 이슈가 없습니다. 다만 AI 검토가 실행되지 않아
                완전한 결과가 아닙니다 — &ldquo;다시 검토&rdquo;로 재시도하세요.
              </p>
            ) : (
              <p className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 p-2 text-sm text-emerald-700 dark:text-emerald-400">
                발견된 이슈가 없습니다 ✓
              </p>
            )
          ) : (
            SEVERITY_GROUPS.map((g) => {
              const items = report.items.filter((i) => i.severity === g.key);
              if (items.length === 0) return null;
              return (
                <div key={g.key} className={`rounded-lg border p-2.5 ${g.tone}`}>
                  <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${g.badge}`}>
                      {g.label} {items.length}
                    </span>
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {items.map((item, i) => {
                      const idx = report.items.indexOf(item);
                      return (
                        <ReviewItem
                          key={`${g.key}-${i}`}
                          surveyId={surveyId}
                          item={item}
                          checked={selected.has(idx)}
                          onToggle={() =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(idx)) next.delete(idx);
                              else next.add(idx);
                              return next;
                            })
                          }
                        />
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}

          {report.items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  setSelected((prev) =>
                    prev.size === report.items.length
                      ? new Set()
                      : new Set(report.items.map((_, i) => i)),
                  )
                }
              >
                {selected.size === report.items.length ? "전체 해제" : "전체 선택"}
              </Button>
              <Link
                href={
                  selected.size > 0
                    ? `/surveys/${surveyId}/edit?feedback=${encodeURIComponent(
                        toBulkRevisionFeedback([...selected].sort((a, b) => a - b).map((i) => report.items[i])),
                      )}`
                    : "#"
                }
                aria-disabled={selected.size === 0}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                  selected.size > 0
                    ? "bg-primary text-primary-foreground hover:bg-primary/80"
                    : "pointer-events-none border text-muted-foreground/50"
                }`}
                title="설계 탭으로 이동해 선택한 이슈들을 모두 반영한 AI 수정안을 바로 생성합니다 (적용 전 전/후 비교 확인)"
              >
                선택 {selected.size}건으로 수정안 생성 ↗
              </Link>
            </div>
          )}

          <p className="text-xs text-muted-foreground/70">
            메타데이터 완결성: {report.metaCompleteness.total}개 문항 중 개념(construct) 지정{" "}
            {report.metaCompleteness.withConstruct}개 · 주제 {report.metaCompleteness.withTopic}개
          </p>
        </div>
      )}

      {!report && !pending && (
        <p className="text-sm text-muted-foreground/70">아직 검토 결과가 없습니다.</p>
      )}
    </section>
  );
}
