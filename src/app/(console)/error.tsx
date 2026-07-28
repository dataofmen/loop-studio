"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the console.
 *
 * Without one, any exception that escapes a client component replaces the whole
 * app with Next's bare "Application error: a client-side exception has
 * occurred" — no context, no way back. The most likely source is a server
 * action that rejects instead of returning its `{ error }` shape: these actions
 * run the agent CLI and can take minutes, which is plenty of time for a
 * connection to drop.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[console] unhandled error:", error);
  }, [error]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 py-12">
      <h1 className="text-xl font-semibold">화면을 표시하지 못했습니다</h1>
      <p className="text-sm text-muted-foreground">
        작업 중 예기치 못한 오류가 발생했습니다. 저장된 데이터는 그대로입니다 — 다시 시도하거나
        대시보드로 돌아가세요.
      </p>
      <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs text-muted-foreground">
        {error.message || "알 수 없는 오류"}
        {error.digest ? `\n(digest: ${error.digest})` : ""}
      </pre>
      <div className="flex gap-2">
        <Button onClick={reset}>다시 시도</Button>
        <Button variant="outline" onClick={() => (window.location.href = "/dashboard")}>
          대시보드로
        </Button>
      </div>
    </main>
  );
}
