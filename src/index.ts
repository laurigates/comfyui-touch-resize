// Touch Resize — ComfyUI frontend extension (canvas-gesture pack).
//
// Served at /extensions/comfyui-touch-resize/index.js — the pack directory
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
//
// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// emitted import string stays `/scripts/app.js` (bun's `--external '/scripts/*'`
// keeps it unbundled); the type is supplied via a `paths` mapping in
// tsconfig.json that points the import at `src/comfyui-shims.d.ts`. See the
// migration ADR (docs/blueprint/adrs/0001-adopt-typescript-bun-build.md).

import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-touch-resize";

// LiteGraph maps a canvas point p to screen space as (p + ds.offset) * ds.scale.
// LiteGraph.NODE_TITLE_HEIGHT = 30 (confirmed against the frontend sourcemap).
const DEFAULT_TITLE_HEIGHT = 30;

// ============================================================
// Types
// ============================================================

/** A screen-space rectangle. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2-tuple of [x, y] / [w, h] / [dx, dy] used throughout the geometry. */
type Vec2 = [number, number];

/** An {x, y} pointer position. */
interface Point {
  x: number;
  y: number;
}

/** An active pointer (screen-local) carrying its identifying id. */
interface Pointer {
  id: number;
  x: number;
  y: number;
}

/**
 * Module config. No in-UI settings for v1 — tweak here and hard-refresh.
 * `mode` selects uniform (hypot) vs anisotropic (per-axis) resize.
 */
interface Config {
  mode: "uniform" | "aniso";
  groupMinSize: Vec2;
  showHint: boolean;
  hintColor: string;
  hintAlpha: number;
  hintSizePx: number;
  anisoEps: number;
}

/**
 * Minimal structural shape of a LiteGraph node/group this pack reaches into.
 * The package's `LGraphNode` / `LGraphGroup` types are not exported, so the
 * small surface used here is modelled locally (narrow blast radius). Only the
 * members actually touched are declared.
 */
interface GraphItem {
  id?: number | null;
  pos: Vec2;
  size: Vec2;
  title?: string;
  computeSize?: () => Vec2;
  recomputeInsideNodes?: () => void;
  onResize?: (size: Vec2) => void;
}

/** The minified-canvas surface this pack reads. All members are optional/defensive. */
interface CanvasLike {
  canvas?: HTMLCanvasElement;
  ds?: { scale?: number; offset?: Vec2 };
  selected_nodes?: Record<string, GraphItem> | Set<GraphItem> | null;
  selectedItems?: Set<GraphItem>;
  setDirty?: (fg: boolean, bg: boolean) => void;
  onDrawForeground?:
    | ((this: CanvasLike, ctx: CanvasRenderingContext2D, visibleRect: unknown) => void)
    | null;
  // Pointer / drag state we reset on gesture-release to recover LiteGraph from
  // the "stuck in two-finger mode" it enters when we starve its event stream
  // (see recoverNativePointerState). Names verified against the frontend
  // sourcemap (CanvasPointer.ts / LGraphCanvas.ts). All optional — a build that
  // lacks a field simply skips it.
  pointer?: { reset?: () => void }; // CanvasPointer — reset() releases capture + clears isDown/dragStarted
  state?: { draggingCanvas?: boolean; draggingItems?: boolean };
  dragging_canvas?: boolean;
  last_mouse_dragging?: boolean;
  last_click_position?: unknown;
  dragging_rectangle?: unknown;
  connecting_links?: unknown;
  resizingGroup?: unknown;
  node_capturing_input?: unknown;
}

/**
 * A normalized resize target the controller can reduce. The controller treats
 * a Target as opaque except id/screenRect/size/minSize; `obj` is the adapter's
 * handle for applying the resulting command.
 */
interface Target {
  id: string;
  kind: "node" | "group";
  obj: GraphItem;
  screenRect: Rect;
  size: Vec2;
  minSize: Vec2;
}

/** Commands the pure reducer returns. */
type LockCommand = { type: "lock"; targetId: string };
type ResizeCommand = { type: "resize"; targetId: string; size: Vec2 };
type ReleaseCommand = { type: "release"; targetId: string };

