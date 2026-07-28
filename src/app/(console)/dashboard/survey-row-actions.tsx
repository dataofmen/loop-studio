"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  deleteSurveyAction,
  duplicateSurveyAction,
  setSurveyArchivedAction,
} from "./actions";

/**
 * Inline per-row actions: 복사 · 보관(해제) · 삭제, always visible for
 * discoverability. Delete asks for inline confirmation and, when the survey has
 * real responses, is refused with a message steering the user to archive.
 */
export function SurveyRowActions({
  surveyId,
  archived,
}: {
  surveyId: string;
  archived: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onDuplicate() {
    setError(null);
    startTransition(async () => {
      await duplicateSurveyAction(surveyId); // redirects to the copy
    });
  }

  function onArchiveToggle() {
    setError(null);
    startTransition(async () => {
      await setSurveyArchivedAction(surveyId, !archived);
    });
  }

  function onDelete() {
    setError(null);
    startTransition(async () => {
      const res = await deleteSurveyAction(surveyId);
      if (res.ok) return;
      setConfirmingDelete(false);
      setError("삭제할 수 없습니다.");
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      {confirmingDelete ? (
        <div className="flex items-center gap-1">
          <span className="px-1 text-xs text-destructive">삭제할까요?</span>
          <Button
            type="button"
            variant="destructive"
            size="xs"
            onClick={onDelete}
            disabled={pending}
          >
            {pending ? "삭제 중…" : "삭제"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setConfirmingDelete(false)}
            disabled={pending}
          >
            취소
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="xs" onClick={onDuplicate} disabled={pending}>
            복사
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onArchiveToggle} disabled={pending}>
            {archived ? "보관 해제" : "보관"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setError(null);
              setConfirmingDelete(true);
            }}
            disabled={pending}
            className="text-muted-foreground hover:text-destructive"
          >
            삭제
          </Button>
        </div>
      )}
      {error && <p className="max-w-[16rem] text-right text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
