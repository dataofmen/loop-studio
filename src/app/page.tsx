export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight">Loop</h1>
      <p className="max-w-md text-center text-lg text-gray-600">
        AI-Native Survey Platform — 설문을 일회성 데이터가 아니라 누적되는 지식으로
        바꾸는 closed-loop 솔루션.
      </p>
      <ol className="flex flex-wrap justify-center gap-2 text-sm text-gray-500">
        <li className="rounded-full border px-3 py-1">설계</li>
        <li className="rounded-full border px-3 py-1">시뮬레이션</li>
        <li className="rounded-full border px-3 py-1">발송</li>
        <li className="rounded-full border px-3 py-1">분석</li>
        <li className="rounded-full border px-3 py-1">지식 적재</li>
        <li className="rounded-full border px-3 py-1">메타 보정</li>
      </ol>
      <a
        href="/dashboard"
        className="rounded-md bg-black px-5 py-2.5 text-sm font-medium text-white"
      >
        시작하기
      </a>
    </main>
  );
}
