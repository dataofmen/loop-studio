"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { markSurveyReviewed, reopenSurveyDraft } from "./actions";
import type { ReviewGate } from "@/lib/review-gate";
import { cn } from "@/lib/utils";

/**
 * Review gate controls: walk the survey as a respondent would, then mark it
 * 검토 완료 once the AI review and the structural checks are clean.
 */
export function ReviewControls({
  surveyId,
  status,
  initialGate = null,
}: {
  surveyId: string;
  status: string;
  /** Review-gate state at render time (badge next to the button). */
  initialGate?: ReviewGate | null;
}) {
  const [pending, startTransition] = useTransition();
  // Gate returned by a withheld attempt — renders the confirm step.
  const [gate, setGate] = useState<ReviewGate | null>(null);

  const previewPath = `/preview/${surveyId}`;

  /** Mark reviewed through the gate; a non-ok gate opens the confirm step. */
  function onMark(force: boolean) {
    startTransition(async () => {
      try {
        const res = await markSurveyReviewed(surveyId, force ? { force: true } : undefined);
        setGate(res.gated && res.gate ? res.gate : null);
      } catch {
        /* revalidates on success */
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        {/* Same-window navigation on purpose: the desktop shell's webview
            ignores target="_blank", so a new tab would silently do nothing.
            The preview screen carries its own way back. */}
        <Link
          href={previewPath}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          미리보기 열기
        </Link>

        {status === "draft" && (
          <Button size="sm" onClick={() => onMark(false)} disabled={pending}>
            검토 완료로 표시
          </Button>
        )}
        {status !== "draft" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => startTransition(() => reopenSurveyDraft(surveyId).catch(() => {}))}
            disabled={pending}
          >
            초안으로 되돌리기
          </Button>
        )}

        {initialGate && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              initialGate.ok
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            }`}
            title={initialGate.ok ? undefined : initialGate.reasons.map((r) => r.message).join(" · ")}
          >
            {initialGate.ok ? "검토 통과 ✓" : "검토 필요 ⚠️"}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground/70">
        미리보기는 응답자가 보는 그대로를 보여주며 아무것도 저장하지 않습니다 — 표시 로직의 모든 분기를 직접 밟아 볼 수
        있습니다.
      </p>

      {/* The mark was withheld — explicit choice required, no hard block */}
      {gate && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <p className="mb-1 text-sm font-semibold text-amber-800 dark:text-amber-200">
            아직 확인이 필요합니다
          </p>
          <ul className="ml-4 list-disc text-xs text-amber-800 dark:text-amber-200">
            {gate.reasons.map((r) => (
              <li key={r.code}>{r.message}</li>
            ))}
          </ul>
          {gate.freshErrors.length > 0 && (
            <ul className="ml-4 mt-1 list-disc text-xs text-destructive">
              {gate.freshErrors.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              onClick={() => onMark(true)}
              disabled={pending}
              className="border-amber-400 text-amber-800 hover:text-amber-900 dark:border-amber-700 dark:text-amber-200"
            >
              그래도 완료 처리
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setGate(null)} disabled={pending}>
              취소
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
