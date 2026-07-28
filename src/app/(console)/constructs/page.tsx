import { getWorkspaceId } from "@/lib/auth";
import { listWorkspaceConstructs } from "@/lib/constructs";
import { ConstructManager } from "./construct-manager";

/** Construct vocabulary curation — list / rename / merge (US-008). */
export default async function ConstructsPage() {
  const workspaceId = await getWorkspaceId();
  const items = await listWorkspaceConstructs(workspaceId);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">구성 개념 사전</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          설문이 달라도 같은 구성 개념(construct)을 하나로 묶는 워크스페이스 기준 사전입니다. 템플릿
          검색·필터와 AI 메타데이터 추론이 이 사전을 재사용하고, 각 항목의 &ldquo;결과
          보기&rdquo;에서 개념 단위 통합 결과(설문 간 추세, 실제 응답 기준)를 확인할 수
          있습니다. &ldquo;문항 N개&rdquo;를 펼쳐 구성 문항을 확인하고, 표기가 갈라진 개념은
          병합해 분석이 하나로 합쳐지게 하세요.
        </p>
      </div>
      <ConstructManager items={items} />
    </main>
  );
}
