/**
 * Loop Studio data model — survey design, review, preview and synthetic simulation.
 *
 * Response collection was removed when the product became a local desktop tool
 * (see tasks/prd-local-desktop-app.md), so every row in `responses` is
 * synthetic. The `is_synthetic` flag is kept anyway: it is the invariant that
 * stops simulated data from ever being read as ground truth, and every
 * aggregation still asserts it.
 *
 * The app is single-user, but `workspace_id` survives as a stable partition key
 * (always LOCAL_WORKSPACE_ID) so queries, exports and a future multi-user mode
 * don't need reshaping.
 */
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** The single implicit workspace of the local app. */
export const LOCAL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

/** Permanent per-question identifier (Artifact 2 "quid"): stable across edits,
 * reorders, reverts and reuse so version diffs can tell delete/reorder/edit apart.
 *
 * Uses the Web Crypto global rather than node:crypto so this module stays
 * importable from every runtime Next compiles for. */
export function newQuid(): string {
  return "q_" + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

// --- Enums ---

/**
 * Design lifecycle. Without collection there is nothing to "launch":
 *   draft → reviewed (passed the review gate) → simulated (has synthetic data).
 */
export const surveyStatus = pgEnum("survey_status", ["draft", "reviewed", "simulated"]);

export const questionType = pgEnum("question_type", [
  "single",
  "multi",
  "scale",
  "open",
  "ranking",
  "matrix",
  "nps",
]);

// US-901: template reuse granularity — a whole survey, a reusable question
// block (topic/construct set), or a single reusable question.
export const templateKind = pgEnum("template_kind", ["survey", "block", "question"]);

export const simulationStatus = pgEnum("simulation_status", [
  "running",
  "completed",
  "failed",
]);

export const feedbackSentiment = pgEnum("feedback_sentiment", ["up", "down"]);

/** Which locally-installed agent CLI drives generation. */
export const agentCli = pgEnum("agent_cli", ["claude", "cursor"]);

// --- Tables ---

export const surveys = pgTable("surveys", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  title: text("title"),
  researchGoal: text("research_goal").notNull(),
  // Respondent-facing intro/outro copy, shown in preview; null = use defaults.
  welcomeMessage: text("welcome_message"),
  closingMessage: text("closing_message"),
  status: surveyStatus("status").notNull().default("draft"),
  // Soft archive: hidden from the default list but data is preserved.
  archived: boolean("archived").notNull().default(false),
  // Last review result: { report: SurveyReviewReport, at: ISO }. Persisted so
  // the report survives navigation instead of living only in client state.
  lastReview: jsonb("last_review"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questions = pgTable("questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  // Permanent stable identity: survives edits/reorder/reuse.
  quid: text("quid").notNull().$defaultFn(newQuid),
  type: questionType("type").notNull(),
  order: integer("order").notNull(),
  prompt: text("prompt").notNull(),
  // Type-specific config (choices, scale range, display logic, carry-forward…)
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const responses = pgTable("responses", {
  id: uuid("id").defaultRandom().primaryKey(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  // The persona that produced this answer set.
  personaId: uuid("persona_id"),
  // Invariant: simulated data is never ground truth. Always true today.
  isSynthetic: boolean("is_synthetic").notNull().default(true),
  // Map of questionId -> answer value
  answers: jsonb("answers").notNull().default({}),
  // questionId -> free text for the special "other" option. Kept OUTSIDE
  // `answers` so answer values stay pure option labels ("기타") and every
  // label-based consumer (distributions, display-logic, carry-forward,
  // simulation clamps) works unchanged.
  otherTexts: jsonb("other_texts").notNull().default({}),
  // Survey revision version this run was generated against (1 = baseline).
  surveyVersion: integer("survey_version"),
  // survey.updatedAt at generation time: pins the exact content state, since
  // manual edits change wording without bumping the revision version.
  surveyContentAt: timestamp("survey_content_at", { withTimezone: true }),
  // The simulation job that generated this row.
  simulationJobId: uuid("simulation_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personas = pgTable("personas", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  // Source persona uuid from Nemotron-Personas-Korea (attribution + reproducibility)
  sourceUuid: text("source_uuid"),
  // Structured demographic attributes (sex, age, occupation, province, ocean…)
  attributes: jsonb("attributes").notNull().default({}),
  // Narrative profile text used for LLM roleplay during simulation
  profile: text("profile").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const simulationJobs = pgTable("simulation_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  status: simulationStatus("status").notNull().default("running"),
  // Engine label at run time, e.g. "claude · sonnet".
  model: text("model").notNull(),
  total: integer("total").notNull().default(0),
  completed: integer("completed").notNull().default(0),
  // Aggregated per-question distribution snapshot at completion — lets a past
  // run be re-reviewed without retaining its raw synthetic responses.
  resultSummary: jsonb("result_summary"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Versioned survey-question revisions. Each applied AI revision (or revert)
// snapshots the resulting question set, so history is version-controlled and
// any prior version can be restored.
export const surveyRevisions = pgTable("survey_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  // Monotonic per-survey version number (v1 = baseline).
  version: integer("version").notNull(),
  // Why this version exists: the human feedback / AI rationale / revert note.
  reason: text("reason").notNull(),
  // User-given checkpoint name. Labeled versions are shown prominently and are
  // never coalesced over by subsequent manual edits.
  label: text("label"),
  // Full question set at this version: [{ type, order, prompt, config }]
  questionsSnapshot: jsonb("questions_snapshot").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// AI revision proposals (persisted): every proposal survives apply/reject so
// unapplied items can be reviewed and applied later ("지난 제안").
export const surveyProposals = pgTable("survey_proposals", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  // The human feedback (or review issues) that produced this proposal.
  feedback: text("feedback").notNull(),
  rationale: text("rationale").notNull().default(""),
  proposedSnapshot: jsonb("proposed_snapshot").notNull().default([]),
  // Per-question outcome at the last action: { [quid]: "applied" | "skipped" }.
  decisions: jsonb("decisions").notNull().default({}),
  // pending → applied | partial | rejected (all remain reopenable).
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * App-wide settings — a single row (id = 1) since the app is single-user.
 *
 * There is no API key column by design: generation runs through a locally
 * installed agent CLI that already holds the user's credentials.
 */
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  cli: agentCli("cli").notNull().default("claude"),
  model: text("model"),
  /** Absolute path override when the CLI isn't discoverable on PATH. */
  cliPath: text("cli_path"),
  /** Concurrent CLI processes during simulation. */
  concurrency: integer("concurrency").notNull().default(4),
  /** Personas answered per CLI call. 1 = maximum independence, slowest. */
  batchSize: integer("batch_size").notNull().default(5),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Human feedback on AI-generated content (questions / summaries). Accumulates
// into workspace context and is injected into later generations.
export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id").references(() => surveys.id, {
    onDelete: "cascade",
  }),
  // Which AI-generated artifact this targets: 'questions' | 'insight' | ...
  targetType: text("target_type").notNull(),
  // Optional sub-reference (e.g. a specific question id)
  targetRef: text("target_ref"),
  sentiment: feedbackSentiment("sentiment").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Reusable question-set templates. Saving a survey's current questions here
// preserves quid + option ids so a template can seed a new survey or be
// inserted into an existing one.
export const templates = pgTable("templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  // Reuse granularity: 'survey' = full snapshot, 'block' = topic/construct
  // question set, 'question' = single reusable item.
  kind: templateKind("kind").notNull().default("survey"),
  // Optional AI-generated one-line summary.
  aiSummary: text("ai_summary"),
  // Full question set snapshot: [{ quid, type, order, prompt, config }]
  questionsSnapshot: jsonb("questions_snapshot").notNull().default([]),
  // Classification for browse/search: { construct?, topic? }
  metaTags: jsonb("meta_tags").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Controlled vocabulary of constructs. Free-text question `meta.construct`
 * values resolve against this dictionary (exact name/alias match → create) so
 * the same concept always joins across surveys. `name` is the canonical label;
 * `aliases` holds absorbed variants.
 *
 * Matching is exact/alias only — the embedding path went away with the local
 * Ollama dependency (see src/lib/construct-match.ts).
 */
export const constructs = pgTable(
  "constructs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    aliases: jsonb("aliases").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("constructs_workspace_id_name_unique").on(t.workspaceId, t.name)],
);

/** Cached open-text theme extraction per question. Regenerated when the
 * response count drifts. themes jsonb: [{ name, summary, responseIds: uuid[] }] —
 * responseIds are the evidence links back to the underlying responses
 * (anti-hallucination). */
export const openTextThemes = pgTable(
  "open_text_themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    themes: jsonb("themes").notNull().default([]),
    responseCount: integer("response_count").notNull().default(0),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("open_text_themes_question_id_unique").on(t.questionId)],
);

/** AI study reports — snapshots at generation time (re-viewable history; a new
 * generation inserts a new row, never overwrites). report jsonb is the
 * structured StudyReport (see src/lib/reports.ts). */
export const studyReports = pgTable("study_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  surveyId: uuid("survey_id")
    .notNull()
    .references(() => surveys.id, { onDelete: "cascade" }),
  report: jsonb("report").notNull(),
  responseCount: integer("response_count").notNull().default(0),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
