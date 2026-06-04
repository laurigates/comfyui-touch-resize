// Touch Resize — ComfyUI frontend extension (canvas-gesture pack).
//
// Served at /extensions/comfyui-touch-resize/js/touch-resize.js — the pack directory
// name IS this URL segment. Do not rename the pack dir without syncing
// EXT_NAME below.
//
// Pattern ("the gesture vein"): instead of intercepting a single widget,
// this pack adds a CANVAS-LEVEL pointer layer. A two-finger pinch whose
// centroid lands inside a *selected* node resizes that node and suppresses
// the native canvas zoom for the gesture's duration. Additive + mobile-first:
// if app.canvas or the pointer model is absent it does nothing and native
// corner-handle resize still works. Resize only writes node.size (already
// serialized) so no workflow breaks.
//
// ARCHITECTURE: the gesture decision-logic lives in a PURE reducer
// (createGestureController) that takes plain data — active pointers, normalized
// targets, config — and returns COMMANDS (lock / resize / release). It never
// touches the DOM or `app`, so it is fully unit-tested in tests/js. The DOM
// wiring (installGestureLayer) is a thin adapter: events → data, commands →
// mutation. It is exercised in the manual browser matrix (see CLAUDE.md).

import { app } from "../../../scripts/app.js";

const EXT_NAME = "comfyui-touch-resize";

// LiteGraph maps a canvas point p to screen space as (p + ds.offset) * ds.scale.
// LiteGraph.NODE_TITLE_HEIGHT = 30 (confirmed against the frontend sourcemap).
const DEFAULT_TITLE_HEIGHT = 30;

// Module config. No in-UI settings for v1 — tweak here and hard-refresh.
const CONFIG = {
  mode: "uniform", // "uniform" (hypot scale) — "aniso" added later
};

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

/**
 * Selected nodes as an array, defensively across LiteGraph variants.
 * `selected_nodes` is a Dictionary<LGraphNode> (nodes only); the `selectedItems`
 * Set holds nodes, groups, and reroutes, so the fallback filters to items that
 * look like nodes — pos + size + a computeSize() method (groups lack it).
 */
export function selectedNodes(canvas) {
  if (!canvas) return [];
  const sel = canvas.selected_nodes;
  if (sel && typeof sel === "object" && !(sel instanceof Set)) return Object.values(sel);
  if (canvas.selectedItems instanceof Set) {
    return [...canvas.selectedItems].filter(
      (it) => it?.pos && it?.size && typeof it.computeSize === "function",
    );
  }
  return [];
}

/**
 * Enumerate resize targets as normalized plain data the controller can reduce.
 * @typedef {{id:string,kind:"node"|"group",obj:object,
 *           screenRect:{x:number,y:number,w:number,h:number},
 *           size:[number,number],minSize:[number,number]}} Target
 * The controller treats a Target as opaque except id/screenRect/size/minSize;
 * `obj` is the adapter's handle for applying the resulting command.
 */
export function resolveTargets(canvas, _cfg = CONFIG) {
  const scale = canvas?.ds?.scale ?? 1;
  const offset = canvas?.ds?.offset ?? [0, 0];
  const targets = [];
  const nodes = selectedNodes(canvas);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    targets.push({
      id: `node:${n.id ?? i}`,
      kind: "node",
      obj: n,
      screenRect: nodeScreenRect(n, scale, offset),
      size: [n.size[0], n.size[1]],
      minSize: typeof n.computeSize === "function" ? n.computeSize() : [0, 0],
    });
  }
  return targets;
}

// --- Pure controller (the unit-tested reducer) -------------------------- //

/**
 * Gesture reducer. Pure: holds private lock state, takes plain pointer/target
 * data, returns commands. Never mutates nodes/groups or touches the DOM.
 *
 * @typedef {{id:number,x:number,y:number}} Pointer
 * @param {typeof CONFIG} _cfg reserved for mode selection (see anisotropic mode)
 */
