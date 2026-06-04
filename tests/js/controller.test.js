import { describe, expect, it } from "vitest";
import { createGestureController } from "../../web/js/touch-resize.js";

// The pure gesture reducer. No DOM, no app — just data in, commands out.

const rectAt = (x, y, w, h) => ({ x, y, w, h });

/** A node-like Target centered so a centroid at (50,50) lands inside. */
const nodeTarget = (over = {}) => ({
  id: "node:1",
  kind: "node",
  screenRect: rectAt(0, 0, 100, 100),
  size: [200, 100],
  minSize: [50, 25],
  ...over,
});

describe("createGestureController — lock", () => {
  it("locks onto the target whose screenRect contains the pinch centroid", () => {
    const c = createGestureController({ mode: "uniform" });
    const cmd = c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    expect(cmd).toEqual({ type: "lock", targetId: "node:1" });
    expect(c.locked).toBe(true);
  });

  it("does not lock when the centroid is outside every target", () => {
    const c = createGestureController({ mode: "uniform" });
    const cmd = c.onPointersChanged(
      [
        { id: 1, x: 500, y: 500 },
        { id: 2, x: 520, y: 500 },
      ],
      [nodeTarget()],
    );
    expect(cmd).toBe(null);
    expect(c.locked).toBe(false);
  });

  it("does not lock with fewer than two pointers", () => {
    const c = createGestureController({ mode: "uniform" });
    expect(c.onPointersChanged([{ id: 1, x: 50, y: 50 }], [nodeTarget()])).toBe(null);
  });

  it("does not re-lock while already locked", () => {
    const c = createGestureController({ mode: "uniform" });
    const pts = [
      { id: 1, x: 40, y: 50 },
      { id: 2, x: 60, y: 50 },
    ];
    c.onPointersChanged(pts, [nodeTarget()]);
    const second = c.onPointersChanged(pts, [nodeTarget({ id: "node:2" })]);
    expect(second).toBe(null);
  });

  it("locks the first matching target when several overlap", () => {
    const c = createGestureController({ mode: "uniform" });
    const cmd = c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget({ id: "node:a" }), nodeTarget({ id: "node:b" })],
    );
    expect(cmd.targetId).toBe("node:a");
  });
});

describe("createGestureController — resize (uniform)", () => {
  it("scales by the pinch-distance ratio", () => {
    const c = createGestureController({ mode: "uniform" });
    // start distance = 20 (x 40..60)
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    // current distance = 40 → ratio 2.0
    const cmd = c.onPointersMoved([
      { id: 1, x: 30, y: 50 },
      { id: 2, x: 70, y: 50 },
    ]);
    expect(cmd).toEqual({ type: "resize", targetId: "node:1", size: [400, 200] });
  });

  it("clamps to the target minSize on shrink", () => {
    const c = createGestureController({ mode: "uniform" });
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()], // minSize [50,25]
    );
    // current distance = 2 → ratio 0.1 → 200*0.1=20 < 50, 100*0.1=10 < 25
    const cmd = c.onPointersMoved([
      { id: 1, x: 49, y: 50 },
      { id: 2, x: 51, y: 50 },
    ]);
    expect(cmd.size).toEqual([50, 25]);
  });

  it("returns null when not locked", () => {
    const c = createGestureController({ mode: "uniform" });
    expect(
      c.onPointersMoved([
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 5, y: 5 },
      ]),
    ).toBe(null);
  });

  it("returns null when a finger has lifted (fewer than two pointers)", () => {
    const c = createGestureController({ mode: "uniform" });
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    expect(c.onPointersMoved([{ id: 1, x: 40, y: 50 }])).toBe(null);
  });
});

describe("createGestureController — kind-agnostic (groups)", () => {
  it("locks and resizes a group target through the same path", () => {
    const c = createGestureController({ mode: "uniform" });
    const groupTarget = nodeTarget({ id: "group:3", kind: "group", minSize: [140, 80] });
    const lock = c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [groupTarget],
    );
    expect(lock).toEqual({ type: "lock", targetId: "group:3" });
    const resize = c.onPointersMoved([
      { id: 1, x: 30, y: 50 },
      { id: 2, x: 70, y: 50 },
    ]);
    expect(resize).toEqual({ type: "resize", targetId: "group:3", size: [400, 200] });
  });
});

describe("createGestureController — resize (aniso)", () => {
  it("resizes width and height independently from the finger vector", () => {
    const c = createGestureController({ mode: "aniso", anisoEps: 8 });
    // start vector spans (20, 20): fingers diagonal.
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 40 },
        { id: 2, x: 60, y: 60 },
      ],
      [nodeTarget({ screenRect: rectAt(0, 0, 200, 200) })],
    );
    // current vector (40, 20): x span doubled, y span unchanged.
    const cmd = c.onPointersMoved([
      { id: 1, x: 30, y: 40 },
      { id: 2, x: 70, y: 60 },
    ]);
    expect(cmd.size).toEqual([400, 100]); // w 200→400, h unchanged
  });

  it("defaults to uniform scaling when mode is unset", () => {
    const c = createGestureController({}); // no mode
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    const cmd = c.onPointersMoved([
      { id: 1, x: 30, y: 50 },
      { id: 2, x: 70, y: 50 },
    ]);
    expect(cmd.size).toEqual([400, 200]); // uniform ratio 2.0 on both axes
  });
});

describe("createGestureController — release", () => {
  it("releases the lock when pointers drop below two", () => {
    const c = createGestureController({ mode: "uniform" });
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    const cmd = c.onPointerEnded(1);
    expect(cmd).toEqual({ type: "release", targetId: "node:1" });
    expect(c.locked).toBe(false);
  });

  it("keeps the lock while two pointers remain", () => {
    const c = createGestureController({ mode: "uniform" });
    c.onPointersChanged(
      [
        { id: 1, x: 40, y: 50 },
        { id: 2, x: 60, y: 50 },
      ],
      [nodeTarget()],
    );
    expect(c.onPointerEnded(2)).toBe(null);
    expect(c.locked).toBe(true);
  });

  it("returns null when releasing without a lock", () => {
    const c = createGestureController({ mode: "uniform" });
    expect(c.onPointerEnded(0)).toBe(null);
  });
});
