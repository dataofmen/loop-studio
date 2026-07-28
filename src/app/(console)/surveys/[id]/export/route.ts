import { NextResponse } from "next/server";
import { loadOwnedSurvey } from "@/lib/survey-access";
import { buildSurveyMarkdownExport } from "@/lib/survey-export";

/**
 * US-005: download a survey as Loop Survey Markdown. Workspace-scoped via
 * loadOwnedSurvey — a non-owned/foreign survey id 404s (and the /surveys
 * middleware already bounces unauthenticated requests to /login).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const owned = await loadOwnedSurvey(id);
  if (!owned) return new NextResponse("Not found", { status: 404 });

  const { filename, markdown } = await buildSurveyMarkdownExport(owned.survey);
  // filename* carries the real (possibly Korean) name; the plain filename is
  // an ASCII fallback for clients that ignore RFC 5987.
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
