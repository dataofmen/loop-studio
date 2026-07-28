/**
 * Analysis-ready export — DB-facing assembly (US-402~405).
 *
 * Fetches a survey's questions + simulated responses and renders one of the
 * export artifacts via the pure core (src/lib/export-core.ts). Zip bundles are
 * produced with fflate.
 *
 * The legacy simple CSV (buildResponsesCsv in analysis.ts) stays untouched —
 * format "simple" delegates to it for backward compatibility.
 */

import { and, asc, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db } from "@/db";
import { questions, responses, surveys } from "@/db/schema";
import { openAnswerProbes } from "@/lib/open-answer";
import { buildResponsesCsv } from "@/lib/analysis";
import {
  buildAiReadme,
  buildCodebook,
  buildExportSchema,
  buildSpssSyntax,
  CSV_BOM,
  flattenResponse,
  jsonlRecord,
  longRows,
  LONG_HEADER,
  toCsv,
  type CodebookMeta,
  type ExportQuestion,
  type ExportSchema,
  type ExportValueOptions,
  type FlatCell,
} from "@/lib/export-core";

export type ExportFormat = "wide" | "long" | "ai" | "spss" | "simple";

export interface ExportRequest {
  format: ExportFormat;
  values: "labels" | "codes";
  multi: "expand" | "merge";
}

export interface ExportArtifact {
  filename: string;
  contentType: string;
  body: Uint8Array | string;
}

const META_HEADER = ["response_id", "persona_id", "survey_version", "created_at"] as const;

type ResponseRow = {
  id: string;
  personaId: string | null;
  surveyVersion: number | null;
  createdAt: Date;
  answers: unknown;
  otherTexts: unknown;
};

async function loadData(surveyId: string, req: ExportRequest) {
  const [survey] = await db
    .select({ id: surveys.id, title: surveys.title, goal: surveys.researchGoal })
    .from(surveys)
    .where(eq(surveys.id, surveyId))
    .limit(1);
  if (!survey) throw new Error("설문을 찾을 수 없습니다.");

  const qs = (await db
    .select({
      id: questions.id,
      type: questions.type,
      order: questions.order,
      prompt: questions.prompt,
      config: questions.config,
    })
    .from(questions)
    .where(eq(questions.surveyId, surveyId))
    .orderBy(asc(questions.order))) as unknown as ExportQuestion[];

  const rows = (await db
    .select({
      id: responses.id,
      personaId: responses.personaId,
      surveyVersion: responses.surveyVersion,
      createdAt: responses.createdAt,
      answers: responses.answers,
      otherTexts: responses.otherTexts,
    })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.isSynthetic, true)))
    .orderBy(asc(responses.createdAt))) as ResponseRow[];

  // Probe columns are data-driven: size them to the widest response.
  const maxProbes: Record<string, number> = {};
  for (const q of qs.filter((q) => q.type === "open")) {
    let max = 0;
    for (const r of rows) {
      const n = openAnswerProbes((r.answers as Record<string, unknown>)?.[q.id]).length;
      if (n > max) max = n;
    }
    if (max > 0) maxProbes[q.id] = max;
  }

  const meta: CodebookMeta = {
    surveyId: survey.id,
    title: survey.title ?? "제목 없는 설문",
    goal: survey.goal,
    exportedAt: new Date().toISOString(),
    responseCount: rows.length,
    options: { values: req.values, multi: req.multi },
  };

  return { survey, qs, rows, maxProbes, meta };
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function metaCells(r: ResponseRow): FlatCell[] {
  return [
    r.id,
    r.personaId ?? "",
    r.surveyVersion ?? "",
    r.createdAt.toISOString(),
  ];
}

function wideRows(
  schema: ExportSchema,
  rows: ResponseRow[],
  header: "double" | "single",
): FlatCell[][] {
  const out: FlatCell[][] = [];
  const varNames = schema.variables.map((v) => v.name);
  out.push([...META_HEADER, ...varNames]);
  if (header === "double") {
    out.push([
      "응답 ID", "페르소나 ID", "설문 버전", "생성 시각",
      ...schema.variables.map((v) => v.label),
    ]);
  }
  for (const r of rows) {
    const flat = flattenResponse(schema, {
      answers: (r.answers ?? {}) as Record<string, unknown>,
      otherTexts: r.otherTexts as Record<string, unknown> | null,
    });
    out.push([...metaCells(r), ...varNames.map((n) => flat[n] ?? "")]);
  }
  return out;
}

