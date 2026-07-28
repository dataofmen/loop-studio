"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createSurveyAction, type CreateSurveyState } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "AI가 설문을 설계 중…" : "AI로 설문 생성"}
    </Button>
  );
}

export function GoalForm() {
  const [state, formAction] = useActionState<CreateSurveyState, FormData>(
    createSurveyAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <Label htmlFor="goal">리서치 목표</Label>
      <Textarea
        id="goal"
        name="goal"
        rows={3}
        required
        placeholder="예: 신규 가격제에 대한 기존 고객의 반응을 파악하고 싶다"
      />
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      <div>
        <SubmitButton />
      </div>
    </form>
  );
}
