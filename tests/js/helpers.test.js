import { describe, expect, it } from "vitest";
import {
  groupHandleRect,
  handleCenters,
  hitTestHandles,
  nodeHandleRect,
  resizeFromCorner,
  resolveTarget,
  screenToGraph,
  selectedGroups,
  selectedNodes,
  selectedResizables,
} from "../../src/index.ts";

// Pure geometry/selection helpers. Importing the module also confirms the
// registerExtension wiring loads cleanly under the node-environment harness.

const node = (over = {}) => ({
  id: 1,
  pos: [100, 200],
  size: [300, 150],
  computeSize: () => [80, 40],
  ...over,
});

const group = (over = {}) => ({
  id: 7,
  pos: [10, 20],
  size: [400, 300],
  title: "Group",
  ...over,
});

describe("screenToGraph", () => {
  // Inverse of LiteGraph's convertOffsetToCanvas: (p + offset) * scale.
  it("inverts the ds transform", () => {
    expect(screenToGraph({ x: 200, y: 100 }, 2, [10, 5])).toEqual({ x: 90, y: 45 });
  });

  it("round-trips a graph point through the forward transform", () => {
    const scale = 1.75;
    const offset = [-40, 15];
    const graph = { x: 123, y: -456 };
    const screen = { x: (graph.x + offset[0]) * scale, y: (graph.y + offset[1]) * scale };
    const back = screenToGraph(screen, scale, offset);
    expect(back.x).toBeCloseTo(graph.x, 10);
    expect(back.y).toBeCloseTo(graph.y, 10);
  });

  it("treats a zero scale as 1 rather than dividing by zero", () => {
    expect(screenToGraph({ x: 10, y: 10 }, 0, [0, 0])).toEqual({ x: 10, y: 10 });
  });
});

describe("nodeHandleRect / groupHandleRect", () => {
  it("spans a node's full outline, title bar included", () => {
    // A node's pos is the top-left of its BODY; the title is drawn above it.
    // Handles level with the title/body seam would land ~17px from the first
    // input/output slots — inside the hit radius — so tapping a slot on a
    // selected node would grab a handle instead of starting a link drag.
    expect(nodeHandleRect(node(), 30)).toEqual({ x: 100, y: 170, w: 300, h: 180 });
  });

  it("uses a group's box as-is — its pos already IS the visual top-left", () => {
    expect(groupHandleRect(group())).toEqual({ x: 10, y: 20, w: 400, h: 300 });
  });

  it("puts a node's bottom handles on the body's bottom corners", () => {
    // The title offset must extend the rect UPWARD only; the bottom edge is
    // still pos[1] + size[1]. Getting this wrong would float the bottom
    // handles below the node.
    const r = nodeHandleRect(node(), 30);
    expect(r.y + r.h).toBe(350);
  });
});

describe("handleCenters", () => {
  it("places one handle at each corner", () => {
    expect(handleCenters({ x: 0, y: 0, w: 100, h: 50 })).toEqual([
      { corner: "tl", x: 0, y: 0 },
      { corner: "tr", x: 100, y: 0 },
      { corner: "bl", x: 0, y: 50 },
      { corner: "br", x: 100, y: 50 },
    ]);
  });
});

describe("hitTestHandles", () => {
  const centers = handleCenters({ x: 0, y: 0, w: 200, h: 100 });

  it("grabs the corner under the point", () => {
    expect(hitTestHandles({ x: 198, y: 99 }, centers, 20)).toBe("br");
    expect(hitTestHandles({ x: 2, y: 1 }, centers, 20)).toBe("tl");
  });

  it("misses when no handle is within the radius", () => {
    expect(hitTestHandles({ x: 100, y: 50 }, centers, 20)).toBe(null);
  });

  it("is boundary-inclusive at exactly the radius", () => {
    expect(hitTestHandles({ x: 20, y: 0 }, centers, 20)).toBe("tl");
  });

  it("picks the NEAREST corner when two hit discs overlap", () => {
    // A 30x30 node with a 40px radius: every corner is within range, so a
    // first-match scan would answer "tl" for a point hugging the bottom-right.
    const tiny = handleCenters({ x: 0, y: 0, w: 30, h: 30 });
    expect(hitTestHandles({ x: 28, y: 29 }, tiny, 40)).toBe("br");
    expect(hitTestHandles({ x: 1, y: 2 }, tiny, 40)).toBe("tl");
    expect(hitTestHandles({ x: 29, y: 1 }, tiny, 40)).toBe("tr");
  });
});

