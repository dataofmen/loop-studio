/**
 * Template reference remapping (US hardening: 템플릿 참조 재매핑).
 *
 * A question's `config.displayLogic` conditions and `config.optionsFrom` point
 * at OTHER questions by live row id. A template snapshot outlives those rows,
 * so refs are rewritten in two stages (the applyRevision resolve pattern):
 *   1. save time  — live id → snapshot quid, for every referenced question
 *      that is itself in the snapshot (internal ref);
 *   2. seed time  — snapshot quid → freshly-inserted row id.
 * A ref that never maps (the referenced question is outside the snapshot, or a
 * legacy pre-remap template still carrying dead live ids) is DROPPED, and the
 * drop is reported to the caller — silent loss is forbidden.
 *
 * PURE MODULE (no DB / server imports) so the remap rules are unit-testable.
 */

import { normalizeOptionsFrom } from "@/lib/carry-forward";
import type { QConfig, RevisionQuestion } from "@/lib/question-diff";

export type DroppedRefKind = "displayLogic" | "optionsFrom";

/** One reference that could not be remapped and was removed. */
export type DroppedRef = { prompt: string; kind: DroppedRefKind };

/**
 * Rewrites one config's question references through `idMap`. Refs missing from
 * the map are kept verbatim when `dropUnmapped` is false (whole-survey save:
 * they get one more resolution chance at seed time) or removed when true
 * (subset templates and seeding: the target can never exist). Removing every
 * condition removes the whole displayLogic. Never mutates the input.
 */
export function remapConfigRefs(
  config: QConfig,
  idMap: Map<string, string>,
  opts: { dropUnmapped: boolean },
): { config: QConfig; droppedKinds: DroppedRefKind[] } {
  const droppedKinds: DroppedRefKind[] = [];
  const out: QConfig = { ...config };

  const logic = config.displayLogic;
  if (logic && Array.isArray(logic.conditions) && logic.conditions.length > 0) {
    let dropped = false;
    const conditions = logic.conditions.flatMap((c) => {
      const mapped = idMap.get(c.questionId);
      if (mapped) return [{ ...c, questionId: mapped }];
      if (!opts.dropUnmapped) return [c];
      dropped = true;
      return [];
    });
    if (dropped) droppedKinds.push("displayLogic");
    if (conditions.length > 0) out.displayLogic = { ...logic, conditions };
    else delete out.displayLogic;
  }

  const from = normalizeOptionsFrom(config.optionsFrom);
  if (from) {
    const mapped = idMap.get(from.questionId);
    if (mapped) out.optionsFrom = { ...from, questionId: mapped };
    else if (opts.dropUnmapped) {
      droppedKinds.push("optionsFrom");
      delete out.optionsFrom;
    }
  }

  return { config: out, droppedKinds };
}

/**
 * Applies remapConfigRefs across a snapshot, collecting per-question drop
 * notices (keyed by prompt so the notice reads meaningfully in the UI).
 */
export function remapSnapshotRefs(
  snapshot: RevisionQuestion[],
  idMap: Map<string, string>,
  opts: { dropUnmapped: boolean },
): { questions: RevisionQuestion[]; dropped: DroppedRef[] } {
  const dropped: DroppedRef[] = [];
  const questions = snapshot.map((q) => {
    const { config, droppedKinds } = remapConfigRefs(q.config ?? {}, idMap, opts);
    for (const kind of droppedKinds) dropped.push({ prompt: q.prompt, kind });
    return { ...q, config };
  });
  return { questions, dropped };
}

const KIND_LABEL: Record<DroppedRefKind, string> = {
  displayLogic: "표시 조건",
  optionsFrom: "보기 가져오기",
};

/**
 * Human-readable Korean notice for dropped refs (null when nothing dropped),
 * shown after seeding/creation so the loss is never silent.
 */
export function describeDroppedRefs(dropped: DroppedRef[]): string | null {
  if (dropped.length === 0) return null;
  const parts = dropped.map((d) => `"${d.prompt.slice(0, 20)}"의 ${KIND_LABEL[d.kind]}`);
  return `템플릿에 없는 문항을 참조하는 설정이 제외되었습니다: ${parts.join(", ")}. 필요하면 편집기에서 다시 지정하세요.`;
}
