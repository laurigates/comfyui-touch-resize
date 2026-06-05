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
  // "uniform" = hypot scale (default); "aniso" = independent W/H from the
  // two-finger vector's per-axis spread.
  mode: "uniform",
  // LGraphGroup self-clamps size to minWidth=140/minHeight=80; mirror that floor.
  groupMinSize: [140, 80],
  // Discoverability hint: a corner bracket on selected nodes/groups. A vivid
  // accent (not white) so the grab affordance stands out against both the dark
  // node body and the white selection outline. Tune hintColor/hintAlpha here.
  showHint: true,
  hintColor: "#ffb02e",
  hintAlpha: 0.9,
  hintSizePx: 18, // on-screen length; kept ~constant by dividing out ds.scale
  // Anisotropic degenerate-axis guard: if the fingers start aligned on an axis
  // (span ≤ anisoEps px) that axis falls back to the uniform ratio.
  anisoEps: 8,
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
 * New [w, h] for an anisotropic (independent W/H) pinch. startVec/curVec are
 * the two-finger vector [dx, dy] = p2 - p1 at lock and now. Each axis scales by
 * the change in that axis's |span|. If the start span on an axis is degenerate
 * (≤ eps, fingers aligned there) the axis falls back to the uniform hypot ratio
 * so it still tracks the gesture instead of dividing by ~0.
 */
export function anisoSize(startSize, startVec, curVec, minSize = [0, 0], eps = 8) {
  const startLen = Math.hypot(startVec[0], startVec[1]) || 1;
  const uniform = Math.hypot(curVec[0], curVec[1]) / startLen;
  const axisRatio = (start, cur) =>
    Math.abs(start) <= eps ? uniform : Math.abs(cur) / Math.abs(start);
  return [
    Math.max(minSize[0], startSize[0] * axisRatio(startVec[0], curVec[0])),
    Math.max(minSize[1], startSize[1] * axisRatio(startVec[1], curVec[1])),
  ];
}

/**
 * Bottom-right corner-bracket hint for rect {x,y,w,h}, as a 3-point poly-line
 * (up from the corner, then left). Pure: the caller strokes it. `sizePx` is
 * the bracket leg length in whatever space the rect is expressed in.
 */