export function createGestureController(_cfg = CONFIG) {
  // lock = null | { targetId, startDist, startSize:[w,h], minSize:[w,h] }
  let lock = null;

  return {
    /**
     * @param {Pointer[]} pointers active pointers (screen-local)
     * @param {Target[]} targets resize candidates
     * @returns {{type:"lock",targetId:string}|null}
     */
    onPointersChanged(pointers, targets) {
      if (pointers.length !== 2 || lock) return null;
      const [p1, p2] = pointers;
      const c = centroid(p1, p2);
      for (const t of targets) {
        if (pointInRect(c.x, c.y, t.screenRect)) {
          lock = {
            targetId: t.id,
            startDist: pinchDistance(p1, p2) || 1,
            startSize: [t.size[0], t.size[1]],
            minSize: t.minSize ?? [0, 0],
          };
          return { type: "lock", targetId: t.id };
        }
      }
      return null;
    },

    /**
     * @param {Pointer[]} pointers
     * @returns {{type:"resize",targetId:string,size:[number,number]}|null}
     */
    onPointersMoved(pointers) {
      if (!lock || pointers.length < 2) return null;
      const [p1, p2] = pointers;
      const ratio = pinchDistance(p1, p2) / lock.startDist;
      const size = scaledSize(lock.startSize, ratio, lock.minSize);
      return { type: "resize", targetId: lock.targetId, size };
    },

    /**
     * @param {number} pointerCount remaining active pointers
     * @returns {{type:"release",targetId:string}|null}
     */
    onPointerEnded(pointerCount) {
      if (pointerCount >= 2 || !lock) return null;
      const { targetId } = lock;
      lock = null;
      return { type: "release", targetId };
    },

    get locked() {
      return lock !== null;
    },
  };
}

// --- Wiring (DOM + canvas adapter; browser-matrix tested) --------------- //

function installGestureLayer() {
  const canvas = app.canvas;
  const el = canvas?.canvas; // the actual <canvas> element
  if (!el) {
    console.warn(`[${EXT_NAME}] no canvas element — gesture layer not installed`);
    return;
  }

  const controller = createGestureController(CONFIG);
  const pointers = new Map(); // pointerId -> { id, x, y } in canvas-element-local space
  let targetsById = new Map(); // Target.id -> Target (rebuilt per gesture)

  const localPoint = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointerList = () => [...pointers.values()];

  const applyResize = (cmd) => {
    const t = targetsById.get(cmd.targetId);
    if (!t) return;
    const [w, h] = cmd.size;
    t.obj.size[0] = w;
    t.obj.size[1] = h;
    t.obj.onResize?.(t.obj.size);
    canvas.setDirty(true, true);
  };

  el.addEventListener(
    "pointerdown",
    (e) => {
      pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
      if (pointers.size === 2 && !controller.locked) {
        const targets = resolveTargets(canvas, CONFIG);
        targetsById = new Map(targets.map((t) => [t.id, t]));
        const cmd = controller.onPointersChanged(pointerList(), targets);
        if (cmd?.type === "lock") e.stopImmediatePropagation(); // suppress native pinch handling
      }
    },
    true,
  );

  el.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
      if (!controller.locked) return;
      const cmd = controller.onPointersMoved(pointerList());
      if (cmd?.type === "resize") {
        applyResize(cmd);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );

  // Native canvas zoom is wheel-driven (processMouseWheel → ds.changeScale), and
  // browsers deliver two-finger pinch-zoom as ctrl+wheel — so suppressing it
  // during a locked gesture requires intercepting wheel, not just pointer events.
  el.addEventListener(
    "wheel",
    (e) => {
      if (controller.locked) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    { capture: true, passive: false },
  );

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    controller.onPointerEnded(pointers.size); // release command needs no DOM apply
  };
  el.addEventListener("pointerup", endPointer, true);
  el.addEventListener("pointercancel", endPointer, true);

  console.log(`[${EXT_NAME}] gesture layer installed — pinch a selected node to resize`);
}

app.registerExtension({
  name: "comfy.touch-resize",
  async setup() {
    installGestureLayer();
    // TODO: groups — resolveTargets() will enumerate selected groups too.
    // TODO: discoverability — draw a faint corner affordance on selected items.
    // TODO: optional anisotropic mode — independent W/H from the finger vector.
  },
});
