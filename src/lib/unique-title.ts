/**
 * Distinguishing-title helper for markdown import: when an imported survey's
 * title collides with an existing one in the workspace, append a suffix so the
 * two are told apart in lists — "제목" → "제목 (복사본)" → "제목 (복사본 2)" …
 *
 * PURE MODULE — no DB / IO (the caller passes the existing titles), so it is
 * unit-testable and safe on either side.
 */

/** Max stored title length (mirrors the `.slice(0, 200)` cap at the insert site). */
export const TITLE_MAX = 200;

/**
 * Returns `base` (capped to `cap`) if it is not already taken; otherwise the
 * first free "`base` (복사본)" / "`base` (복사본 N)" variant. `base` is trimmed
 * to leave room for the suffix so the result never exceeds `cap`. Non-string
 * entries in `existing` are ignored. Comparison is on the trimmed forms, so a
 * suffixed candidate is matched against exactly what would be stored.
 */
export function uniqueTitle(
  base: string,
  existing: Iterable<string | null | undefined>,
  cap: number = TITLE_MAX,
): string {
  const taken = new Set<string>();
  for (const t of existing) if (typeof t === "string") taken.add(t);

  const capped = base.slice(0, cap);
  if (!taken.has(capped)) return capped;

  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (복사본)" : ` (복사본 ${n})`;
    const room = Math.max(0, cap - suffix.length);
    const candidate = base.slice(0, room) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
