import { and, desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getWorkspaceId } from "@/lib/auth";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { CliNotice } from "./cli-notice";
import { GoalForm } from "./goal-form";
import { SurveyRowActions } from "./survey-row-actions";
import { statusLabel } from "@/lib/survey-status";
import { Badge } from "@/components/ui/badge";
import { Section } from "@astryxdesign/core/Section";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

/** Status → badge tone. simulated reads as the "done" state. */
function statusVariant(status: string): "default" | "secondary" {
  return status === "simulated" ? "default" : "secondary";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const [workspaceId, { view }] = await Promise.all([getWorkspaceId(), searchParams]);
  const showArchived = view === "archived";

  const [mySurveys, [{ archivedCount }]] = await Promise.all([
    db
      .select({
        id: surveys.id,
        title: surveys.title,
        status: surveys.status,
        archived: surveys.archived,
        createdAt: surveys.createdAt,
      })
      .from(surveys)
      .where(and(eq(surveys.workspaceId, workspaceId), eq(surveys.archived, showArchived)))
      .orderBy(desc(surveys.createdAt))
      .limit(50),
    db
      .select({ archivedCount: sql<number>`count(*)::int` })
      .from(surveys)
      .where(and(eq(surveys.workspaceId, workspaceId), eq(surveys.archived, true))),
  ]);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <CliNotice />

      <Section>
        <VStack gap={3}>
          <Heading level={2}>새 설문</Heading>
          <GoalForm />
          <Text type="large" color="secondary" className="border-t pt-4">
            이미 작성된 문서가 있나요?{" "}
            <Link href="/surveys/import" className="font-medium text-foreground underline underline-offset-4">
              마크다운 설문 불러오기
            </Link>
          </Text>
        </VStack>
      </Section>

      <Section>
        <VStack gap={3}>
          <div className="flex items-center justify-between">
            <Heading level={2}>{showArchived ? "보관함" : "내 설문"}</Heading>
            {showArchived ? (
              <Link href="/dashboard" className="text-sm text-muted-foreground hover:underline">
                ← 내 설문
              </Link>
            ) : (
              archivedCount > 0 && (
                <Link
                  href="/dashboard?view=archived"
                  className="text-sm text-muted-foreground hover:underline"
                >
                  보관함 ({archivedCount})
                </Link>
              )
            )}
          </div>
          {mySurveys.length === 0 ? (
            <Text type="large" color="secondary">
              {showArchived
                ? "보관된 설문이 없습니다."
                : "아직 설문이 없습니다. 위에서 목표를 입력해 만들어 보세요."}
            </Text>
          ) : (
            <ul className="flex flex-col divide-y">
              {mySurveys.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <Link href={`/surveys/${s.id}`} className="flex-1 truncate text-base font-medium hover:underline">
                    {s.title || "(제목 없음)"}
                  </Link>
                  <Badge variant={statusVariant(s.status)} className="shrink-0">
                    {statusLabel(s.status)}
                  </Badge>
                  <SurveyRowActions surveyId={s.id} archived={s.archived} />
                </li>
              ))}
            </ul>
          )}
        </VStack>
      </Section>
    </main>
  );
}
