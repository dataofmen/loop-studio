// Pure (no DB/IO) template summarization + filtering, so the client library UI
// (US-009) can import these without pulling `@/db` into the client bundle.
// `templates.ts` re-exports these for server-side callers.
import { canonicalConstructName, constructKey } from "@/lib/construct-match";
import type { QuestionType, RevisionQuestion } from "@/lib/question-diff";

export type TemplateMetaTags = {
  construct?: string;
  /** Dictionary id (US-006) of the dominant construct, when it is resolved. */
  constructId?: string;
  topic?: string;
  /**
   * US-908: id of the survey template this one was auto-derived from when a
   * survey save is decomposed into block/question templates. Present only on
   * derived templates; drives the "설문 분해" provenance badge.
   */
  derivedFrom?: string;
};

/**
 * Derives a template's classification tags (US-009 browse/search) from the
 * dominant construct/topic across its question set's config.meta. Values are
 * grouped by normalized key (US-007) so spelling variants of one concept
 * count together; a dictionary-linked member (meta.constructId) lends the
 * group its canonical display form and id. Free-text-only metas keep their
 * own wording (backward compatible). Pure — no DB/IO.
 */
export function deriveMetaTags(snapshot: RevisionQuestion[]): TemplateMetaTags {
  type Group = { display: string; constructId?: string; count: number };
  const dominant = (key: "construct" | "topic"): Group | undefined => {
    const groups = new Map<string, Group>();
    for (const q of snapshot) {
      const meta = q.config.meta;
      const text = canonicalConstructName(meta?.[key]);
      if (!text) continue;
      const k = constructKey(text);
      let g = groups.get(k);
      if (!g) {
        g = { display: text, count: 0 };
        groups.set(k, g);
      }
      g.count++;
      // A dictionary-resolved member wins the display form: its text is the
      // canonical name (withResolvedConstruct writes them together).
      if (key === "construct" && meta?.constructId && !g.constructId) {
        g.constructId = meta.constructId;
        g.display = text;
      }
    }
    let best: Group | undefined;
    for (const g of groups.values()) {
      if (!best || g.count > best.count) best = g;
    }
    return best;
  };
  const tags: TemplateMetaTags = {};
  const construct = dominant("construct");
  if (construct) {
    tags.construct = construct.display;
    if (construct.constructId) tags.constructId = construct.constructId;
  }
  const topic = dominant("topic");
  if (topic) tags.topic = topic.display;
  return tags;
}

/**
 * US-902: a structured, at-a-glance description of what a template contains —
 * question-type composition, scale ranges, and the concepts it measures. Pure
 * derivation from the snapshot; drives the informative library cards (US-903).
 */
export type StructuredSummary = {
  questionCount: number;
  /** Count per question type, in the snapshot's type order of first appearance. */
  typeCounts: { type: QuestionType; count: number }[];
  /** Distinct scale ranges present (e.g. 1–5, 0–10), deduped. */
  scales: { min: number; max: number }[];
  /** Distinct measured constructs, most frequent first. */
  constructs: string[];
  /** Distinct topics, most frequent first. */
  topics: string[];
};

const QUESTION_TYPE_ORDER: QuestionType[] = [
  "single",
  "multi",
  "scale",
  "nps",
  "ranking",
  "matrix",
  "open",
];

/** Distinct meta values (construct|topic) across a snapshot, most frequent first. */
function frequentMetaValues(snapshot: RevisionQuestion[], key: "construct" | "topic"): string[] {
  const groups = new Map<string, { display: string; count: number }>();
  for (const q of snapshot) {
    const text = canonicalConstructName(q.config.meta?.[key]);
    if (!text) continue;
    const k = constructKey(text);
    const g = groups.get(k) ?? { display: text, count: 0 };
    g.count++;
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).map((g) => g.display);
}

