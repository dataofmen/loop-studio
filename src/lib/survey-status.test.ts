import { describe, test, expect } from "vitest";
import { canTransition, statusLabel } from "./survey-status";

describe("survey status transitions", () => {
  test("the design pipeline moves draft → reviewed → simulated", () => {
    expect(canTransition("draft", "reviewed")).toBe(true);
    expect(canTransition("reviewed", "simulated")).toBe(true);
  });

  test("simulation can run straight from draft (review is not mandatory)", () => {
    expect(canTransition("draft", "simulated")).toBe(true);
  });

  test("editing sends a reviewed or simulated survey back to draft", () => {
    expect(canTransition("reviewed", "draft")).toBe(true);
    expect(canTransition("simulated", "draft")).toBe(true);
  });

  test("re-reviewing simulated content does not demote it", () => {
    expect(canTransition("simulated", "reviewed")).toBe(false);
  });

  test("no self-transitions", () => {
    expect(canTransition("draft", "draft")).toBe(false);
    expect(canTransition("simulated", "simulated")).toBe(false);
  });
});

describe("statusLabel", () => {
  test("korean labels, unknown echoes through", () => {
    expect(statusLabel("draft")).toBe("초안");
    expect(statusLabel("reviewed")).toBe("검토 완료");
    expect(statusLabel("simulated")).toBe("시뮬 완료");
    expect(statusLabel("whatever")).toBe("whatever");
  });
});
