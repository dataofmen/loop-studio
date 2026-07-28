"use client";

import { useState } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { importSurveyAction, type ImportState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "불러오는 중…" : "설문 불러오기"}
    </Button>
  );
}

export function ImportForm() {
  const [md, setMd] = useState("");
  const [fileName, setFileName] = useState("");
  const [state, formAction] = useActionState<ImportState, FormData>(importSurveyAction, {});

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setMd(await file.text());
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Label>.md 파일 업로드</Label>
      <div className="flex items-center gap-3">
        <Label
          htmlFor="md-file"
          className="cursor-pointer rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm hover:bg-muted"
        >
          파일 선택
        </Label>
        <span className="text-sm text-muted-foreground">{fileName || "선택된 파일 없음"}</span>
        <input
          id="md-file"
          type="file"
          accept=".md,.markdown,text/markdown"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="sr-only"
        />
      </div>

      <Label htmlFor="markdown">또는 마크다운 붙여넣기</Label>
      <Textarea
        id="markdown"
        name="markdown"
        rows={18}
        value={md}
        onChange={(e) => setMd(e.target.value)}
        placeholder={"---\nresearchGoal: 신규 가격제에 대한 반응 파악\n---\n\n### Q1 [single]\n현재 요금제를 이용 중이신가요?\n- 예\n- 아니요"}
        className="font-mono text-xs leading-5"
      />

      {state.message && <p className="text-sm text-destructive">{state.message}</p>}

      {state.errors && state.errors.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="mb-2 text-sm font-medium text-destructive">
            오류 {state.errors.length}건 — 설문이 생성되지 않았습니다. 모두 고친 뒤 다시 시도하세요.
          </p>
          <ul className="flex flex-col gap-1">
            {state.errors.map((e, i) => (
              <li key={i} className="text-xs text-destructive">
                <span className="font-mono">라인 {e.line}</span> — {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
