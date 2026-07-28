import { asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { questions } from "@/db/schema";
import { loadOwnedSurvey } from "@/lib/survey-access";
import { listProposals, listRevisions } from "@/lib/revisions";
import { listTemplates } from "@/lib/templates";
import { sanitizeConfig } from "@/lib/display-logic";
import { Editor } from "./editor";
import { SurveyHeader } from "../survey-header";
import { RevisionPanel } from "../revision-panel";
import { InsertTemplatePanel } from "../template-panel";

export default async function EditSurveyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ feedback?: string }>;
}) {
  const { id } = await params;
  // Review deep link: ?feedback=… prefills the AI-revision box.
  const [{ feedback }, owned] = await Promise.all([searchParams, loadOwnedSurvey(id)]);
  if (!owned) notFound();
  const { survey, workspaceId } = owned;

  const [qs, revisions, proposals, templates] = await Promise.all([
    db.select().from(questions).where(eq(questions.surveyId, survey.id)).orderBy(asc(questions.order)),
    listRevisions(survey.id),
    listProposals(survey.id, workspaceId),
    listTemplates(workspaceId),
  ]);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <SurveyHeader survey={survey} active="design" />
      <Editor
        // Remount with fresh questions whenever a server-side change lands
        // (AI revision apply, revert, template insert bump survey.updatedAt).
        // Without this the client state keeps showing pre-apply questions and
        // a subsequent edit would write the stale content back to the DB.
        key={survey.updatedAt.toISOString()}
        surveyId={survey.id}
        initialTitle={survey.title ?? ""}
        initialWelcome={survey.welcomeMessage ?? ""}
        initialClosing={survey.closingMessage ?? ""}
        initialQuestions={qs.map((q) => ({
          id: q.id,
          quid: q.quid,
          type: q.type,
          order: q.order,
          prompt: q.prompt,
          config: sanitizeConfig((q.config ?? {}) as { displayLogic?: never }) as never,
        }))}
      />
      <RevisionPanel
        surveyId={survey.id}
        initialRevisions={revisions}
        initialFeedback={typeof feedback === "string" ? feedback : undefined}
        initialProposals={proposals}
      />
      <InsertTemplatePanel
        surveyId={survey.id}
        templates={templates.map((t) => ({
          id: t.id,
          name: t.name,
          questionCount: t.questionCount,
        }))}
        questionPrompts={qs.map((q) => q.prompt)}
      />
    </main>
  );
}