export function cornerHintPath(rect, sizePx) {
  const x = rect.x + rect.w;
  const y = rect.y + rect.h;
  return [
    { x, y: y - sizePx },
    { x, y },
    { x: x - sizePx, y },
  ];
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
 * Group bounding rect in screen space. Unlike a node, a group's `pos` is the
 * top-left of the whole box (its title is drawn inside), so there is NO
 * title-bar offset to subtract.
 */
export function groupScreenRect(group, scale, offset) {
  return {
    x: (group.pos[0] + offset[0]) * scale,
    y: (group.pos[1] + offset[1]) * scale,
    w: group.size[0] * scale,
    h: group.size[1] * scale,
  };
}

/**
 * Selected groups from the `selectedItems` Set, discriminated by shape (the
 * LGraphGroup class is renamed under minification / forks, so `instanceof`
 * is unreliable). A group has pos + size + a string `title` but, unlike a
 * node, no computeSize() method; a reroute has no `size`.
 */
export function selectedGroups(canvas) {
  if (!(canvas?.selectedItems instanceof Set)) return [];
  return [...canvas.selectedItems].filter(
    (it) =>
      it?.pos && it?.size && typeof it.title === "string" && typeof it.computeSize !== "function",
  );
}

/**
 * Enumerate resize targets as normalized plain data the controller can reduce.
 * @typedef {{id:string,kind:"node"|"group",obj:object,
 *           screenRect:{x:number,y:number,w:number,h:number},
 *           size:[number,number],minSize:[number,number]}} Target
 * The controller treats a Target as opaque except id/screenRect/size/minSize;
 * `obj` is the adapter's handle for applying the resulting command.
 */
export function resolveTargets(canvas, cfg = CONFIG) {
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
  const groups = selectedGroups(canvas);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // group.id defaults to -1 and is not guaranteed unique — fall back to index.
    const key = g.id != null && g.id !== -1 ? g.id : `idx${i}`;
    targets.push({
      id: `group:${key}`,
      kind: "group",
      obj: g,
      screenRect: groupScreenRect(g, scale, offset),
      size: [g.size[0], g.size[1]],
      minSize: cfg.groupMinSize ?? [0, 0],
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
 * @param {typeof CONFIG} cfg selects uniform vs anisotropic resize (cfg.mode)
 */
export function createGestureController(cfg = CONFIG) {
  // lock = null | { targetId, pointerIds:[id,id], startDist, startVec:[dx,dy],
  //                 startSize:[w,h], minSize:[w,h] }
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
            // Remember exactly which two pointers own the gesture so lifting
            // either one ends it, and a stray third touch can never keep it
            // alive (see onPointerEnded).
            pointerIds: [p1.id, p2.id],
            startDist: pinchDistance(p1, p2) || 1,
            startVec: [p2.x - p1.x, p2.y - p1.y],
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
      let size;
      if (cfg.mode === "aniso") {
        const curVec = [p2.x - p1.x, p2.y - p1.y];
        size = anisoSize(lock.startSize, lock.startVec, curVec, lock.minSize, cfg.anisoEps);
      } else {
        const ratio = pinchDistance(p1, p2) / lock.startDist;
        size = scaledSize(lock.startSize, ratio, lock.minSize);
      }
      return { type: "resize", targetId: lock.targetId, size };
    },

    /**
     * End the gesture when one of its two pointers lifts. Releasing on the
     * *first* gesture pointer (rather than waiting for the active count to fall
     * below two) means a stray extra touch can never strand the lock. A
     * pointer that was not part of the gesture is ignored. Call with no id
     * (or a null id) to force-release from a non-pointer path (Escape, blur,
     * touch fallback) — see reset().
     * @param {number|null} [pointerId] the pointer that just ended
     * @returns {{type:"release",targetId:string}|null}
     */
    onPointerEnded(pointerId) {
      if (!lock) return null;
      if (pointerId != null && !lock.pointerIds.includes(pointerId)) return null;
      const { targetId } = lock;
      lock = null;
      return { type: "release", targetId };
    },

    /**
     * Unconditionally drop any active lock. Escape hatch for the adapter's
     * non-pointer release paths (Escape key, window blur, touch-stream
     * fallback) so the resize state can never get stuck.
     * @returns {{type:"release",targetId:string}|null}
     */
    reset() {
      if (!lock) return null;
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
  // Pointer/touch events on the canvas TARGET the <canvas> element, so they
  // reach it in the AT_TARGET phase where listeners fire in *registration*
  // order regardless of the capture flag. LiteGraph binds its handlers on the
  // same element in its constructor — before our setup() — so a capture-phase
  // listener on `el` would still run *after* LiteGraph's and lose the race:
  // the canvas zooms (and, for nodes, body-drag fires) before we can suppress.
  // Listening on an ANCESTOR in the capture phase fixes the ordering: ancestor
  // capture provably precedes any AT_TARGET listener. We gate suppression on
  // the lock so non-gesture interaction (single-finger drag, native zoom on
  // empty canvas, corner-handle resize) passes straight through to LiteGraph.
  const captureRoot = window;
  const onCanvas = (e) => e.target === el || (el.contains?.(e.target) ?? false);

  const applyResize = (cmd) => {
    const t = targetsById.get(cmd.targetId);
    if (!t) return;
    const [w, h] = cmd.size;
    t.obj.size[0] = w;
    t.obj.size[1] = h;
    if (t.kind === "group") {
      // Re-membership the group so dragging it still carries the right nodes.
      t.obj.recomputeInsideNodes?.();
    } else {
      t.obj.onResize?.(t.obj.size);
    }
    canvas.setDirty(true, true);
  };

  const suppress = (e) => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };

  captureRoot.addEventListener(
    "pointerdown",
    (e) => {
      if (!onCanvas(e)) return;
      pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
      if (pointers.size === 2 && !controller.locked) {
        const targets = resolveTargets(canvas, CONFIG);
        targetsById = new Map(targets.map((t) => [t.id, t]));
        const cmd = controller.onPointersChanged(pointerList(), targets);
        // Suppress the second-finger pointerdown so LiteGraph never enters its
        // pinch-zoom / multitouch path for this gesture.
        if (cmd?.type === "lock") suppress(e);
      }
    },
    true,
  );

  captureRoot.addEventListener(
    "pointermove",
    (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
      if (!controller.locked) return;
      const cmd = controller.onPointersMoved(pointerList());
      if (cmd?.type === "resize") applyResize(cmd);
      // While locked, swallow every move so LiteGraph neither zooms the canvas
      // nor drags the node body underneath the gesture.
      suppress(e);
    },
    true,
  );

  // Force-release: drop the lock and forget every tracked pointer. The escape
  // hatch behind every non-pointer exit path (Escape, blur, touch fallback) so
  // a missed terminal event can never strand the resize state. The release
  // command needs no DOM apply — clearing the lock un-gates suppression.
  const forceRelease = () => {
    pointers.clear();
    controller.reset();
  };

  // Hedges for the native-zoom paths that don't surface as the pointer stream:
  //   • ctrl+wheel — how browsers deliver trackpad pinch-zoom (processMouseWheel).
  //   • touchstart/move — some LiteGraph builds drive multitouch pinch off these
  //     rather than pointer events; touch-action:none stops the browser's own
  //     page zoom. No-ops unless a gesture is locked.
  // We deliberately do NOT suppress touchend/touchcancel: there is no native
  // zoom to stop on a finger lift, and swallowing the terminal touch can starve
  // the release path. Instead we use them as a fallback exit (below).
  el.style.touchAction = "none";
  captureRoot.addEventListener(
    "wheel",
    (e) => {
      if (controller.locked && onCanvas(e)) suppress(e);
    },
    { capture: true, passive: false },
  );
  for (const type of ["touchstart", "touchmove"]) {
    captureRoot.addEventListener(
      type,
      (e) => {
        if (controller.locked && onCanvas(e)) suppress(e);
      },
      { capture: true, passive: false },
    );
  }
  // Touch-stream fallback exit. On builds that derive pointer events from touch,
  // preventDefault-ing the move stream can drop the gesture pointers' terminal
  // pointerup/pointercancel — leaving the lock stuck. `touches` lists the
  // fingers STILL down (the lifted one moved to `changedTouches`), so once it
  // falls below two the pinch is over: release regardless of the pointer stream.
  const onTouchEnd = (e) => {
    if (controller.locked && (e.touches?.length ?? 0) < 2) forceRelease();
  };
  captureRoot.addEventListener("touchend", onTouchEnd, true);
  captureRoot.addEventListener("touchcancel", onTouchEnd, true);

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    // Let the controller decide: it releases on the first *gesture* pointer to
    // lift (ignoring strays). Passing the id even for untracked pointers is
    // safe and keeps the global listener honest.
    controller.onPointerEnded(e.pointerId);
  };
  captureRoot.addEventListener("pointerup", endPointer, true);
  // A pointercancel means the browser claimed the interaction — tear the whole
  // gesture down, not just the one pointer, so nothing is left half-locked.
  captureRoot.addEventListener(
    "pointercancel",
    (e) => {
      pointers.delete(e.pointerId);
      if (controller.locked) forceRelease();
    },
    true,
  );

  // Guaranteed manual exits, independent of the touch/pointer stream entirely:
  // Escape ends a stuck resize, and losing the window (app switch, alert) drops
  // it so you never return to a half-locked canvas.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && controller.locked) forceRelease();
  });
  window.addEventListener("blur", () => {
    if (controller.locked) forceRelease();
  });

  console.log(`[${EXT_NAME}] gesture layer installed — pinch a selected node to resize`);
}