interface GestureController {
  onPointersChanged(pointers: Pointer[], targets: Target[]): LockCommand | null;
  onPointersMoved(pointers: Pointer[]): ResizeCommand | null;
  onPointerEnded(pointerId?: number | null): ReleaseCommand | null;
  reset(): ReleaseCommand | null;
  readonly locked: boolean;
}

interface Lock {
  targetId: string;
  pointerIds: [number, number];
  startDist: number;
  startVec: Vec2;
  startSize: Vec2;
  minSize: Vec2;
}

// Module config. No in-UI settings for v1 — tweak here and hard-refresh.
const CONFIG: Config = {
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
export function pinchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Midpoint between two {x, y} pointers. */
export function centroid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Is screen point (x, y) inside rect {x, y, w, h}? */
export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}

/** Node bounding rect (incl. title bar) in screen space. */
export function nodeScreenRect(
  node: GraphItem,
  scale: number,
  offset: Vec2,
  titleHeight: number = DEFAULT_TITLE_HEIGHT,
): Rect {
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
export function scaledSize(startSize: Vec2, ratio: number, minSize: Vec2 = [0, 0]): Vec2 {
  return [Math.max(minSize[0], startSize[0] * ratio), Math.max(minSize[1], startSize[1] * ratio)];
}

/**
 * New [w, h] for an anisotropic (independent W/H) pinch. startVec/curVec are
 * the two-finger vector [dx, dy] = p2 - p1 at lock and now. Each axis scales by
 * the change in that axis's |span|. If the start span on an axis is degenerate
 * (≤ eps, fingers aligned there) the axis falls back to the uniform hypot ratio
 * so it still tracks the gesture instead of dividing by ~0.
 */
export function anisoSize(
  startSize: Vec2,
  startVec: Vec2,
  curVec: Vec2,
  minSize: Vec2 = [0, 0],
  eps = 8,
): Vec2 {
  const startLen = Math.hypot(startVec[0], startVec[1]) || 1;
  const uniform = Math.hypot(curVec[0], curVec[1]) / startLen;
  const axisRatio = (start: number, cur: number): number =>
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
export function cornerHintPath(rect: Rect, sizePx: number): Point[] {
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
export function selectedNodes(canvas: CanvasLike | null | undefined): GraphItem[] {
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
export function groupScreenRect(group: GraphItem, scale: number, offset: Vec2): Rect {
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
export function selectedGroups(canvas: CanvasLike | null | undefined): GraphItem[] {
  if (!(canvas?.selectedItems instanceof Set)) return [];
  return [...canvas.selectedItems].filter(
    (it) =>
      it?.pos && it?.size && typeof it.title === "string" && typeof it.computeSize !== "function",
  );
}

/**
 * Enumerate resize targets as normalized plain data the controller can reduce.
 * The controller treats a Target as opaque except id/screenRect/size/minSize;
 * `obj` is the adapter's handle for applying the resulting command.
 */
export function resolveTargets(
  canvas: CanvasLike | null | undefined,
  cfg: Config = CONFIG,
): Target[] {
  const scale = canvas?.ds?.scale ?? 1;
  const offset = canvas?.ds?.offset ?? [0, 0];
  const targets: Target[] = [];
  const nodes = selectedNodes(canvas);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
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
    if (!g) continue;
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
 * `cfg` selects uniform vs anisotropic resize (cfg.mode). A partial cfg is
 * accepted (the tests pass `{}` / `{ mode }`); missing fields default per
 * CONFIG semantics (unset mode ⇒ uniform).
 */
export function createGestureController(cfg: Partial<Config> = CONFIG): GestureController {
  let lock: Lock | null = null;

  return {
    onPointersChanged(pointers: Pointer[], targets: Target[]): LockCommand | null {
      if (pointers.length !== 2 || lock) return null;
      const [p1, p2] = pointers;
      if (!p1 || !p2) return null;
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

    onPointersMoved(pointers: Pointer[]): ResizeCommand | null {
      if (!lock || pointers.length < 2) return null;
      const [p1, p2] = pointers;
      if (!p1 || !p2) return null;
      let size: Vec2;
      if (cfg.mode === "aniso") {
        const curVec: Vec2 = [p2.x - p1.x, p2.y - p1.y];
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
     */
    onPointerEnded(pointerId?: number | null): ReleaseCommand | null {
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
     */
    reset(): ReleaseCommand | null {
      if (!lock) return null;
      const { targetId } = lock;
      lock = null;
      return { type: "release", targetId };
    },

    get locked(): boolean {
      return lock !== null;
    },
  };
}

// --- Wiring (DOM + canvas adapter; browser-matrix tested) --------------- //

function installGestureLayer(): void {
  const canvas = app.canvas as CanvasLike | undefined;
  const el = canvas?.canvas; // the actual <canvas> element
  if (!canvas || !el) {
    console.warn(`[${EXT_NAME}] no canvas element — gesture layer not installed`);
    return;
  }

  const controller = createGestureController(CONFIG);
  const pointers = new Map<number, Pointer>(); // pointerId -> pointer in canvas-element-local space
  let targetsById = new Map<string, Target>(); // Target.id -> Target (rebuilt per gesture)
  let gestureIds: number[] = []; // the pointer ids that locked the active gesture

  const localPoint = (e: PointerEvent): Point => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointerList = (): Pointer[] => [...pointers.values()];
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
  const onCanvas = (e: Event): boolean =>
    e.target === el || (el.contains?.(e.target as Node) ?? false);

  const applyResize = (cmd: ResizeCommand): void => {
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
    canvas.setDirty?.(true, true);
  };

  const suppress = (e: Event): void => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };

  captureRoot.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (!onCanvas(e)) return;
      pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
      if (pointers.size === 2 && !controller.locked) {
        const targets = resolveTargets(canvas, CONFIG);
        targetsById = new Map(targets.map((t) => [t.id, t]));
        const cmd = controller.onPointersChanged(pointerList(), targets);
        // Suppress the second-finger pointerdown so LiteGraph never enters its
        // pinch-zoom / multitouch path for this gesture. Remember the gesture's
        // pointer ids so we can hand them back to LiteGraph on release.
        if (cmd?.type === "lock") {
          gestureIds = pointerList().map((p) => p.id);
          suppress(e);
        }
      }
    },
    true,
  );

  captureRoot.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
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

  // Recover LiteGraph's own pointer/drag state on gesture-release. The FIRST
  // finger's pointerdown reaches LiteGraph before the second finger locks the
  // gesture, so LiteGraph starts a drag/pan (setPointerCapture on that pointer
  // + canvas-level drag flags) and we then starve its event stream. Left
  // mid-transaction, LiteGraph stays "stuck in two-finger mode" after a resize:
  // the canvas won't pan and a tap won't deselect, until a window blur (app
  // switch) resets it.
  //
  // Grounded in the frontend sourcemap (CanvasPointer.ts / LGraphCanvas.ts):
  //   • LiteGraph's own `processMouseCancel` runs ONLY `this.pointer.reset()`,
  //     which releases pointer capture + clears isDown/dragStarted but does NOT
  //     clear the canvas-level drag flags (dragging_canvas, last_mouse_dragging,
  //     connecting_links, state.draggingCanvas, …). Those are cleared only by
  //     `processMouseUp`. So a lone synthetic `pointercancel` UNDER-clears — the
  //     drag flags stay set, which IS the stuck state. (The original code did
  //     exactly this, which is why the stick persisted until an app-switch.)
  //
  // Two layers, both additive + defensive (feature-detected, wrapped) so this is
  // a no-op on a build whose shape differs:
  //   (a) replay the synthetic `pointercancel` — the faithful capture-teardown
  //       LiteGraph's own handler consumes; our listeners ignore it (isTrusted
  //       === false) so it can't perturb the gesture's own state; and
  //   (b) directly reset the pointer AND clear the canvas-level drag flags that
  //       pointercancel leaves set (the ones processMouseUp would clear), so pan
  //       + tap-deselect work again immediately on finger-lift — no app-switch.
  // Selection is deliberately left untouched (we never clear selected_nodes /
  // selectedItems), so the corner-hint affordance survives the recovery.
  const recoverNativePointerState = (): void => {
    // (a) Faithful capture-teardown for the gesture's pointer ids.
    try {
      for (const id of gestureIds) {
        el.dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: id, bubbles: true, cancelable: true }),
        );
      }
    } catch {
      /* PointerEvent unavailable here — the direct reset below still runs. */
    }
    gestureIds = [];

    // (b) Authoritative reset via LiteGraph's real API surface. pointer.reset()
    //     is what processMouseCancel calls; the flag clears finish what
    //     pointercancel leaves set (what processMouseUp would have cleared).
    try {
      canvas.pointer?.reset?.();
      if (canvas.state) {
        canvas.state.draggingCanvas = false;
        canvas.state.draggingItems = false;
      }
      canvas.dragging_canvas = false;
      canvas.last_mouse_dragging = false;
      canvas.last_click_position = null;
      canvas.dragging_rectangle = null;
      canvas.connecting_links = null;
      canvas.resizingGroup = null;
      canvas.node_capturing_input = null;
      canvas.setDirty?.(true, true);
    } catch (err) {
      console.warn(`[${EXT_NAME}] native pointer-state recovery failed`, err);
    }
  };

  // Force-release: drop the lock, forget every tracked pointer, and clean up
  // LiteGraph's pointer state. The escape hatch behind every non-pointer exit
  // path (Escape, blur, touch fallback) so a missed terminal event can never
  // strand the resize state. We only touch LiteGraph when a lock was actually
  // held (reset returns a release) so idle Escape/blur stay no-ops.
  const forceRelease = (): void => {
    const released = controller.reset()?.type === "release";
    pointers.clear();
    if (released) recoverNativePointerState();
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
    (e: WheelEvent) => {
      if (controller.locked && onCanvas(e)) suppress(e);
    },
    { capture: true, passive: false },
  );
  for (const type of ["touchstart", "touchmove"] as const) {
    captureRoot.addEventListener(
      type,
      (e: TouchEvent) => {
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
  const onTouchEnd = (e: TouchEvent): void => {
    if (controller.locked && (e.touches?.length ?? 0) < 2) forceRelease();
  };
  captureRoot.addEventListener("touchend", onTouchEnd, true);
  captureRoot.addEventListener("touchcancel", onTouchEnd, true);

  const endPointer = (e: PointerEvent): void => {
    if (!e.isTrusted) return; // ignore the synthetic cancels we dispatch on release
    pointers.delete(e.pointerId);
    // Let the controller decide: it releases on the first *gesture* pointer to
    // lift (ignoring strays). Passing the id even for untracked pointers is
    // safe and keeps the global listener honest.
    const cmd = controller.onPointerEnded(e.pointerId);
    if (cmd?.type === "release") {
      pointers.clear();
      recoverNativePointerState();
    }
  };
  captureRoot.addEventListener("pointerup", endPointer, true);
  // A pointercancel means the browser claimed the interaction — tear the whole
  // gesture down, not just the one pointer, so nothing is left half-locked.
  captureRoot.addEventListener(
    "pointercancel",
    (e: PointerEvent) => {
      if (!e.isTrusted) return; // our own release-time cancels re-enter here
      pointers.delete(e.pointerId);
      if (controller.locked) forceRelease();
    },
    true,
  );

  // Guaranteed manual exits, independent of the touch/pointer stream entirely:
  // Escape ends a stuck resize, and losing the window (app switch, alert) drops
  // it so you never return to a half-locked canvas.
  window.addEventListener("keydown", (e: KeyboardEvent) => {
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
function drawHints(ctx: CanvasRenderingContext2D, canvas: CanvasLike, cfg: Config): void {
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
    const first = pts[0];
    if (!first) continue;
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) {
      const pt = pts[i];
      if (pt) ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Instance-chain onDrawForeground (not a prototype patch) so the overlay is
// additive and tears down cleanly if the canvas is replaced.
function installAffordance(canvas: CanvasLike | undefined, cfg: Config): void {
  if (!canvas || !cfg.showHint) return;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function (
    this: CanvasLike,
    ctx: CanvasRenderingContext2D,
    visibleRect: unknown,
  ): void {
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
    installAffordance(app.canvas as unknown as CanvasLike | undefined, CONFIG);
  },
});
