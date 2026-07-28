/**
 * Survey status model — labels and the allowed transition table. Pure.
 *
 * The app designs and simulates surveys; it never collects responses, so there
 * is no publish/pause/close axis. Status tracks how far a survey has moved
 * through the design pipeline:
 *
 *   draft → reviewed  : passed the review gate (AI + structural checks)
 *   reviewed → simulated : a simulation run completed against it
 *
 * Editing questions sends a survey back to `draft`, because a review verdict
 * (and any simulation) describes the content that existed when it ran.
 */

export type SurveyStatus = "draft" | "reviewed" | "simulated";

export const STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: "초안",
  reviewed: "검토 완료",
  simulated: "시뮬 완료",
};

/** Display label for a raw status string (unknown values echo through). */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status as SurveyStatus] ?? status;
}

/**
 * Allowed transitions:
 * - draft → reviewed        : the review gate passed
 * - draft|reviewed → simulated : a simulation run completed
 * - reviewed|simulated → draft : content was edited again
 *
 * `simulated → reviewed` is absent on purpose: re-running the gate on
 * already-simulated content leaves it simulated, since the synthetic data is
 * still valid for that content.
 */
const ALLOWED: Record<SurveyStatus, SurveyStatus[]> = {
  draft: ["reviewed", "simulated"],
  reviewed: ["simulated", "draft"],
  simulated: ["draft"],
};

export function canTransition(from: SurveyStatus, to: SurveyStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}
