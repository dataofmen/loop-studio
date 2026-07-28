"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revealDataDirAction } from "./actions";

/**
 * The whole database is one folder, which makes backup, migration and reset
 * ordinary file operations. Say where it is and offer to open it.
 */
export function DataPanel({ path, sizeMb }: { path: string; sizeMb: number | null }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">데이터 폴더</span>
        <code className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{path}</code>
        <p className="text-sm text-muted-foreground">
          설문·페르소나·시뮬레이션 결과가 모두 이 폴더 안에 있습니다
          {sizeMb != null && ` (현재 ${sizeMb}MB)`}. 백업은 폴더 복사, 다른 컴퓨터로 옮기려면
          붙여넣기, 초기화는 삭제입니다.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await revealDataDirAction();
              setError(r.ok ? null : (r.error ?? "폴더를 열지 못했습니다."));
            })
          }
        >
          폴더 열기
        </Button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  );
}
