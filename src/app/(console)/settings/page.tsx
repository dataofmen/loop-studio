import { Section } from "@astryxdesign/core/Section";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { getAgentSettings } from "@/lib/settings";
import { dataDirAction, detectClisAction } from "./actions";
import { DataPanel } from "./data-panel";
import { SettingsForm } from "./settings-form";

export default async function SettingsPage() {
  const [initial, statuses, data] = await Promise.all([
    getAgentSettings(),
    detectClisAction(),
    dataDirAction(),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6">
      <VStack gap={1}>
        <Heading level={1}>설정</Heading>
        <Text type="large" color="secondary">
          문항 설계·검토·분석과 시뮬레이션이 사용할 AI 도구를 지정합니다. API 키는 필요하지 않습니다 —
          이미 로그인된 로컬 CLI를 그대로 사용합니다.
        </Text>
      </VStack>

      <Section>
        <SettingsForm initial={initial} initialStatuses={statuses} />
      </Section>

      <Section variant="muted">
        <DataPanel path={data.path} sizeMb={data.sizeMb} />
      </Section>
    </main>
  );
}
