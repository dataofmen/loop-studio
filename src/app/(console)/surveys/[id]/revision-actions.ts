"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { surveys } from "@/db/schema";
import { getWorkspaceId } from "@/lib/auth";
import { recordFeedback } from "@/lib/feedback";
import { lintProposal } from "@/lib/logic-lint";
import {
  proposeRevision,
  applyRevision,
  compareRevisions,
  listProposals,
  markProposalOutcome,
  reopenProposal,
  revertToRevision,
  saveNamedVersion,
  saveProposal,
  setRevisionLabel,
  type ProposalDecisions,
  type ProposalListItem,
  type QuestionChangeDetail,
  type RevisionQuestion,
  type QuestionDiff,
} from "@/lib/revisions";

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

export type ProposalState = {
  error?: string;
  rationale?: string;
  current?: RevisionQuestion[];
  proposed?: RevisionQuestion[];
  diff?: QuestionDiff;
  feedback?: string;
  /** Persisted proposal row — every proposal is kept for later reopen. */
  proposalId?: string;
  /** Unresolved display-logic errors in the proposal (show before apply). */
  lintWarnings?: string[];
  /** Live question id → prompt for rendering condition references. */
  questionPrompts?: Record<string, string>;
};

/** AI proposes a revised question set from feedback. Nothing is applied yet. */
export async function proposeRevisionAction(
  surveyId: string,
  feedback: string,
): Promise<ProposalState> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  if (feedback.trim().length < 3) return { error: "수정 요청 피드백을 입력해 주세요." };
  try {
    const workspaceId = await getWorkspaceId();
    const { rationale, questions, current, diff, lintWarnings, questionPrompts } = await proposeRevision(surveyId, feedback);
    // Persist immediately — proposals survive apply/reject for later reopen.
    let proposalId: string | undefined;
    try {
      proposalId = await saveProposal(surveyId, workspaceId, feedback, rationale, questions);
    } catch {
      // best-effort: an unsaved proposal is still fully usable this session
    }
    return { rationale, current, proposed: questions, diff, feedback, proposalId, lintWarnings, questionPrompts };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "제안 생성 실패" };
  }
}

/** Human approves the proposal → apply + version it. Also records the feedback. */
export async function applyRevisionAction(
  surveyId: string,
  proposed: RevisionQuestion[],
  feedback: string,
  outcome?: { proposalId?: string; decisions?: ProposalDecisions; partial?: boolean },
): Promise<{ error?: string; version?: number }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const version = await applyRevision(surveyId, workspaceId, proposed, feedback);
    if (outcome?.proposalId) {
      await markProposalOutcome(
        outcome.proposalId,
        workspaceId,
        outcome.partial ? "partial" : "applied",
        outcome.decisions ?? {},
      ).catch(() => {});
    }
    // Feed the accepted feedback into future generations too (US-014 synergy).
    await recordFeedback({
      workspaceId,
      surveyId,
      targetType: "questions",
      sentiment: "down",
      comment: feedback,
    });
    revalidatePath(`/surveys/${surveyId}`);
    return { version };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "적용 실패" };
  }
}

export type CompareState = {
  error?: string;
  from?: number;
  to?: number;
  details?: QuestionChangeDetail[];
  fromSnapshot?: RevisionQuestion[];
  toSnapshot?: RevisionQuestion[];
  questionPrompts?: Record<string, string>;
};

/** Compares two versions at the field/option level for the diff viewer (US-006). */
export async function compareRevisionsAction(
  surveyId: string,
  fromVersion: number,
  toVersion: number,
): Promise<CompareState> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  if (fromVersion === toVersion) return { error: "서로 다른 두 버전을 선택해 주세요." };
  try {
    // Always diff older → newer regardless of pick order.
    const [lo, hi] = fromVersion < toVersion ? [fromVersion, toVersion] : [toVersion, fromVersion];
    return await compareRevisions(surveyId, lo, hi);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "비교 실패" };
  }
}

/** Saves the current questions as a user-named checkpoint version. */
export async function saveNamedVersionAction(
  surveyId: string,
  name: string,
): Promise<{ error?: string; version?: number }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const version = await saveNamedVersion(surveyId, workspaceId, name);
    revalidatePath(`/surveys/${surveyId}`);
    return { version };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "버전 저장 실패" };
  }
}

/** Names (or clears the name of) an existing version. */
export async function nameRevisionAction(
  surveyId: string,
  version: number,
  name: string | null,
): Promise<{ error?: string }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    await setRevisionLabel(surveyId, workspaceId, version, name);
    revalidatePath(`/surveys/${surveyId}`);
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "이름 저장 실패" };
  }
}

/** Marks a proposal rejected — it stays in "지난 제안" for later reopen. */
export async function rejectProposalAction(
  surveyId: string,
  proposalId: string,
): Promise<{ error?: string }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    await markProposalOutcome(proposalId, workspaceId, "rejected", {});
    revalidatePath(`/surveys/${surveyId}`);
    return {};
  } catch (e) {
    return { error: e instanceof Error ? e.message : "기록 실패" };
  }
}

/** Reopens a stored proposal, re-diffed against the CURRENT questions. */
export async function reopenProposalAction(
  surveyId: string,
  proposalId: string,
): Promise<ProposalState> {
  try {
    await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const workspaceId = await getWorkspaceId();
    const r = await reopenProposal(proposalId, workspaceId);
    if (!r || r.surveyId !== surveyId) return { error: "제안을 찾을 수 없습니다." };
    return {
      rationale: r.rationale,
      current: r.current,
      proposed: r.proposed,
      diff: r.diff,
      feedback: r.feedback,
      proposalId,
      lintWarnings: lintProposal(r.proposed).map(
        (w) => `제안 ${w.questionId}번 문항: ${w.message}`,
      ),
      questionPrompts: r.questionPrompts,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "다시 열기 실패" };
  }
}

/** Recent proposals (newest first) for the "지난 제안" list. */
export async function listProposalsAction(surveyId: string): Promise<ProposalListItem[]> {
  try {
    const workspaceId = await assertOwner(surveyId);
    return await listProposals(surveyId, workspaceId);
  } catch {
    return [];
  }
}

export async function revertRevisionAction(
  surveyId: string,
  targetVersion: number,
): Promise<{ error?: string; version?: number }> {
  let workspaceId: string;
  try {
    workspaceId = await assertOwner(surveyId);
  } catch {
    return { error: "설문을 찾을 수 없습니다." };
  }
  try {
    const version = await revertToRevision(surveyId, workspaceId, targetVersion);
    revalidatePath(`/surveys/${surveyId}`);
    return { version };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "되돌리기 실패" };
  }
}
