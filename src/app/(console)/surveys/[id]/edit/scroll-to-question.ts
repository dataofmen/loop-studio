/**
 * Scroll the matching question <li> (id=q-<id>) into view and briefly flash it
 * so the author can see which question a warning / logic-map row points at.
 *
 * Client-only (touches the DOM). Shared by the lint summary banner (editor.tsx)
 * and the logic map panel so jump-to behaves identically everywhere.
 */
export function scrollToQuestion(id: string) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(`q-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  // Restart the flash animation even on repeated clicks.
  el.classList.remove("q-flash");
  // Force reflow so re-adding the class re-triggers the CSS animation.
  void el.offsetWidth;
  el.classList.add("q-flash");
}
