import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Heading } from "@astryxdesign/core/Text";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/survey-status";
import { SurveyTabs, type TabKey } from "./tabs";

/** Shared header (breadcrumb + title + status + pipeline tabs) for every
 * survey sub-page — keeps the pipeline stages visually identical. */
export function SurveyHeader({
  survey,
  active,
}: {
  survey: { id: string; title: string | null; status: string };
  active: TabKey;
}) {
  const title = survey.title ?? "제목 없음";
  return (
    <div className="flex flex-col gap-3">
      <Breadcrumbs>
        <BreadcrumbItem href="/dashboard">대시보드</BreadcrumbItem>
        <BreadcrumbItem isCurrent>{title}</BreadcrumbItem>
      </Breadcrumbs>
      <div className="flex items-center gap-2">
        <Heading level={1}>{title}</Heading>
        <Badge variant={survey.status === "simulated" ? "default" : "secondary"}>
          {statusLabel(survey.status)}
        </Badge>
      </div>
      <SurveyTabs surveyId={survey.id} active={active} />
    </div>
  );
}
