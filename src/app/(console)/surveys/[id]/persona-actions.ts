"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { generatePersonas } from "@/lib/personas";

export type PersonaState = { error?: string; count?: number };

export async function generatePersonasAction(
  surveyId: string,
  _prev: PersonaState,
  formData: FormData,
): Promise<PersonaState> {
  const description = String(formData.get("description") || "").trim();
  const n = Math.min(10000, Math.max(10, Number(formData.get("n") || 30)));
  const scope = String(formData.get("scope") || "").trim(); // "" = corpus mode
  if (!scope && description.length < 3) {
    return { error: "타겟 모집단을 설명하거나, 대표성 표본 지역을 선택해 주세요." };
  }

  const workspaceId = await getWorkspaceId();
  const [owned] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!owned) return { error: "설문을 찾을 수 없습니다." };

  try {
    const count = await generatePersonas(workspaceId, surveyId, description, n, {
      representativeScope: scope || undefined,
    });
    revalidatePath(`/surveys/${surveyId}`);
    return { count };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "페르소나 생성 실패" };
  }
}
