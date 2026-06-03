// Touch Resize — ComfyUI frontend extension (canvas-gesture pack).
//
// Served at /extensions/comfyui-touch-resize/js/touch-resize.js — the pack directory
// name IS this URL segment. Do not rename the pack dir without syncing
// EXT_NAME below.
//
// Pattern ("the gesture vein"): instead of intercepting a single widget,
// this pack adds a CANVAS-LEVEL pointer layer. A two-finger pinch whose
// centroid lands inside a *selected* node (single tap selects it) resizes
// that node and suppresses the native canvas zoom for the gesture's
// duration. Additive + mobile-first: if app.canvas or the pointer model is
// absent it does nothing and native corner-handle resize still works.
// Resize only writes node.size (already serialized) so no workflow breaks.
//
// Pure geometry helpers are exported and unit-tested (tests/js); the
// DOM/canvas wiring below is exercised in the manual browser matrix.

import { app } from "../../../scripts/app.js";

const EXT_NAME = "comfyui-touch-resize";

// LiteGraph maps a canvas point p to screen space as (p + ds.offset) * ds.scale.
const DEFAULT_TITLE_HEIGHT = 30; // LiteGraph.NODE_TITLE_HEIGHT default.

// --- Pure helpers (unit-tested) ----------------------------------------- //

/** Euclidean distance between two {x, y} pointers. */
export function pinchDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint between two {x, y} pointers. */
export function centroid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Is screen point (x, y) inside rect {x, y, w, h}? */
export function pointInRect(x, y, rect) {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}

/** Node bounding rect (incl. title bar) in screen space. */
export function nodeScreenRect(node, scale, offset, titleHeight = DEFAULT_TITLE_HEIGHT) {
  const x = (node.pos[0] + offset[0]) * scale;
  const yBody = (node.pos[1] + offset[1]) * scale;
  return {
    x,
    y: yBody - titleHeight * scale,
    w: node.size[0] * scale,
    h: node.size[1] * scale + titleHeight * scale,
  };
}

/**
 * New [w, h] after a uniform pinch scale, clamped to a minimum.
 * ratio = currentPinchDistance / startPinchDistance; minSize = [minW, minH].
 */
export function scaledSize(startSize, ratio, minSize = [0, 0]) {
  return [Math.max(minSize[0], startSize[0] * ratio), Math.max(minSize[1], startSize[1] * ratio)];
}

/** Selected nodes as an array, defensively across LiteGraph variants. */
export function selectedNodes(canvas) {
  if (!canvas) return [];
  const sel = canvas.selected_nodes;
  if (sel && typeof sel === "object") return Object.values(sel);
  if (canvas.selectedItems instanceof Set) {
    return [...canvas.selectedItems].filter((it) => it?.size && it?.pos);
  }
  return [];
}

// --- Wiring (DOM + canvas; browser-matrix tested) ----------------------- //

function installGestureLayer() {
  const canvas = app.canvas;
  const el = canvas?.canvas; // the actual <canvas> element
  if (!el) {
    console.warn(`[${EXT_NAME}] no canvas element — gesture layer not installed`);
    return;
  }

  const pointers = new Map(); // pointerId -> { x, y } in canvas-element-local space
  let lock = null; // { node, startDist, startSize, minSize }

  const localPoint = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function tryStartPinch() {
    if (pointers.size !== 2 || lock) return;
    const [p1, p2] = [...pointers.values()];
    const c = centroid(p1, p2);
    const scale = canvas.ds?.scale ?? 1;
    const offset = canvas.ds?.offset ?? [0, 0];
    for (const node of selectedNodes(canvas)) {
      if (pointInRect(c.x, c.y, nodeScreenRect(node, scale, offset))) {
        const minSize = typeof node.computeSize === "function" ? node.computeSize() : [0, 0];
        lock = {
          node,
          startDist: pinchDistance(p1, p2) || 1,
          startSize: [node.size[0], node.size[1]],
          minSize,
        };
        return;
      }
    }
  }

  el.addEventListener(
    "pointerdown",
    (e) => {
      pointers.set(e.pointerId, localPoint(e));
      tryStartPinch();
      if (lock) e.stopImmediatePropagation(); // suppress native pinch-zoom
    },
    true,
  );

  el.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, localPoint(e));
      if (!lock || pointers.size < 2) return;
      const [p1, p2] = [...pointers.values()];
      const ratio = pinchDistance(p1, p2) / lock.startDist;
      const [w, h] = scaledSize(lock.startSize, ratio, lock.minSize);
      lock.node.size[0] = w;
      lock.node.size[1] = h;
      lock.node.onResize?.(lock.node.size);
      canvas.setDirty(true, true);
      e.stopImmediatePropagation();
    },
    true,
  );

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lock = null;
  };
  el.addEventListener("pointerup", endPointer, true);
  el.addEventListener("pointercancel", endPointer, true);

  console.log(`[${EXT_NAME}] gesture layer installed — pinch a selected node to resize`);
}

app.registerExtension({
  name: "comfy.touch-resize",
  async setup() {
    installGestureLayer();
    // TODO: groups — extend selectedNodes()/nodeScreenRect() to graph._groups
    //   (group.pos/group.size; no title bar) so a pinch resizes groups too.
    // TODO: discoverability — draw a faint corner affordance on selected nodes
    //   (canvas onDrawForeground) so the pinch gesture is learnable.
    // TODO: optional anisotropic mode — decompose the two-finger vector into
    //   independent W/H instead of uniform scale (behind a config flag).
  },
});
