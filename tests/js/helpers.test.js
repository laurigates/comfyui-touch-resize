import { describe, expect, it } from "vitest";
import {
  anisoSize,
  centroid,
  cornerHintPath,
  groupScreenRect,
  nodeScreenRect,
  pinchDistance,
  pointInRect,
  resolveTargets,
  scaledSize,
  selectedGroups,
  selectedNodes,
} from "../../web/js/touch-resize.js";

// Pure geometry/selection helpers. Importing the module also confirms the
// registerExtension wiring loads cleanly under the node-environment harness.

describe("pinchDistance / centroid", () => {
  it("measures pinch distance", () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("computes the midpoint", () => {
    expect(centroid({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe("pointInRect", () => {
  const rect = { x: 10, y: 10, w: 100, h: 50 };
  it("hit-tests inside", () => {
    expect(pointInRect(50, 30, rect)).toBe(true);
  });
  it("rejects outside", () => {
    expect(pointInRect(5, 30, rect)).toBe(false);
  });
  it("includes the edges", () => {
    expect(pointInRect(10, 10, rect)).toBe(true);
    expect(pointInRect(110, 60, rect)).toBe(true);
  });
});

describe("nodeScreenRect", () => {
  it("maps node graph coords to screen space and lifts the title bar", () => {
    const node = { pos: [100, 200], size: [180, 90] };
    const r = nodeScreenRect(node, 2, [0, 0], 30);
    // x = (100+0)*2 = 200; body y = (200+0)*2 = 400; title lifts by 30*2 = 60.
    expect(r).toEqual({ x: 200, y: 340, w: 360, h: 240 });
  });

  it("applies the ds offset before scaling", () => {
    const node = { pos: [10, 10], size: [100, 100] };
    const r = nodeScreenRect(node, 1, [5, 5], 0);
    expect(r).toEqual({ x: 15, y: 15, w: 100, h: 100 });
  });
});

describe("scaledSize", () => {
  it("uniform-scales", () => {
    expect(scaledSize([200, 100], 1.5)).toEqual([300, 150]);
  });
  it("clamps to the minimum", () => {
    expect(scaledSize([200, 100], 0.1, [120, 60])).toEqual([120, 60]);
  });
});

describe("anisoSize", () => {
  it("scales each axis independently by its span ratio", () => {
    // start vector spans (20, 10); current (40, 10) → x doubles, y unchanged.
    const size = anisoSize([200, 100], [20, 10], [40, 10], [0, 0], 8);
    expect(size).toEqual([400, 100]);
  });

  it("shrinks an axis whose span shrinks", () => {
    const size = anisoSize([200, 100], [40, 40], [20, 40], [0, 0], 8);
    expect(size).toEqual([100, 100]);
  });

  it("clamps each axis to minSize", () => {
    const size = anisoSize([200, 100], [40, 40], [4, 4], [120, 60], 8);
    expect(size).toEqual([120, 60]);
  });

  it("falls back to the uniform ratio on a degenerate start axis (span ≤ eps)", () => {
    // y span starts at 0 (fingers horizontal) → y can't track independently.
    // start = (20, 0), cur = (40, 0): startLen 20, curLen 40 → uniform 2.0.
    const size = anisoSize([200, 100], [20, 0], [40, 0], [0, 0], 8);
    expect(size).toEqual([400, 200]); // x by its own ratio (2), y by uniform (2)
  });

  it("uses the eps threshold, not strict zero", () => {
    // y start span = 5 ≤ eps 8 → degenerate → uniform.
    const size = anisoSize([100, 100], [30, 5], [60, 5], [0, 0], 8);
    const startLen = Math.hypot(30, 5);
    const uniform = Math.hypot(60, 5) / startLen;
    expect(size[0]).toBeCloseTo(100 * (60 / 30));
    expect(size[1]).toBeCloseTo(100 * uniform);
  });
});

describe("cornerHintPath", () => {
  it("brackets the bottom-right corner: up then left", () => {
    const pts = cornerHintPath({ x: 10, y: 20, w: 100, h: 50 }, 8);
    // corner = (110, 70)
    expect(pts).toEqual([
      { x: 110, y: 62 },
      { x: 110, y: 70 },
      { x: 102, y: 70 },
    ]);
  });

  it("scales the bracket legs with sizePx", () => {
    const small = cornerHintPath({ x: 0, y: 0, w: 100, h: 100 }, 4);
    const big = cornerHintPath({ x: 0, y: 0, w: 100, h: 100 }, 40);
    expect(small[0]).toEqual({ x: 100, y: 96 });
    expect(big[0]).toEqual({ x: 100, y: 60 });
  });
});

describe("selectedNodes", () => {
  it("returns [] without a canvas", () => {
    expect(selectedNodes(null)).toEqual([]);
  });

  it("reads the selected_nodes dictionary", () => {
    const a = { id: 1, pos: [0, 0], size: [1, 1] };
    const b = { id: 2, pos: [0, 0], size: [1, 1] };
    expect(selectedNodes({ selected_nodes: { 1: a, 2: b } })).toEqual([a, b]);
  });

  it("falls back to selectedItems, keeping only node-shaped items", () => {
    const node = { id: 1, pos: [0, 0], size: [10, 10], computeSize: () => [5, 5] };
    const group = { id: 2, pos: [0, 0], size: [10, 10], title: "G" }; // no computeSize
    const reroute = { id: 3, pos: [0, 0] }; // no size
    const canvas = { selectedItems: new Set([node, group, reroute]) };
    expect(selectedNodes(canvas)).toEqual([node]);
  });
});

describe("groupScreenRect", () => {
  it("maps group graph coords to screen space with NO title offset", () => {
    const group = { pos: [100, 200], size: [300, 150] };
    const r = groupScreenRect(group, 2, [0, 0]);
    expect(r).toEqual({ x: 200, y: 400, w: 600, h: 300 });
  });

  it("applies the ds offset before scaling", () => {
    const group = { pos: [10, 10], size: [100, 100] };
    expect(groupScreenRect(group, 1, [5, 5])).toEqual({ x: 15, y: 15, w: 100, h: 100 });
  });
});

describe("selectedGroups", () => {
  it("returns [] without a selectedItems Set", () => {
    expect(selectedGroups({})).toEqual([]);
    expect(selectedGroups(null)).toEqual([]);
  });

  it("keeps only group-shaped items (title, size, no computeSize)", () => {
    const node = { pos: [0, 0], size: [10, 10], title: "N", computeSize: () => [1, 1] };
    const group = { pos: [0, 0], size: [10, 10], title: "G" };
    const reroute = { pos: [0, 0] };
    const canvas = { selectedItems: new Set([node, group, reroute]) };
    expect(selectedGroups(canvas)).toEqual([group]);
  });
});

describe("resolveTargets (nodes + groups)", () => {
  it("normalizes selected nodes into Target data", () => {
    const node = { id: 7, pos: [10, 20], size: [100, 50], computeSize: () => [40, 30] };
    const canvas = { ds: { scale: 1, offset: [0, 0] }, selected_nodes: { 7: node } };
    const targets = resolveTargets(canvas);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: "node:7",
      kind: "node",
      obj: node,
      size: [100, 50],
      minSize: [40, 30],
    });
    expect(targets[0].screenRect).toEqual(nodeScreenRect(node, 1, [0, 0]));
  });

  it("falls back to index ids when a node lacks an id", () => {
    const node = { pos: [0, 0], size: [10, 10], computeSize: () => [1, 1] };
    const canvas = { ds: { scale: 1, offset: [0, 0] }, selectedItems: new Set([node]) };
    expect(resolveTargets(canvas)[0].id).toBe("node:0");
  });

  it("normalizes selected groups, using the config group min-size", () => {
    const group = { id: 3, pos: [0, 0], size: [300, 200], title: "G" };
    const canvas = { ds: { scale: 1, offset: [0, 0] }, selectedItems: new Set([group]) };
    const targets = resolveTargets(canvas, { groupMinSize: [140, 80] });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: "group:3",
      kind: "group",
      obj: group,
      size: [300, 200],
      minSize: [140, 80],
    });
    expect(targets[0].screenRect).toEqual(groupScreenRect(group, 1, [0, 0]));
  });

  it("falls back to an index key when group.id is -1 (LiteGraph default)", () => {
    const group = { id: -1, pos: [0, 0], size: [300, 200], title: "G" };
    const canvas = { ds: { scale: 1, offset: [0, 0] }, selectedItems: new Set([group]) };
    expect(resolveTargets(canvas, { groupMinSize: [140, 80] })[0].id).toBe("group:idx0");
  });

  it("emits nodes before groups so both share one resize path", () => {
    const node = { id: 1, pos: [0, 0], size: [10, 10], title: "N", computeSize: () => [1, 1] };
    const group = { id: 2, pos: [0, 0], size: [300, 200], title: "G" };
    const canvas = {
      ds: { scale: 1, offset: [0, 0] },
      selectedItems: new Set([node, group]),
    };
    const targets = resolveTargets(canvas, { groupMinSize: [140, 80] });
    expect(targets.map((t) => t.kind)).toEqual(["node", "group"]);
  });
});
