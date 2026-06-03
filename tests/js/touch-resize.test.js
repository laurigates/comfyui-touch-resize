import { describe, expect, it } from "vitest";
import { pinchDistance, pointInRect, scaledSize } from "../../web/js/touch-resize.js";

// Smoke tests so `npm test` is green from the first commit. Exercise the pure
// gesture helpers; importing the module also confirms the registerExtension
// wiring loads cleanly. Add a jsdom test for installGestureLayer's pointer
// handling as the real resize logic lands.
describe("comfyui-touch-resize gesture helpers", () => {
  it("measures pinch distance", () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("hit-tests a screen point against a rect", () => {
    const rect = { x: 10, y: 10, w: 100, h: 50 };
    expect(pointInRect(50, 30, rect)).toBe(true);
    expect(pointInRect(5, 30, rect)).toBe(false);
  });

  it("uniform-scales and clamps to a minimum size", () => {
    expect(scaledSize([200, 100], 1.5)).toEqual([300, 150]);
    expect(scaledSize([200, 100], 0.1, [120, 60])).toEqual([120, 60]);
  });
});
