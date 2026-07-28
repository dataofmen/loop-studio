import { notFound } from "next/navigation";
import Link from "next/link";
import { loadOwnedSurvey, surveyCounts } from "@/lib/survey-access";
import { getResponseAnalysis } from "@/lib/analysis";
import { listThemeViews } from "@/lib/themes";
import { listSurveyFeedback } from "@/lib/feedback";
import { listStudyReports } from "@/lib/reports";
import { SurveyHeader } from "../survey-header";
import { AnalysisPanel } from "../analysis-panel";
import { InsightPanel } from "../insight-panel";
import { ThemePanel } from "../theme-panel";
import { ReportPanel } from "../report-panel";
import { FeedbackPanel } from "../feedback-panel";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";

/** Analysis of the simulated responses: distributions, insights, themes, report. */
export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owned = await loadOwnedSurvey(id);
  if (!owned) notFound();
  const { survey } = owned;

  const { syntheticCount } = await surveyCounts(survey.id);
  const [analysis, feedbackEntries, themeViews, studyReports] = await Promise.all([
    syntheticCount > 0 ? getResponseAnalysis(survey.id) : Promise.resolve(null),
    listSurveyFeedback(survey.id),
    listThemeViews(survey.id, owned.workspaceId),
    listStudyReports(survey.id, owned.workspaceId),
  ]);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <SurveyHeader survey={survey} active="results" />

      {syntheticCount === 0 ? (
        <Section variant="muted">
          <Text type="large" color="secondary">
            아직 시뮬레이션 결과가 없습니다.{" "}
            <Link
              href={`/surveys/${survey.id}/simulate`}
              className="font-medium text-foreground underline underline-offset-4"
            >
              시뮬레이션 실행하기
            </Link>
          </Text>
        </Section>
      ) : (
        <>
          {analysis && (
            <AnalysisPanel
              surveyId={survey.id}
              surveyTitle={survey.title ?? "설문"}
              initial={analysis}
            />
          )}
          <InsightPanel surveyId={survey.id} />
          {themeViews.length > 0 && <ThemePanel surveyId={survey.id} initial={themeViews} />}
          <ReportPanel
            surveyId={survey.id}
            responseCount={syntheticCount}
            initial={studyReports}
          />
        </>
      )}

      <FeedbackPanel surveyId={survey.id} initial={feedbackEntries} />
    </main>
  );
}
