import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { surveys, questions } from "@/db/schema";
import { PreviewForm } from "./preview-form";

/**
 * Respondent-eye walkthrough of a survey. Renders regardless of status and
 * stores nothing — it exists so the author can check wording, flow and every
 * branch of their display logic before running a simulation.
 */
export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [survey] = await db
    .select({
      id: surveys.id,
      title: surveys.title,
      welcomeMessage: surveys.welcomeMessage,
      closingMessage: surveys.closingMessage,
    })
    .from(surveys)
    .where(eq(surveys.id, id))
    .limit(1);

  const notice = (title: string, msg: string) => (
    <main className="flex min-h-[100dvh] items-center justify-center bg-neutral-50 px-6">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-3 text-gray-500">{msg}</p>
      </div>
    </main>
  );

  if (!survey) return notice("설문을 찾을 수 없습니다", "삭제되었거나 잘못된 주소입니다.");


  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.surveyId, survey.id))
    .orderBy(asc(questions.order));

  if (qs.length === 0) return notice("문항이 없습니다", "설계 화면에서 문항을 먼저 추가해 주세요.");

  return (
    <PreviewForm
      backHref={`/surveys/${survey.id}`}
      title={survey.title ?? "설문"}
      welcomeMessage={survey.welcomeMessage ?? null}
      closingMessage={survey.closingMessage ?? null}
      questions={qs.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        config: (q.config ?? {}) as never,
      }))}
    />
  );
}
