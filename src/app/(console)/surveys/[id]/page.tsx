import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { questions } from "@/db/schema";
import { loadOwnedSurvey, surveyCounts } from "@/lib/survey-access";
import { normalizeOptions, type ConfigOption } from "@/lib/question-config";
import { evaluateReviewGate } from "@/lib/review-gate";
import { ExportMarkdown } from "./export-markdown";
import { ReviewControls } from "./review-controls";
import { ReviewPanel } from "./review-panel";
import type { StoredReview } from "./review-actions";
import { SurveyHeader } from "./survey-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Section } from "@astryxdesign/core/Section";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

const TYPE_LABEL: Record<string, string> = {
  single: "단일 선택",
  multi: "복수 선택",
  scale: "척도",
  open: "주관식",
  ranking: "순위",
  matrix: "행렬",
  nps: "NPS",
};

export default async function SurveyOverview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const owned = await loadOwnedSurvey(id);
  if (!owned) notFound();
  const { survey } = owned;

  const [counts, qs] = await Promise.all([
    surveyCounts(survey.id),
    db.select().from(questions).where(eq(questions.surveyId, survey.id)).orderBy(asc(questions.order)),
  ]);

  const metrics: [string, number][] = [
    ["문항", qs.length],
    ["페르소나", counts.personaCount],
    ["시뮬 응답", counts.syntheticCount],
  ];

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <SurveyHeader survey={survey} active="overview" />
      <Text type="large" color="secondary" className="-mt-3">
        목표: {survey.researchGoal}
      </Text>

      <div className="grid grid-cols-3 gap-2 text-center">
        {metrics.map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <div className="text-xl font-bold">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>

      <ReviewControls
        surveyId={survey.id}
        status={survey.status}
        initialGate={evaluateReviewGate({
          lastReview: survey.lastReview,
          surveyUpdatedAt: survey.updatedAt,
          questions: qs.map((q) => ({
            id: q.id,
            order: q.order,
            type: q.type,
            prompt: q.prompt,
            config: (q.config ?? {}) as never,
          })),
        })}
      />

      <ReviewPanel
        surveyId={survey.id}
        initialReport={(survey.lastReview as StoredReview | null)?.report ?? null}
        initialReviewedAt={(survey.lastReview as StoredReview | null)?.at ?? null}
        surveyUpdatedAt={survey.updatedAt.toISOString()}
      />

      <Section>
        <VStack gap={3}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Heading level={2}>문항 미리보기</Heading>
            <div className="flex items-center gap-2">
              <ExportMarkdown surveyId={survey.id} />
              <Link
                href={`/surveys/${survey.id}/edit`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                편집
              </Link>
            </div>
          </div>
          <ol className="flex flex-col gap-3">
            {qs.map((q, i) => {
              const config = (q.config ?? {}) as {
                options?: ConfigOption[];
                scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
                rows?: string[];
                columns?: string[];
                limit?: number;
              };
              return (
                <li key={q.id} className="rounded-lg border bg-card p-3">
                  <div className="mb-1 flex items-start justify-between gap-3">
                    <p className="font-medium">
                      {i + 1}. {q.prompt}
                    </p>
                    <Badge variant="secondary" className="shrink-0">
                      {TYPE_LABEL[q.type] ?? q.type}
                    </Badge>
                  </div>
                  {config.options && (
                    <ul className="ml-4 list-disc text-sm text-muted-foreground">
                      {normalizeOptions(config.options).map((o) => (
                        <li key={o.id}>{o.label}</li>
                      ))}
                    </ul>
                  )}
                  {config.scale && (
                    <p className="text-sm text-muted-foreground">
                      {config.scale.min} – {config.scale.max}
                    </p>
                  )}
                  {config.rows && config.columns && (
                    <p className="text-sm text-muted-foreground">
                      {config.rows.join(", ")} × ({config.columns.join(" / ")})
                    </p>
                  )}
                  {q.type === "ranking" && config.limit && config.limit > 0 && (
                    <p className="text-sm text-muted-foreground">상위 {config.limit}순위 선택</p>
                  )}
                  {q.type === "nps" && <p className="text-sm text-muted-foreground">0 – 10 추천 의향</p>}
                </li>
              );
            })}
          </ol>
        </VStack>
      </Section>
    </main>
  );
}