/** Pure — structured composition of a question snapshot (US-902). */
export function structuredSummary(snapshot: RevisionQuestion[]): StructuredSummary {
  const counts = new Map<QuestionType, number>();
  const scaleKeys = new Map<string, { min: number; max: number }>();
  for (const q of snapshot) {
    counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
    const scale = q.config.scale;
    if ((q.type === "scale" || q.type === "nps") && scale) {
      scaleKeys.set(`${scale.min}-${scale.max}`, { min: scale.min, max: scale.max });
    }
  }
  const typeCounts = QUESTION_TYPE_ORDER.filter((t) => counts.has(t)).map((type) => ({
    type,
    count: counts.get(type)!,
  }));
  return {
    questionCount: snapshot.length,
    typeCounts,
    scales: [...scaleKeys.values()].sort((a, b) => a.min - b.min || a.max - b.max),
    constructs: frequentMetaValues(snapshot, "construct"),
    topics: frequentMetaValues(snapshot, "topic"),
  };
}

/**
 * US-908: one reuse unit produced by decomposing a survey snapshot when a
 * survey template is saved. `quids` are the ORIGINAL snapshot quids that fall
 * into this unit, in snapshot order (the caller re-mints fresh quids per unit).
 */
export type DecompositionUnit = {
  kind: "block" | "question";
  name: string;
  quids: string[];
  /** For blocks: the construct display name (also the unit name) + its dict id. */
  construct?: string;
  constructId?: string;
};

/**
 * Pure (US-908) — plans how a survey snapshot decomposes into smaller reusable
 * units when saved as a template. Questions sharing a construct (≥2 members)
 * form a `block` named after that construct; every other question (constructless
 * or a lone construct member) becomes its own `question` unit named after its
 * prompt. The result PARTITIONS the snapshot — each question lands in exactly
 * one unit, no duplication — and units are ordered by their first member's
 * snapshot position for a stable, readable derivation.
 */
export function planDecomposition(snapshot: RevisionQuestion[]): DecompositionUnit[] {
  const ordered = snapshot.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  type Group = { display: string; constructId?: string; quids: string[]; first: number };
  const groups = new Map<string, Group>();
  const singles: { name: string; quid: string; first: number }[] = [];
  ordered.forEach((q, i) => {
    const construct = canonicalConstructName(q.config.meta?.construct);
    if (!construct) {
      singles.push({ name: q.prompt.slice(0, 40), quid: q.quid, first: i });
      return;
    }
    const k = constructKey(construct);
    let g = groups.get(k);
    if (!g) {
      g = { display: construct, quids: [], first: i };
      groups.set(k, g);
    }
    g.quids.push(q.quid);
    if (q.config.meta?.constructId && !g.constructId) {
      g.constructId = q.config.meta.constructId;
      g.display = construct;
    }
  });
  const units: (DecompositionUnit & { first: number })[] = [];
  for (const g of groups.values()) {
    if (g.quids.length >= 2) {
      units.push({
        kind: "block",
        name: g.display,
        quids: g.quids,
        construct: g.display,
        constructId: g.constructId,
        first: g.first,
      });
    } else {
      // Lone construct member: a "block" of one reads as a single question.
      const q = ordered.find((x) => x.quid === g.quids[0])!;
      units.push({ kind: "question", name: q.prompt.slice(0, 40), quids: [q.quid], first: g.first });
    }
  }
  for (const s of singles) {
    units.push({ kind: "question", name: s.name, quids: [s.quid], first: s.first });
  }
  return units
    .sort((a, b) => a.first - b.first)
    .map(({ first: _first, ...u }) => u);
}

/** A template row summarized for the library UI (US-009): counts + preview. */
export type TemplateSummary = {
  id: string;
  name: string;
  description: string | null;
  /** US-901: reuse granularity. */
  kind: "survey" | "block" | "question";
  /** US-907: operator-generated one-line summary, when present. */
  aiSummary: string | null;
  tags: TemplateMetaTags;
  questionCount: number;
  /**
   * Question prompts with their type, in snapshot order, for an at-a-glance
   * composition preview (US-903). Capped at `previewCount` so the payload stays
   * bounded; the card shows the remainder count when the snapshot is longer.
   */
  preview: { type: QuestionType; prompt: string }[];
  /** US-902: structured composition for informative cards. */
  structured: StructuredSummary;
  createdAt: Date;
};

