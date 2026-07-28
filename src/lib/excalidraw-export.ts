/**
 * Builds an Excalidraw scene (.excalidraw JSON) from a survey's questions and
 * their conditional display logic, so authors can open/edit the branching map in
 * Excalidraw. Pure — no DOM/DB; the client wraps the result in a download.
 *
 * Layout: questions stack vertically as rounded rectangles; a conditional
 * question gets an arrow from each referenced (earlier) question into it.
 */
import type { DisplayLogic } from "@/lib/display-logic";

type ExQuestion = {
  id: string;
  prompt: string;
  config?: { displayLogic?: DisplayLogic } | null;
};

type ExElement = Record<string, unknown>;

const NODE_W = 300;
const NODE_H = 72;
const V_GAP = 70; // vertical gap between nodes
const X0 = 120;
const Y0 = 100;

let counter = 0;
function eid(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
function rnd(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

function baseEl(over: ExElement): ExElement {
  return {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rnd(),
    version: 1,
    versionNonce: rnd(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...over,
  };
}

export type ExcalidrawScene = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: ExElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

/** Builds the Excalidraw scene object for the given questions (in order). */
export function buildExcalidrawScene(questions: ExQuestion[]): ExcalidrawScene {
  counter = 0;
  const idxById = new Map(questions.map((q, i) => [q.id, i]));
  const elements: ExElement[] = [];
  const rectIdByIndex: string[] = [];

  // Nodes (rectangle + bound centered text label).
  questions.forEach((q, i) => {
    const conditional = !!q.config?.displayLogic && q.config.displayLogic.conditions.length > 0;
    const rectId = eid("rect");
    const textId = eid("text");
    rectIdByIndex[i] = rectId;
    const x = X0;
    const y = Y0 + i * (NODE_H + V_GAP);
    const label = `Q${i + 1}. ${(q.prompt || "(제목 없음)").slice(0, 40)}`;

    elements.push(
      baseEl({
        id: rectId,
        type: "rectangle",
        x,
        y,
        width: NODE_W,
        height: NODE_H,
        strokeColor: conditional ? "#3b5bdb" : "#495057",
        backgroundColor: conditional ? "#edf2ff" : "#f8f9fa",
        roundness: { type: 3 },
        boundElements: [{ type: "text", id: textId }],
      }),
    );
    elements.push(
      baseEl({
        id: textId,
        type: "text",
        x: x + 12,
        y: y + NODE_H / 2 - 10,
        width: NODE_W - 24,
        height: 20,
        text: label,
        fontSize: 16,
        fontFamily: 1,
        textAlign: "center",
        verticalAlign: "middle",
        containerId: rectId,
        originalText: label,
        lineHeight: 1.25,
        strokeColor: "#1e1e1e",
      }),
    );
  });

  // Edges: referenced (earlier) question → conditional question.
  questions.forEach((q, i) => {
    const logic = q.config?.displayLogic;
    if (!logic || logic.conditions.length === 0) return;
    const refIds = Array.from(new Set(logic.conditions.map((c) => c.questionId)));
    for (const rid of refIds) {
      const from = idxById.get(rid);
      if (from === undefined) continue; // deleted reference — skip in export
      const fromY = Y0 + from * (NODE_H + V_GAP) + NODE_H / 2;
      const toY = Y0 + i * (NODE_H + V_GAP) + NODE_H / 2;
      const startX = X0 + NODE_W; // right edge of source
      const span = Math.abs(i - from);
      const depth = 40 + Math.min(span - 1, 5) * 24;
      const dy = toY - fromY;
      elements.push(
        baseEl({
          id: eid("arrow"),
          type: "arrow",
          x: startX,
          y: fromY,
          width: depth,
          height: Math.abs(dy),
          strokeColor: "#5c7cfa",
          points: [
            [0, 0],
            [depth, 0],
            [depth, dy],
            [4, dy],
          ],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: "arrow",
        }),
      );
    }
  });

  return {
    type: "excalidraw",
    version: 2,
    source: "loop-survey",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  };
}
