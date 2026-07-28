"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitFeedbackAction } from "./feedback-actions";
import type { FeedbackEntry, FeedbackSentiment } from "@/lib/feedback";

const selectCls =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

const TARGETS = [
  { value: "questions", label: "설문 문항 설계" },
  { value: "insight", label: "AI 인사이트 요약" },
];

const TARGET_LABEL: Record<string, string> = Object.fromEntries(
  TARGETS.map((t) => [t.value, t.label]),
);

/**
 * Structured rendering for review-panel-composed comments:
 *   "[AI 검토 — 선택 이슈 N건] 아래 이슈를 모두 반영해 주세요.\n1. 대상: 내용 (수정 방향: …)\n2. …"
 *   "[AI 검토] 대상: 내용 수정 방향: …"
 * Anything that doesn't match falls back to a pre-line paragraph.
 */
interface ParsedCommentItem {
  no: number | null;
  target: string | null;
  body: string;
  fix: string | null;
}

function parseItemText(text: string): Omit<ParsedCommentItem, "no"> {
  let body = text.trim();
  let fix: string | null = null;
  const paren = body.match(/\s*\(수정 방향:\s*([\s\S]+?)\)$/);
  if (paren && paren.index !== undefined) {
    fix = paren[1].trim();
    body = body.slice(0, paren.index).trim();
  } else {
    const bare = body.match(/\s수정 방향:\s*([\s\S]+)$/);
    if (bare && bare.index !== undefined) {
      fix = bare[1].trim();
      body = body.slice(0, bare.index).trim();
    }
  }
  let target: string | null = null;
  const t = body.match(/^(설문 전체|\S+ 문항):\s*/);
  if (t) {
    target = t[1];
    body = body.slice(t[0].length);
  }
  return { target, body, fix };
}

function parseReviewComment(
  text: string,
): { badge: string; intro: string; items: ParsedCommentItem[] } | null {
  const m = text.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) return null;
  const badge = m[1].trim();
  const lines = m[2]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: ParsedCommentItem[] = [];
  let intro = "";
  for (const line of lines) {
    const num = line.match(/^(\d+)\.\s+([\s\S]*)$/);
    if (num) {
      items.push({ no: Number(num[1]), ...parseItemText(num[2]) });
    } else if (items.length === 0) {
      intro = intro ? `${intro} ${line}` : line;
    } else {
      items[items.length - 1].body += ` ${line}`;
    }
  }
  if (items.length === 0) {
    if (!intro) return null;
    items.push({ no: null, ...parseItemText(intro) });
    intro = "";
  }
  return { badge, intro, items };
}

function FeedbackCommentBody({ text }: { text: string }) {
  const parsed = parseReviewComment(text);
  if (!parsed) {
    return <p className="mt-1 break-words whitespace-pre-line text-foreground">{text}</p>;
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {parsed.badge}
        </span>
        {parsed.intro && (
          <span className="text-xs text-muted-foreground">{parsed.intro}</span>
        )}
      </div>
      <ol className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border bg-muted/30">
        {parsed.items.map((it, i) => (
          <li key={i} className="flex gap-2.5 p-3">
            {it.no !== null && (
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {it.no}
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="break-words text-sm leading-relaxed text-foreground">
                {it.target && (
                  <span className="mr-1 font-semibold">{it.target}</span>
                )}
                {it.body}
              </p>
              {it.fix && (
                <p className="rounded-md border border-primary/15 bg-primary/5 px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground/90">
                  <span className="mr-1.5 font-semibold text-primary">수정 방향</span>
                  {it.fix}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function FeedbackPanel({
  surveyId,
  initial,
}: {
  surveyId: string;
  initial: FeedbackEntry[];
}) {
  const [entries, setEntries] = useState<FeedbackEntry[]>(initial);
  const [target, setTarget] = useState(TARGETS[0].value);
  const [sentiment, setSentiment] = useState<FeedbackSentiment | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!sentiment) {
      setError("좋아요/싫어요를 선택해 주세요.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await submitFeedbackAction({
        surveyId,
        targetType: target,
        sentiment,
        comment: comment.trim() || undefined,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.data) setEntries(res.data);
      setComment("");
      setSentiment(null);
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="mb-1 text-lg font-semibold">AI 결과 피드백</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        AI가 만든 문항·요약에 대한 평가는 워크스페이스에 누적되어 다음 설문 생성에 반영됩니다.
      </p>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">대상</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className={selectCls}
          >
            {TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSentiment("up")}
            className={
              sentiment === "up"
                ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-300"
                : ""
            }
          >
            👍 좋아요
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSentiment("down")}
            className={
              sentiment === "down"
                ? "border-destructive bg-destructive/5 text-destructive"
                : ""
            }
          >
            👎 싫어요
          </Button>
        </div>

        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="개선 의견이나 칭찬을 남겨 주세요 (선택)"
          rows={2}
          className="min-h-0"
        />

        <div className="flex items-center gap-3">
          <Button type="button" size="sm" onClick={submit} disabled={pending}>
            {pending ? "저장 중…" : "피드백 제출"}
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold">남긴 피드백 ({entries.length})</h3>
          <ul className="flex flex-col gap-2">
            {entries.map((e) => (
              <li key={e.id} className="rounded-lg border p-3 text-sm">
                <span className="mr-1">{e.sentiment === "up" ? "👍" : "👎"}</span>
                <span className="text-muted-foreground">
                  {TARGET_LABEL[e.targetType] ?? e.targetType}
                </span>
                {e.comment && <FeedbackCommentBody text={e.comment} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