/** SPSS data.csv uses a reduced meta set matching buildSpssSyntax's spec. */
function spssRows(schema: ExportSchema, rows: ResponseRow[]): FlatCell[][] {
  const out: FlatCell[][] = [];
  const varNames = schema.variables.map((v) => v.name);
  out.push(["response_id", "persona_id", "survey_version", "created_at", ...varNames]);
  for (const r of rows) {
    const flat = flattenResponse(schema, {
      answers: (r.answers ?? {}) as Record<string, unknown>,
      otherTexts: r.otherTexts as Record<string, unknown> | null,
    });
    out.push([
      r.id,
      r.personaId ?? "",
      r.surveyVersion ?? "",
      r.createdAt.toISOString(),
      ...varNames.map((n) => flat[n] ?? ""),
    ]);
  }
  return out;
}

/**
 * Builds the requested export artifact. Caller must have asserted workspace
 * ownership of the survey (route handler does).
 */
export async function buildExport(
  surveyId: string,
  req: ExportRequest,
): Promise<ExportArtifact> {
  const short = surveyId.slice(0, 8);

  if (req.format === "simple") {
    return {
      filename: `loop-responses-${short}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: CSV_BOM + (await buildResponsesCsv(surveyId)),
    };
  }

  const { qs, rows, maxProbes, meta } = await loadData(surveyId, req);
  const valueOpts: ExportValueOptions = { values: req.values, multi: req.multi };

  if (req.format === "wide") {
    const schema = buildExportSchema(qs, valueOpts, maxProbes);
    const csv = CSV_BOM + toCsv(wideRows(schema, rows, "double"));
    return {
      filename: `loop-export-wide-${short}-${stamp()}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: csv,
    };
  }

  if (req.format === "long") {
    // Long rows always carry BOTH code and label — the values option only
    // affects wide layouts.
    const schema = buildExportSchema(qs, { values: "codes", multi: "expand" }, maxProbes);
    const out: FlatCell[][] = [[...LONG_HEADER]];
    for (const r of rows) {
      out.push(
        ...longRows(
          schema,
          {
            responseId: r.id,
            personaId: r.personaId ?? "",
            createdAt: r.createdAt.toISOString(),
          },
          {
            answers: (r.answers ?? {}) as Record<string, unknown>,
            otherTexts: r.otherTexts as Record<string, unknown> | null,
          },
        ),
      );
    }
    return {
      filename: `loop-export-long-${short}-${stamp()}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: CSV_BOM + toCsv(out),
    };
  }

  if (req.format === "ai") {
    const schema = buildExportSchema(qs, { values: "codes", multi: "expand" }, maxProbes);
    const jsonl = rows
      .map((r) =>
        JSON.stringify(
          jsonlRecord(
            schema,
            {
              responseId: r.id,
              personaId: r.personaId ?? "",
              createdAt: r.createdAt.toISOString(),
              surveyVersion: r.surveyVersion,
            },
            {
              answers: (r.answers ?? {}) as Record<string, unknown>,
              otherTexts: r.otherTexts as Record<string, unknown> | null,
            },
          ),
        ),
      )
      .join("\n");
    const codebook = buildCodebook(schema, meta);
    const zipped = zipSync({
      "dataset.jsonl": strToU8(jsonl + "\n"),
      "codebook.json": strToU8(JSON.stringify(codebook, null, 2)),
      "README.md": strToU8(buildAiReadme(meta, schema.variables.length)),
    });
    return {
      filename: `loop-export-ai-${short}-${stamp()}.zip`,
      contentType: "application/zip",
      body: zipped,
    };
  }

  // spss — codes + one-hot expansion, syntax applies labels/missing.
  const schema = buildExportSchema(qs, { values: "codes", multi: "expand" }, maxProbes);
  const dataCsv = toCsv(spssRows(schema, rows)); // no BOM: SPSS GET DATA
  const codebook = buildCodebook(schema, meta);
  const zipped = zipSync({
    "data.csv": strToU8(dataCsv),
    "import.sps": strToU8(buildSpssSyntax(schema, "data.csv")),
    "codebook.json": strToU8(JSON.stringify(codebook, null, 2)),
  });
  return {
    filename: `loop-export-spss-${short}-${stamp()}.zip`,
    contentType: "application/zip",
    body: zipped,
  };
}

/** Parses/validates query params into an ExportRequest (defaults applied). */
export function parseExportRequest(params: URLSearchParams): ExportRequest {
  const format = params.get("format") ?? "wide";
  if (!["wide", "long", "ai", "spss", "simple"].includes(format)) {
    throw new Error(`알 수 없는 포맷: ${format}`);
  }
  const values = params.get("values") === "labels" ? "labels" : "codes";
  const multi = params.get("multi") === "merge" ? "merge" : "expand";
  return {
    format: format as ExportFormat,
    values,
    multi,
  };
}
