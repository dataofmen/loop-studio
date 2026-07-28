import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { personas } from "@/db/schema";
import { populationMeta } from "@/lib/population";
import { corpusAvailable } from "@/lib/persona-corpus";
import { engineLabel, getAgentSettings } from "@/lib/settings";
import { loadOwnedSurvey, surveyCounts } from "@/lib/survey-access";
import { getSimulationStatus, listSimulationRuns } from "../sim-actions";
import { SurveyHeader } from "../survey-header";
import { PersonaPanel } from "../persona-panel";
import { SimulationPanel } from "../sim-panel";
import { QualityPanel } from "../quality-panel";
import { RunHistoryPanel } from "../run-history-panel";
import { normalizeOcean, oceanLabel } from "@/lib/ocean";

export default async function SimulatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const owned = await loadOwnedSurvey(id);
  if (!owned) notFound();
  const { survey } = owned;

  const [{ syntheticCount }, personaRows, simStatus, runs, llm] = await Promise.all([
    surveyCounts(survey.id),
    db.select({ attributes: personas.attributes }).from(personas).where(eq(personas.surveyId, survey.id)),
    getSimulationStatus(survey.id),
    listSimulationRuns(survey.id),
    getAgentSettings(),
  ]);

  const bySex = new Map<string, number>();
  const byProvince = new Map<string, number>();
  // US-307: OCEAN disposition tallies (personas predating OCEAN just don't count)
  const oceanTally = new Map<string, number>();
  let oceanCount = 0;
  for (const p of personaRows) {
    const a = (p.attributes ?? {}) as { sex?: string; province?: string; ocean?: unknown };
    if (a.sex) bySex.set(a.sex, (bySex.get(a.sex) ?? 0) + 1);
    if (a.province) byProvince.set(a.province, (byProvince.get(a.province) ?? 0) + 1);
    const ocean = normalizeOcean(a.ocean);
    if (ocean) {
      oceanCount++;
      const label = oceanLabel(ocean);
      if (label) for (const part of label.split(" ")) oceanTally.set(part, (oceanTally.get(part) ?? 0) + 1);
    }
  }
  const topOcean = [...oceanTally.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6);
  const topProvinces = [...byProvince.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);

  const popMeta = populationMeta();
  const engine = engineLabel(llm);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <SurveyHeader survey={survey} active="simulate" />

      <PersonaPanel
        surveyId={survey.id}
        existingCount={personaRows.length}
        scopes={popMeta?.scopes ?? []}
        baseMonth={popMeta?.baseMonth ?? null}
        corpusInstalled={corpusAvailable()}
      />

      {personaRows.length > 0 && (
        <div className="rounded-xl border p-4 text-sm">
          <p className="mb-2 font-medium">표본 분포 ({personaRows.length}명)</p>
          <p className="text-gray-600">성별: {[...bySex.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
          {oceanCount > 0 && (
            <p className="text-gray-600">
              성격(OCEAN, {oceanCount}명): {topOcean.map(([k, v]) => `${k} ${v}`).join(" · ")}
            </p>
          )}
          <p className="text-gray-600">
            지역(상위): {topProvinces.map(([k, v]) => `${k} ${v}`).join(" · ")}
          </p>
        </div>
      )}

      {personaRows.length > 0 && (
        <SimulationPanel
          surveyId={survey.id}
          personaCount={personaRows.length}
          initialStatus={simStatus}
          simModel={engine}
        />
      )}

      {syntheticCount > 0 && <QualityPanel surveyId={survey.id} />}

      <RunHistoryPanel runs={runs} />
    </main>
  );
}