describe("resizeFromCorner", () => {
  const pos = [100, 200];
  const size = [300, 150];

  it("grows from the bottom-right without moving pos", () => {
    expect(resizeFromCorner(pos, size, "br", [50, 20])).toEqual({
      pos: [100, 200],
      size: [350, 170],
    });
  });

  it("anchors the bottom-right when the top-left is dragged", () => {
    // Dragging tl by (+50,+20) shrinks the box and moves pos by the same,
    // leaving the opposite corner (400, 350) exactly where it was.
    const out = resizeFromCorner(pos, size, "tl", [50, 20]);
    expect(out).toEqual({ pos: [150, 220], size: [250, 130] });
    expect([out.pos[0] + out.size[0], out.pos[1] + out.size[1]]).toEqual([400, 350]);
  });

  it("moves only the y anchor for the top-right corner", () => {
    expect(resizeFromCorner(pos, size, "tr", [40, -30])).toEqual({
      pos: [100, 170],
      size: [340, 180],
    });
  });

  it("moves only the x anchor for the bottom-left corner", () => {
    expect(resizeFromCorner(pos, size, "bl", [-40, 30])).toEqual({
      pos: [60, 200],
      size: [340, 180],
    });
  });

  it("grows when a corner is dragged outward", () => {
    expect(resizeFromCorner(pos, size, "tl", [-25, -25])).toEqual({
      pos: [75, 175],
      size: [325, 175],
    });
  });

  it("clamps to the minimum size", () => {
    expect(resizeFromCorner(pos, size, "br", [-1000, -1000], [80, 40]).size).toEqual([80, 40]);
  });

  it("STOPS moving pos once the clamp binds", () => {
    // The failure this guards: clamp the size but keep applying the delta to
    // pos, and the box slides away from the anchored corner while refusing to
    // shrink. The anchor must stay pinned at (400, 350) no matter how far past
    // the floor the drag goes.
    const min = [80, 40];
    const atFloor = resizeFromCorner(pos, size, "tl", [220, 110], min);
    const wayPast = resizeFromCorner(pos, size, "tl", [9999, 9999], min);
    expect(atFloor.size).toEqual(min);
    expect(wayPast).toEqual(atFloor);
    expect([wayPast.pos[0] + wayPast.size[0], wayPast.pos[1] + wayPast.size[1]]).toEqual([
      400, 350,
    ]);
  });

  it("returns the original geometry for a zero delta", () => {
    for (const corner of ["tl", "tr", "bl", "br"]) {
      expect(resizeFromCorner(pos, size, corner, [0, 0])).toEqual({ pos, size });
    }
  });

  it("does not flip the box when dragged past the anchor with no minimum", () => {
    // Width collapses to 0 rather than going negative.
    expect(resizeFromCorner(pos, size, "br", [-500, -500])).toEqual({
      pos: [100, 200],
      size: [0, 0],
    });
  });
});

describe("selectedNodes / selectedGroups", () => {
  it("reads the selected_nodes dictionary", () => {
    const n = node();
    expect(selectedNodes({ selected_nodes: { 1: n } })).toEqual([n]);
  });

  it("falls back to selectedItems, discriminating by shape", () => {
    const n = node();
    const g = group();
    const reroute = { pos: [0, 0], title: "r" }; // no size
    const canvas = { selected_nodes: null, selectedItems: new Set([n, g, reroute]) };
    expect(selectedNodes(canvas)).toEqual([n]);
    expect(selectedGroups(canvas)).toEqual([g]);
  });

  it("returns empty for a missing canvas", () => {
    expect(selectedNodes(null)).toEqual([]);
    expect(selectedGroups(undefined)).toEqual([]);
  });
});

describe("selectedResizables", () => {
  it("normalizes a node, carrying computeSize as the min size", () => {
    const [t] = selectedResizables({ selected_nodes: { 1: node() } });
    expect(t).toMatchObject({
      id: "node:1",
      kind: "node",
      rect: { x: 100, y: 170, w: 300, h: 180 }, // body + title bar
      pos: [100, 200],
      size: [300, 150],
      minSize: [80, 40],
    });
  });

  it("copies pos/size rather than aliasing the live arrays", () => {
    // The controller snapshots these at grab time; aliasing would make the
    // "start" geometry track the live node and the drag would run away.
    const n = node();
    const [t] = selectedResizables({ selected_nodes: { 1: n } });
    n.pos[0] = 999;
    n.size[0] = 999;
    expect(t.pos[0]).toBe(100);
    expect(t.size[0]).toBe(300);
  });

  it("excludes pinned items — LiteGraph forbids resizing them", () => {
    const canvas = {
      selected_nodes: null,
      selectedItems: new Set([node({ flags: { pinned: true } }), group({ pinned: true })]),
    };
    expect(selectedResizables(canvas)).toEqual([]);
  });

  it("excludes a collapsed node — it has no body to grab", () => {
    const canvas = { selected_nodes: { 1: node({ flags: { collapsed: true } }) } };
    expect(selectedResizables(canvas)).toEqual([]);
  });

  it("falls back to the selection index for a group with the default id", () => {
    const canvas = { selected_nodes: null, selectedItems: new Set([group({ id: -1 })]) };
    expect(selectedResizables(canvas)[0].id).toBe("group:idx0");
  });
});

describe("resolveTarget", () => {
  it("returns the sole selected item", () => {
    expect(resolveTarget({ selected_nodes: { 1: node() } })?.id).toBe("node:1");
  });

  it("returns null for an empty selection", () => {
    expect(resolveTarget({ selected_nodes: {} })).toBe(null);
  });

  it("returns null for a multi-selection — handles are single-selection only", () => {
    const canvas = { selected_nodes: { 1: node(), 2: node({ id: 2 }) } };
    expect(selectedResizables(canvas)).toHaveLength(2);
    expect(resolveTarget(canvas)).toBe(null);
  });

  it("returns null when the only selected item is pinned", () => {
    expect(resolveTarget({ selected_nodes: { 1: node({ flags: { pinned: true } }) } })).toBe(null);
  });
});
