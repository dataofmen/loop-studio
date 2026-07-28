import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { listTemplates } from "@/lib/templates";
import { TemplateLibrary } from "./template-library";

/** Template library — browse/search reusable question-set templates (US-009). */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ construct?: string }>;
}) {
  const [workspaceId, { construct }] = await Promise.all([getWorkspaceId(), searchParams]);
  const [templates, draftSurveys] = await Promise.all([
    listTemplates(workspaceId),
    // Draft surveys are the safe insert targets for "설문에 삽입" — inserting into
    // a live/closed survey would change its questions mid-collection.
    db
      .select({ id: surveys.id, title: surveys.title })
      .from(surveys)
      .where(
        and(
          eq(surveys.workspaceId, workspaceId),
          eq(surveys.status, "draft"),
          eq(surveys.archived, false),
        ),
      )
      .orderBy(desc(surveys.updatedAt)),
  ]);
  const insertTargets = draftSurveys.map((s) => ({ id: s.id, title: s.title || "제목 없는 설문" }));

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">템플릿 라이브러리</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          저장한 문항셋을 topic·construct로 찾아보고, 새 설문을 만들거나 기존 설문에 삽입하세요.
        </p>
      </div>
      <TemplateLibrary
        templates={templates}
        insertTargets={insertTargets}
        initialConstruct={construct ?? ""}
      />
    </main>
  );
}
