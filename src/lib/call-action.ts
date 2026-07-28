/**
 * Turns a rejected server action into the `{ error }` shape every action in
 * this app already returns on failure.
 *
 * Server actions here catch their own errors, so a rejection means the call
 * itself did not survive: the connection dropped, the server restarted, or the
 * payload failed to serialize. The AI-backed actions run a local CLI and take
 * minutes, which is ample time for that to happen — and an unhandled rejection
 * inside `startTransition` takes down the whole page rather than the one panel
 * that asked for the work.
 *
 * PURE MODULE — client-safe.
 */

/**
 * `T` is returned unchanged on success. On rejection the result is an
 * error-only `T`, which type-checks because every action result in this app
 * declares all of its fields optional alongside `error?: string` — callers
 * branch on `error` first anyway.
 */
export async function callAction<T extends { error?: string }>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    // Next's own navigation signals must keep propagating.
    if (e && typeof e === "object" && "digest" in e) {
      const digest = String((e as { digest?: unknown }).digest ?? "");
      if (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND") throw e;
    }
    console.error("[action] rejected:", e);
    const message =
      e instanceof Error && e.message
        ? `요청이 완료되지 못했습니다 — ${e.message}`
        : "요청이 완료되지 못했습니다. 잠시 후 다시 시도해 주세요.";
    return { error: message } as T;
  }
}
