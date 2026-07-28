/**
 * US-006 contract test. The compile-time layer (keyof QConfig ↔ QCONFIG_FIELDS,
 * Record<QConfigField, …> per consumer) already fails typecheck on a missing
 * field/declaration; this runtime layer rejects EMPTY declarations — a "" in
 * `where`/`reason` would satisfy the types while documenting nothing.
 *
 * 새 필드 추가 시나리오 (예: config.pipe 추가):
 *   1. question-diff.ts QConfig에 `pipe?: …` 추가
 *   2. `bun run typecheck` → qconfig-contract.ts의 _assertNoMissing이 실패
 *   3. QCONFIG_FIELDS에 "pipe" 추가 → 이번엔 9개 소비처 레코드가 전부 타입 에러
 *   4. 소비처 코드를 실제로 갱신하며 각 레코드에 handled/n-a(사유) 선언을 채움
 *   5. 이 테스트가 빈 선언·중복/누락 필드를 런타임에서 최종 확인
 */
import { describe, test, expect } from "vitest";
import {
  CONSUMER_GROUPS,
  QCONFIG_CONSUMERS,
  QCONFIG_FIELDS,
} from "./qconfig-contract";

describe("QConfig consumer contract (US-006)", () => {
  test("field list has no duplicates", () => {
    expect(new Set(QCONFIG_FIELDS).size).toBe(QCONFIG_FIELDS.length);
  });

  test("every consumer group declares every field exactly once", () => {
    for (const group of CONSUMER_GROUPS) {
      const declared = Object.keys(QCONFIG_CONSUMERS[group]).sort();
      expect(declared, `group ${group}`).toEqual([...QCONFIG_FIELDS].sort());
    }
  });

  test("every declaration is substantive (non-blank where/reason)", () => {
    for (const group of CONSUMER_GROUPS) {
      for (const field of QCONFIG_FIELDS) {
        const d = QCONFIG_CONSUMERS[group][field];
        const text = d.status === "handled" ? d.where : d.reason;
        expect(
          text.trim().length,
          `${group}.${field} (${d.status}) must explain itself`,
        ).toBeGreaterThan(4);
      }
    }
  });

  test("no consumer group is missing from the contract", () => {
    expect(Object.keys(QCONFIG_CONSUMERS).sort()).toEqual([...CONSUMER_GROUPS].sort());
  });
});
