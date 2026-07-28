/**
 * US-004: A short, human-readable display code for a question, derived purely
 * from its permanent quid (US-001). Independent of position/order — reordering,
 * editing, reverting or reusing a question never changes its code — so authors,
 * the logic map and version diffs can refer to a question by a stable handle
 * ("Q-4F2A") instead of a shifting "Q3".
 *
 * PURE MODULE — no DB / IO. Both generated quids ("q_xxxxxxxx") and legacy quids
 * (a full UUID from the quid=id backfill) hash to the same 4-symbol form.
 */

// 32 unambiguous symbols (no 0/O/1/I) → readable when spoken or typed.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;

/**
 * Deterministic FNV-1a-derived display code, e.g. "Q-7KPT". Same quid always
 * yields the same code (stable identity); different quids collide only with
 * ~1/(32^4) ≈ 1e-6 probability, negligible for a single survey's question set.
 */
export function questionCode(quid: string): string {
  if (!quid) return "Q-????"; // defensive: quid is a NOT NULL column, never empty in practice
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < quid.length; i++) {
    h ^= quid.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  let n = h >>> 0;
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) {
    code = ALPHABET[n % ALPHABET.length] + code;
    n = Math.floor(n / ALPHABET.length);
  }
  return "Q-" + code;
}
