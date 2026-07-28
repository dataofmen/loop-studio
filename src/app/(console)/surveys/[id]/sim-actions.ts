"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { surveys, personas, simulationJobs } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { detectCli } from "@/lib/agent-cli";
import { engineLabel, getAgentSettings } from "@/lib/settings";
import { runSimulation } from "@/lib/simulate";

export type SimState = { error?: string; jobId?: string };

async function assertOwner(surveyId: string): Promise<string> {
  const workspaceId = await getWorkspaceId();
  const [s] = await db
    .select({ id: surveys.id })
    .from(surveys)
    .where(and(eq(surveys.id, surveyId), eq(surveys.workspaceId, workspaceId)))
    .limit(1);
  if (!s) throw new Error("not found");
  return workspaceId;
}

export async function startSimulationAction(
  surveyId: string,
  _prev: SimState,
): Promise<SimState> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }

  const settings = await getAgentSettings();
  const cli = await detectCli(settings.cli, settings.cliPath);
  if (!cli.available) {
    return {
      error: `${settings.cli} CLI를 실행할 수 없습니다. 설치 여부와 설정의 실행 파일 경로를 확인하세요.`,
    };
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(personas)
    .where(eq(personas.surveyId, surveyId));
  if (!count) return { error: "먼저 합성 페르소나를 생성하세요." };

  // Prevent a duplicate concurrent run.
  const [running] = await db
    .select({ id: simulationJobs.id })
    .from(simulationJobs)
    .where(and(eq(simulationJobs.surveyId, surveyId), eq(simulationJobs.status, "running")))
    .limit(1);
  if (running) return { jobId: running.id };

  const [job] = await db
    .insert(simulationJobs)
    .values({
      workspaceId,
      surveyId,
      model: engineLabel(settings),
      total: count,
      completed: 0,
      status: "running",
    })
    .returning({ id: simulationJobs.id });

  // Fire-and-forget: the long-running server process keeps this alive.
  void runSimulation(job.id, surveyId);

  return { jobId: job.id };
}

export type SimStatus = {
  status: "running" | "completed" | "failed" | "none";
  total: number;
  completed: number;
  error?: string | null;
};

export async function getSimulationStatus(surveyId: string): Promise<SimStatus> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { status: "none", total: 0, completed: 0 };
  }
  const [job] = await db
    .select()
    .from(simulationJobs)
    .where(eq(simulationJobs.surveyId, surveyId))
    .orderBy(desc(simulationJobs.createdAt))
    .limit(1);
  if (!job) return { status: "none", total: 0, completed: 0 };
  return {
    status: job.status,
    total: job.total,
    completed: job.completed,
    error: job.error,
  };
}

import type { Distribution } from "@/lib/quality";

export type SimulationRun = {
  id: string;
  createdAt: string;
  model: string;
  completed: number;
  total: number;
  summary: Distribution[] | null;
  /** Partial-failure note (skipped personas + last provider error), null when clean. */
  warning: string | null;
};

/** Past completed simulation runs (newest first) with their result snapshots. */
export async function listSimulationRuns(surveyId: string): Promise<SimulationRun[]> {
  try {
    await assertOwner(surveyId);
  } catch {
    return [];
  }
  const rows = await db
    .select()
    .from(simulationJobs)
    .where(and(eq(simulationJobs.surveyId, surveyId), eq(simulationJobs.status, "completed")))
    .orderBy(desc(simulationJobs.createdAt))
    .limit(20);
  return rows.map((j) => ({
    id: j.id,
    createdAt: j.createdAt.toISOString(),
    model: j.model,
    completed: j.completed,
    total: j.total,
    summary: (j.resultSummary as Distribution[] | null) ?? null,
    warning: j.error,
  }));
}
