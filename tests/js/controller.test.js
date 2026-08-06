import { describe, expect, it } from "vitest";
import { createResizeController } from "../../src/index.ts";

// The pure drag reducer. No DOM, no app — just data in, commands out.

const target = (over = {}) => ({
  id: "node:1",
  kind: "node",
  obj: {},
  rect: { x: 0, y: 0, w: 200, h: 100 },
  pos: [0, 0],
  size: [200, 100],
  minSize: [80, 40],
  ...over,
});

/** A pointer landing exactly on the bottom-right handle of the default target. */
const onBr = (id = 1) => ({ id, x: 200, y: 100 });

const grab = (controller, pointer = onBr(), t = target(), radius = 20) =>
  controller.onPointerDown(pointer, t, radius);

describe("grabbing a handle", () => {
  it("locks onto the corner under the pointer", () => {
    const c = createResizeController();
    expect(c.locked).toBe(false);
    expect(grab(c)).toEqual({ type: "grab", targetId: "node:1", corner: "br" });
    expect(c.locked).toBe(true);
    expect(c.activeCorner).toBe("br");
  });

  it("ignores a pointer that misses every handle", () => {
    const c = createResizeController();
    // Dead centre of the target — inside the node, but on no handle. This is
    // the case that keeps a plain body-tap flowing through to LiteGraph.
    expect(grab(c, { id: 1, x: 100, y: 50 })).toBe(null);
    expect(c.locked).toBe(false);
    expect(c.activeCorner).toBe(null);
  });

  it("ignores a null target (nothing selected, or a multi-selection)", () => {
    const c = createResizeController();
    expect(c.onPointerDown(onBr(), null, 20)).toBe(null);
    expect(c.locked).toBe(false);
  });

  it("does not re-grab while already holding one", () => {
    const c = createResizeController();
    grab(c, onBr(1));
    expect(grab(c, { id: 2, x: 0, y: 0 })).toBe(null);
    expect(c.activeCorner).toBe("br");
  });

  it("grabs a group's handle on its own box", () => {
    const c = createResizeController();
    const g = target({
      id: "group:7",
      kind: "group",
      rect: { x: 10, y: 20, w: 400, h: 300 },
      pos: [10, 20],
      size: [400, 300],
      minSize: [140, 80],
    });
    expect(grab(c, { id: 1, x: 10, y: 20 }, g)).toEqual({
      type: "grab",
      targetId: "group:7",
      corner: "tl",
    });
  });
});

describe("resizing", () => {
  it("emits the new geometry as the pointer moves", () => {
    const c = createResizeController();
    grab(c);
    expect(c.onPointerMoved({ id: 1, x: 250, y: 130 })).toEqual({
      type: "resize",
      targetId: "node:1",
      pos: [0, 0],
      size: [250, 130],
    });
  });

  it("moves pos when a top-left handle is dragged", () => {
    const c = createResizeController();
    grab(c, { id: 1, x: 0, y: 0 });
    expect(c.onPointerMoved({ id: 1, x: 30, y: 20 })).toEqual({
      type: "resize",
      targetId: "node:1",
      pos: [30, 20],
      size: [170, 80],
    });
  });

  it("measures from the ORIGINAL geometry, not the previous frame", () => {
    // Guards accumulation: three moves then a move back to the grab point must
    // restore the start size exactly. An incremental reducer drifts here.
    const c = createResizeController();
    grab(c);
    c.onPointerMoved({ id: 1, x: 260, y: 160 });
    c.onPointerMoved({ id: 1, x: 210, y: 105 });
    c.onPointerMoved({ id: 1, x: 400, y: 300 });
    expect(c.onPointerMoved({ id: 1, x: 200, y: 100 })?.size).toEqual([200, 100]);
  });

  it("clamps at the target's minimum size", () => {
    const c = createResizeController();
    grab(c);
    expect(c.onPointerMoved({ id: 1, x: -500, y: -500 })?.size).toEqual([80, 40]);
  });

  it("ignores a move from a pointer that is not holding the grab", () => {
    // A second finger wandering the canvas must not drive someone else's drag.
    const c = createResizeController();
    grab(c, onBr(1));
    expect(c.onPointerMoved({ id: 2, x: 400, y: 400 })).toBe(null);
  });

  it("emits nothing when no handle is held", () => {
    const c = createResizeController();
    expect(c.onPointerMoved({ id: 1, x: 10, y: 10 })).toBe(null);
  });
});

describe("releasing", () => {
  it("releases on the pointer that holds the grab", () => {
    const c = createResizeController();
    grab(c, onBr(7));
    expect(c.onPointerEnded(7)).toEqual({ type: "release", targetId: "node:1" });
    expect(c.locked).toBe(false);
    expect(c.activeCorner).toBe(null);
  });

  it("ignores another pointer lifting", () => {
    const c = createResizeController();
    grab(c, onBr(7));
    expect(c.onPointerEnded(9)).toBe(null);
    expect(c.locked).toBe(true);
  });

  it("force-releases with a null id", () => {
    const c = createResizeController();
    grab(c, onBr(7));
    expect(c.onPointerEnded(null)).toEqual({ type: "release", targetId: "node:1" });
    expect(c.locked).toBe(false);
  });

  it("reset() drops the grab unconditionally", () => {
    // The escape hatch behind Escape / window blur / a second finger arriving.
    const c = createResizeController();
    grab(c, onBr(7));
    expect(c.reset()).toEqual({ type: "release", targetId: "node:1" });
    expect(c.locked).toBe(false);
  });

  it("releasing and reset() are no-ops when idle", () => {
    const c = createResizeController();
    expect(c.onPointerEnded(1)).toBe(null);
    expect(c.reset()).toBe(null);
  });

  it("stops emitting resizes after release", () => {
    const c = createResizeController();
    grab(c);
    c.onPointerEnded(1);
    expect(c.onPointerMoved({ id: 1, x: 400, y: 400 })).toBe(null);
  });

  it("can grab again after releasing", () => {
    const c = createResizeController();
    grab(c);
    c.onPointerEnded(1);
    expect(grab(c, { id: 2, x: 0, y: 0 })).toEqual({
      type: "grab",
      targetId: "node:1",
      corner: "tl",
    });
  });
});

describe("hit radius", () => {
  it("scales with the radius it is given", () => {
    // The adapter passes hitRadiusPx / ds.scale, so the touch target stays a
    // constant physical size while the graph-space radius changes with zoom.
    const near = { id: 1, x: 215, y: 100 }; // 15 graph units from the br handle
    expect(grab(createResizeController(), near, target(), 20)).not.toBe(null);
    expect(grab(createResizeController(), near, target(), 10)).toBe(null);
  });
});