/** A stored template row (as returned by the DB) for summarization. */
export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  kind?: "survey" | "block" | "question";
  aiSummary?: string | null;
  questionsSnapshot: unknown;
  metaTags: unknown;
  createdAt: Date;
};

/** Pure — turns a stored template row into a library summary (count + preview). */
export function summarizeTemplate(row: TemplateRow, previewCount = 30): TemplateSummary {
  const snapshot = Array.isArray(row.questionsSnapshot)
    ? (row.questionsSnapshot as RevisionQuestion[])
    : [];
  const tagsRaw = (row.metaTags ?? {}) as Record<string, unknown>;
  const tags: TemplateMetaTags = {};
  if (typeof tagsRaw.construct === "string" && tagsRaw.construct) {
    tags.construct = tagsRaw.construct;
    if (typeof tagsRaw.constructId === "string" && tagsRaw.constructId) {
      tags.constructId = tagsRaw.constructId;
    }
  }
  if (typeof tagsRaw.topic === "string" && tagsRaw.topic) tags.topic = tagsRaw.topic;
  if (typeof tagsRaw.derivedFrom === "string" && tagsRaw.derivedFrom) {
    tags.derivedFrom = tagsRaw.derivedFrom;
  }
  const preview = snapshot
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((q) => typeof q.prompt === "string" && q.prompt.length > 0)
    .slice(0, previewCount)
    .map((q) => ({ type: q.type, prompt: q.prompt }));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind ?? "survey",
    aiSummary: row.aiSummary ?? null,
    tags,
    questionCount: snapshot.length,
    preview,
    structured: structuredSummary(snapshot),
    createdAt: row.createdAt,
  };
}

export type TemplateFilter = { query?: string; construct?: string; topic?: string };

/**
 * Pure — filters summaries by a free-text query (name/description/tags/preview)
 * and construct/topic tag match. Tag matching compares normalized keys
 * (US-007) so a canonical dropdown value also matches templates whose stored
 * tag is a legacy spelling variant of the same concept.
 */
export function filterTemplateSummaries(
  list: TemplateSummary[],
  filter: TemplateFilter,
): TemplateSummary[] {
  const q = filter.query?.trim().toLowerCase();
  return list.filter((t) => {
    if (filter.construct && constructKey(t.tags.construct) !== constructKey(filter.construct)) {
      return false;
    }
    if (filter.topic && constructKey(t.tags.topic) !== constructKey(filter.topic)) return false;
    if (q) {
      const hay = [
        t.name,
        t.description ?? "",
        t.tags.construct ?? "",
        t.tags.topic ?? "",
        ...t.preview.map((p) => p.prompt),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Distinct, sorted construct/topic tag values across the given summaries,
 * deduped by normalized key (US-007) so the filter dropdowns show one entry
 * per concept. A dictionary-resolved tag (constructId) wins the display form
 * over legacy free-text variants of the same key.
 */
export function collectTagValues(list: TemplateSummary[]): {
  constructs: string[];
  topics: string[];
} {
  const constructs = new Map<string, { display: string; resolved: boolean }>();
  const topics = new Map<string, string>();
  for (const t of list) {
    if (t.tags.construct) {
      const key = constructKey(t.tags.construct);
      const prev = constructs.get(key);
      const resolved = Boolean(t.tags.constructId);
      if (!prev || (resolved && !prev.resolved)) {
        constructs.set(key, { display: t.tags.construct, resolved });
      }
    }
    if (t.tags.topic) {
      const key = constructKey(t.tags.topic);
      if (!topics.has(key)) topics.set(key, t.tags.topic);
    }
  }
  return {
    constructs: [...constructs.values()].map((v) => v.display).sort(),
    topics: [...topics.values()].sort(),
  };
}