// Stroke the corner hints. onDrawForeground runs UNDER the ds transform, so we
// draw in graph space (item.pos/size directly) and divide the on-screen length
// by ds.scale so the bracket stays ~constant size as the user zooms.
function drawHints(ctx, canvas, cfg) {
  const scale = canvas?.ds?.scale ?? 1;
  const items = [...selectedNodes(canvas), ...selectedGroups(canvas)];
  if (!items.length) return;
  const sizeG = cfg.hintSizePx / scale;
  ctx.save();
  ctx.globalAlpha = cfg.hintAlpha;
  ctx.strokeStyle = cfg.hintColor;
  ctx.lineWidth = 2.5 / scale;
  for (const it of items) {
    const pts = cornerHintPath({ x: it.pos[0], y: it.pos[1], w: it.size[0], h: it.size[1] }, sizeG);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

// Instance-chain onDrawForeground (not a prototype patch) so the overlay is
// additive and tears down cleanly if the canvas is replaced.
function installAffordance(canvas, cfg) {
  if (!canvas || !cfg.showHint) return;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function (ctx, visibleRect) {
    prev?.call(this, ctx, visibleRect);
    try {
      drawHints(ctx, this, cfg);
    } catch (err) {
      console.warn(`[${EXT_NAME}] hint draw failed`, err);
    }
  };
}

app.registerExtension({
  name: "comfy.touch-resize",
  async setup() {
    installGestureLayer();
    installAffordance(app.canvas, CONFIG);
  },
});
