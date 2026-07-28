/**
 * Download endpoint for analysis-ready exports.
 *
 * GET /api/surveys/:id/export?format=wide|long|ai|spss|simple
 *   &values=codes|labels &multi=expand|merge
 *
 * A route handler (not a server action) so the browser gets a real download
 * with Content-Disposition — and large payloads skip the action serializer.
 */

import { NextRequest, NextResponse } from "next/server";
import { loadOwnedSurvey } from "@/lib/survey-access";
import { buildExport, parseExportRequest } from "@/lib/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const owned = await loadOwnedSurvey(id);
  if (!owned) return NextResponse.json({ error: "설문을 찾을 수 없습니다." }, { status: 404 });

  let exportReq;
  try {
    exportReq = parseExportRequest(req.nextUrl.searchParams);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "잘못된 요청입니다." },
      { status: 400 },
    );
  }

  try {
    const artifact = await buildExport(id, exportReq);
    const body =
      typeof artifact.body === "string" ? artifact.body : Buffer.from(artifact.body);
    return new NextResponse(body, {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "내보내기에 실패했습니다." },
      { status: 500 },
    );
  }
}
