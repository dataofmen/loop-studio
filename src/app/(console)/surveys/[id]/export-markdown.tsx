"use client";

import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * US-005: export the survey as Loop Survey Markdown — file download (the
 * /export route sets Content-Disposition) + clipboard copy (same route,
 * fetched with the session cookies).
 */
export function ExportMarkdown({ surveyId }: { surveyId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");

  async function copy() {
    try {
      const res = await fetch(`/surveys/${surveyId}/export`);
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setState("copied");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/surveys/${surveyId}/export`}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        마크다운 내보내기 (.md)
      </a>
      <Button type="button" variant="outline" size="sm" onClick={copy}>
        {state === "copied" ? "복사됨 ✓" : state === "error" ? "복사 실패" : "복사"}
      </Button>
    </div>
  );
}
