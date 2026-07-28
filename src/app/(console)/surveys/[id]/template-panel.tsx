"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { insertTemplateQuestionsAction, saveTemplateAction } from "./template-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Native <select> styled to match the shadcn Input aesthetic. */
const selectCls =
  "rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** Saves the current question set as a reusable workspace template (US-008). */
export function SaveTemplatePanel({ surveyId }: { surveyId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSave() {
    setMsg(null);
    setErr(null);
    startTransition(async () => {
      const r = await saveTemplateAction(surveyId, name, description);
      if (r.error) setErr(r.error);
      else {
        const d = r.derived;
        const extra =
          d && d.blocks + d.questions > 0
            ? ` (블록 ${d.blocks}개·문항 ${d.questions}개 자동 생성)`
            : "";
        setMsg(`"${r.name}" 템플릿으로 저장되었습니다${extra} ✓`);
        setName("");
        setDescription("");
        setOpen(false);
      }
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">템플릿으로 저장</h2>
          <p className="text-xs text-muted-foreground">
            현재 문항셋(문항 id·보기 id·메타 포함)을 재사용 가능한 템플릿으로 저장합니다. 저장 시
            개념(construct)별 블록과 개별 문항 템플릿도 자동으로 함께 생성됩니다.
          </p>
        </div>
        {!open && (
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            className="shrink-0"
          >
            템플릿으로 저장
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="템플릿 이름 (예: NPS + 이탈 사유)"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="설명 (선택)"
            className="min-h-0"
          />
          <div className="flex gap-2">
            <Button
              onClick={onSave}
              disabled={pending || name.trim().length < 2}
            >
              {pending ? "저장 중…" : "저장"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
              disabled={pending}
            >
              취소
            </Button>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      {msg && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
    </section>
  );
}

type InsertTemplate = { id: string; name: string; questionCount: number };

/**
 * Inserts a saved template's questions into the current survey at a chosen
 * position (US-010). New questions get fresh quids; existing order is preserved.
 */
export function InsertTemplatePanel({
  surveyId,
  templates,
  questionPrompts,
}: {
  surveyId: string;
  templates: InsertTemplate[];
  questionPrompts: string[];
}) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  // Insertion index among current questions: 0..count (count = append).
  const [pos, setPos] = useState(questionPrompts.length);
  const [msg, setMsg] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onInsert() {
    setMsg(null);
    setNotice(null);
    setErr(null);
    if (!templateId) {
      setErr("템플릿을 선택해 주세요.");
      return;
    }
    startTransition(async () => {
      const r = await insertTemplateQuestionsAction(surveyId, templateId, pos);
      if (r.error) setErr(r.error);
      else {
        setMsg(`${r.inserted}개 문항이 삽입되었습니다 ✓`);
        setNotice(r.droppedNotice ?? null);
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">템플릿에서 문항 삽입</h2>
        <p className="text-xs text-muted-foreground">
          저장된 템플릿의 문항을 원하는 위치에 삽입합니다. 삽입된 문항은 새 id를 받습니다.
        </p>
      </div>

      {templates.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          저장된 템플릿이 없습니다. 먼저 &ldquo;템플릿으로 저장&rdquo;으로 만들어 보세요.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <select
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className={selectCls}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (문항 {t.questionCount}개)
              </option>
            ))}
          </select>
          <select
            value={pos}
            onChange={(e) => setPos(Number(e.target.value))}
            className={selectCls}
          >
            <option value={0}>맨 앞에 삽입</option>
            {questionPrompts.map((p, i) => (
              <option key={i} value={i + 1}>
                {i + 1}. {p.slice(0, 24)} 뒤에 삽입
              </option>
            ))}
          </select>
          <div>
            <Button
              onClick={onInsert}
              disabled={pending || !templateId}
            >
              {pending ? "삽입 중…" : "이 설문에 삽입"}
            </Button>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      {msg && <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
      {notice && <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">⚠️ {notice}</p>}
    </section>
  );
}
