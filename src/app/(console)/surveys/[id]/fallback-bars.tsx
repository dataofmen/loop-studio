/**
 * Plain CSS distribution bars — the pre-Flint rendering, kept as the fail-open
 * fallback when the chart pipeline throws (a chart bug must never blank the
 * analysis screen). Markup matches the original QuestionDist bars.
 */

type Count = { label: string; count: number; pct: number };

export function FallbackBars({
  counts,
  synthetic,
}: {
  counts: Count[];
  synthetic?: Count[];
}) {
  const synPct = (label: string) => synthetic?.find((c) => c.label === label)?.pct ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      {counts.map((c) => (
        <div key={c.label} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 truncate text-muted-foreground" title={c.label}>
            {c.label}
          </span>
          <div className="flex flex-1 flex-col gap-0.5">
            <div className="h-3 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${c.pct}%` }} />
            </div>
            {synthetic && (
              <div className="h-3 overflow-hidden rounded bg-muted">
                <div className="h-full bg-purple-400" style={{ width: `${synPct(c.label)}%` }} />
              </div>
            )}
          </div>
          <span className="w-16 shrink-0 text-right text-muted-foreground">
            {c.pct}%{synthetic ? ` / ${synPct(c.label)}%` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
