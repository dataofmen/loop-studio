"use client";

import { TabList, Tab } from "@astryxdesign/core/TabList";

export type TabKey = "overview" | "design" | "simulate" | "results";

const TABS: { key: TabKey; label: string; path: (id: string) => string }[] = [
  { key: "overview", label: "개요", path: (id) => `/surveys/${id}` },
  { key: "design", label: "① 설계", path: (id) => `/surveys/${id}/edit` },
  { key: "simulate", label: "② 시뮬레이션", path: (id) => `/surveys/${id}/simulate` },
  { key: "results", label: "③ 결과 분석", path: (id) => `/surveys/${id}/results` },
];

/** Pipeline-stage tab navigation shared across the survey sub-pages. Each
 * tab is a real route (not a client-side panel switch), so onChange is a
 * no-op — navigation happens via Tab's href. */
export function SurveyTabs({ surveyId, active }: { surveyId: string; active: TabKey }) {
  return (
    <TabList value={active} onChange={() => {}} hasDivider>
      {TABS.map((t) => (
        <Tab key={t.key} value={t.key} label={t.label} href={t.path(surveyId)} />
      ))}
    </TabList>
  );
}
