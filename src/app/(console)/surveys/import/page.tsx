
import { ImportForm } from "./import-form";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Section } from "@astryxdesign/core/Section";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

export default async function ImportSurveyPage() {

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Breadcrumbs>
          <BreadcrumbItem href="/dashboard">대시보드</BreadcrumbItem>
          <BreadcrumbItem isCurrent>마크다운 설문 불러오기</BreadcrumbItem>
        </Breadcrumbs>
        <Heading level={1}>마크다운 설문 불러오기</Heading>
      </div>

      <Section>
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={2}>Loop Survey Markdown</Heading>
            <Text type="large" color="secondary">
              문서 한 장을 붙여넣거나 업로드하면 새 설문이 생성됩니다. 오류가 하나라도 있으면
              설문은 만들어지지 않고 라인별 오류 목록이 표시됩니다.
            </Text>
          </VStack>
          <ImportForm />
        </VStack>
      </Section>
    </main>
  );
}
