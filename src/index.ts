// Touch Resize — ComfyUI frontend extension (canvas-affordance pack).
//
// Served at /extensions/comfyui-touch-resize/index.js — the pack directory
// name IS this URL segment. Do not rename the pack dir without syncing
// EXT_NAME below.
//
// WHAT THIS DOES: when exactly one node or group is selected, four big amber
// grab-handle circles are painted at the corners of its body. Dragging a
// handle resizes the item, anchoring the opposite corner (drag the top-left
// handle and the bottom-right corner stays put). Touch-first: the handles are
// drawn at a constant on-screen size and carry a hit radius roughly twice the
// drawn radius, so they stay reachable with a fingertip at any zoom level.
//
// WHY HANDLES AND NOT A PINCH GESTURE (this pack's v1, removed in v2):
// a two-finger pinch cannot be recognized until the SECOND finger lands, so
// the first finger's `pointerdown` has already reached LiteGraph and started a
// node-drag / canvas-pan transaction. Everything after that was damage
// control — suppressing the move stream, intercepting `wheel`, and trying to
// hand LiteGraph's half-open transaction back on release. A corner handle is
// hit-tested on the VERY FIRST `pointerdown`, so the event is suppressed
// before LiteGraph ever opens a transaction. There is no half-open state to
// recover from, which deletes that entire class of bug.
//
// COEXISTING WITH `Comfy.SimpleTouchSupport` (the built-in touch layer):
// it keeps a module-global `touchCount`, incremented on `touchstart` and
// decremented on `touchend`, and monkey-patches
// `LGraphCanvas.prototype.processMouseDown` to return early whenever that
// count is truthy. So a listener that swallows `touchstart` without also
// swallowing `touchend` drives the count NEGATIVE — which is truthy — and the
// canvas silently stops responding to taps until `resetTouchState` fires on
// `touchcancel` or `visibilitychange` (i.e. until you switch apps). v1 did
// exactly that. THE RULE: this pack touches ONLY the pointer-event stream and
// never `touchstart`/`touchmove`/`touchend`, so that count stays balanced.
//
// ARCHITECTURE: the drag decision-logic lives in a PURE reducer
// (createResizeController) that takes plain data — a pointer, a normalized
// target, a hit radius — and returns COMMANDS (grab / resize / release). It
// never touches the DOM or `app`, so it is fully unit-tested in tests/js. The
// DOM wiring (installHandleLayer) is a thin adapter: events → data, commands →
// mutation.
//
// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// emitted import string stays `/scripts/app.js` (bun's `--external '/scripts/*'`
// keeps it unbundled); the type is supplied via a `paths` mapping in
// tsconfig.json that points the import at `src/comfyui-shims.d.ts`. See the
// migration ADR (docs/blueprint/adrs/0001-adopt-typescript-bun-build.md).

import { claimPointer, isModalActive } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-touch-resize";

// LiteGraph maps a graph point p to screen space as (p + ds.offset) * ds.scale
// (DragAndScale.convertOffsetToCanvas); the inverse is p / scale - offset
// (convertCanvasToOffset). Both verified against the frontend sourcemap.
// LiteGraph.NODE_TITLE_HEIGHT = 30, and LGraphGroup.titleHeight returns it.
const DEFAULT_TITLE_HEIGHT = 30;

// ============================================================
// Types
// ============================================================

/** A rectangle. Graph space unless stated otherwise. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 2-tuple of [x, y] / [w, h] / [dx, dy] used throughout the geometry. */
type Vec2 = [number, number];

/** An {x, y} point. */
interface Point {
  x: number;
  y: number;
}

/** A pointer carrying its identifying id. */
interface Pointer extends Point {
  id: number;
}

/** Which corner a handle sits on. */
export type Corner = "tl" | "tr" | "bl" | "br";

/** A handle's centre, in the same space as the rect it came from. */
interface Handle extends Point {
  corner: Corner;
}

/**
 * Module config. No in-UI settings for v2 — tweak here and hard-refresh.
 */
interface Config {
  showHandles: boolean;
  handleRadiusPx: number;
  hitRadiusPx: number;
  fillColor: string;
  strokeColor: string;
  alpha: number;
  activeScale: number;
  groupMinSize: Vec2;
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
  flags?: { pinned?: boolean; collapsed?: boolean };
  pinned?: boolean;
  computeSize?: () => Vec2;
  setSize?: (size: Vec2) => void;
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
}

/**
 * A normalized resize target. `rect` is the graph-space box the handles are
 * drawn on; `pos`/`size` are the item's own serialized geometry, which is what
 * a resize actually writes. For a group the two differ by the title strip.
 */
interface Target {
  id: string;
  kind: "node" | "group";
  obj: GraphItem;
  rect: Rect;
  pos: Vec2;
  size: Vec2;
  minSize: Vec2;
}

/** Commands the pure reducer returns. */
type GrabCommand = { type: "grab"; targetId: string; corner: Corner };
type ResizeCommand = { type: "resize"; targetId: string; pos: Vec2; size: Vec2 };
type ReleaseCommand = { type: "release"; targetId: string };

interface ResizeController {
  onPointerDown(pointer: Pointer, target: Target | null, hitRadius: number): GrabCommand | null;
  onPointerMoved(pointer: Pointer): ResizeCommand | null;
  onPointerEnded(pointerId?: number | null): ReleaseCommand | null;
  reset(): ReleaseCommand | null;
  readonly locked: boolean;
  readonly activeCorner: Corner | null;
}

interface Grab {
  targetId: string;
  pointerId: number;
  corner: Corner;
  startPos: Vec2;
  startSize: Vec2;
  startPoint: Point;
  minSize: Vec2;
}

// Module config. No in-UI settings for v2 — tweak here and hard-refresh.
const CONFIG: Config = {
  showHandles: true,
  // Drawn radius and touch radius are deliberately DECOUPLED: a 10px circle
  // reads as a control without covering the node, while the larger hit radius
  // gives a ~36px touch target. Both are on-screen pixels, kept constant
  // across zoom by dividing out ds.scale.
  //
  // hitRadiusPx has a MEASURED CEILING: on a real KSampler render the
  // top-left handle sits ~21px from the title bar's collapse toggle, so a
  // radius at or above that swallows taps meant for it. Do not raise this
  // past ~20 without re-measuring the clearances noted on nodeHandleRect.
  handleRadiusPx: 10,
  hitRadiusPx: 18,
  // Vivid accent (the pack family's #ffb02e) so the handles stand out against
  // both the dark node body and the white selection outline; the dark ring
  // keeps them legible over a light node or a pale group.
  fillColor: "#ffb02e",
  strokeColor: "#1a1a1a",
  alpha: 0.95,
  // The grabbed handle swells, so a fingertip covering it still shows which
  // corner is being dragged.
  activeScale: 1.35,
  // LGraphGroup.size self-clamps to minWidth=140/minHeight=80; mirror that
  // floor so our pos math agrees with what the setter actually stores.
  groupMinSize: [140, 80],
};

// --- Pure helpers (unit-tested) ----------------------------------------- //

/**
 * Screen (canvas-element-local, CSS px) → graph space. The inverse of
 * LiteGraph's `convertOffsetToCanvas`; matches `DragAndScale.convertCanvasToOffset`.
 */
export function screenToGraph(point: Point, scale: number, offset: Vec2): Point {
  const s = scale || 1;
  return { x: point.x / s - offset[0], y: point.y / s - offset[1] };
}

/**
 * The graph-space box a NODE's handles sit on: its full visual outline. A
 * node's `pos` is the top-left of its BODY and the title bar is drawn ABOVE
 * it, so the rect starts one title height higher and is that much taller.
 *
 * Placing the top handles on the body's corners instead — level with the
 * title/body seam — puts them ~17px from the first input and output slots,
 * inside the hit radius, so tapping a slot on a selected node would grab a
 * handle instead of starting a link drag. Measured on a real KSampler render.
 * The title-bar corners are ~21px from the collapse toggle and ~45px from the
 * slots, which clears both. See CONFIG.hitRadiusPx before widening anything.
 */
export function nodeHandleRect(node: GraphItem, titleHeight = DEFAULT_TITLE_HEIGHT): Rect {
  return {
    x: node.pos[0],
    y: node.pos[1] - titleHeight,
    w: node.size[0],
    h: node.size[1] + titleHeight,
  };
}

/**
 * The graph-space box a GROUP's handles sit on. Unlike a node, a group's `pos`
 * IS the top-left of its whole visual box (its title is drawn inside), so the
 * box is used as-is. The top handles do land on the strip you drag the group
 * by, which is acceptable: that strip runs the full width and a group is at
 * least 140 wide, so only its two ends are covered.
 */
export function groupHandleRect(group: GraphItem): Rect {
  return { x: group.pos[0], y: group.pos[1], w: group.size[0], h: group.size[1] };
}

/** The four corner handle centres of a rect, in that rect's own space. */
export function handleCenters(rect: Rect): Handle[] {
  const { x, y, w, h } = rect;
  return [
    { corner: "tl", x, y },
    { corner: "tr", x: x + w, y },
    { corner: "bl", x, y: y + h },
    { corner: "br", x: x + w, y: y + h },
  ];
}

/**
 * Which handle (if any) a point grabs — the NEAREST centre within `radius`.
 * Nearest-wins matters on a small node, where the hit discs of adjacent
 * corners overlap and a first-match scan would grab the wrong corner.
 * Boundary-inclusive. `radius` is in the same space as the centres.
 */
export function hitTestHandles(point: Point, centers: Handle[], radius: number): Corner | null {
  let best: Corner | null = null;
  let bestDistSq = radius * radius;
  for (const c of centers) {
    const dx = point.x - c.x;
    const dy = point.y - c.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = c.corner;
    }
  }
  return best;
}

/**
 * New {pos, size} after dragging `corner` by `delta` (graph space), anchoring
 * the OPPOSITE corner so the item grows from where you grabbed it.
 *
 * Formulated around the anchor rather than by adding the delta to the size,
 * because that is what makes the min-size clamp behave: once a dimension hits
 * its floor the position stops moving too, instead of the box sliding away
 * from a corner that can no longer shrink.
 */
export function resizeFromCorner(
  startPos: Vec2,
  startSize: Vec2,
  corner: Corner,
  delta: Vec2,
  minSize: Vec2 = [0, 0],
): { pos: Vec2; size: Vec2 } {
  const left = corner === "tl" || corner === "bl";
  const top = corner === "tl" || corner === "tr";
  const minW = Math.max(0, minSize[0] ?? 0);
  const minH = Math.max(0, minSize[1] ?? 0);

  // The corner diagonally opposite the grabbed one — the fixed point.
  const anchorX = left ? startPos[0] + startSize[0] : startPos[0];
  const anchorY = top ? startPos[1] + startSize[1] : startPos[1];
  // Where the grabbed corner has been dragged to.
  const dragX = (left ? startPos[0] : startPos[0] + startSize[0]) + delta[0];
  const dragY = (top ? startPos[1] : startPos[1] + startSize[1]) + delta[1];

  const w = Math.max(minW, left ? anchorX - dragX : dragX - anchorX);
  const h = Math.max(minH, top ? anchorY - dragY : dragY - anchorY);

  return {
    pos: [left ? anchorX - w : anchorX, top ? anchorY - h : anchorY],
    size: [w, h],
  };
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
 * Pinned items refuse to be moved or resized by mouse interaction (LiteGraph's
 * own semantics for the flag), and a collapsed node has no body to grab. Either
 * way there is nothing to paint handles on.
 */
function isResizable(it: GraphItem, kind: "node" | "group"): boolean {
  const pinned = it.pinned === true || it.flags?.pinned === true;
  if (pinned) return false;
  return !(kind === "node" && it.flags?.collapsed === true);
}

/**
 * Enumerate resize targets as normalized plain data the controller can reduce.
 * The controller treats a Target as opaque except id/rect/pos/size/minSize;
 * `obj` is the adapter's handle for applying the resulting command.
 */
export function selectedResizables(
  canvas: CanvasLike | null | undefined,
  cfg: Config = CONFIG,
): Target[] {
  const targets: Target[] = [];
  const nodes = selectedNodes(canvas);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || !isResizable(n, "node")) continue;
    targets.push({
      id: `node:${n.id ?? i}`,
      kind: "node",
      obj: n,
      rect: nodeHandleRect(n),
      pos: [n.pos[0], n.pos[1]],
      size: [n.size[0], n.size[1]],
      minSize: typeof n.computeSize === "function" ? n.computeSize() : [0, 0],
    });
  }
  const groups = selectedGroups(canvas);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || !isResizable(g, "group")) continue;
    // group.id defaults to -1 and is not guaranteed unique — fall back to index.
    const key = g.id != null && g.id !== -1 ? g.id : `idx${i}`;
    targets.push({
      id: `group:${key}`,
      kind: "group",
      obj: g,
      rect: groupHandleRect(g),
      pos: [g.pos[0], g.pos[1]],
      size: [g.size[0], g.size[1]],
      minSize: cfg.groupMinSize ?? [0, 0],
    });
  }
  return targets;
}

/**
 * The single target to show handles on, or null. Handles are deliberately
 * SINGLE-SELECTION ONLY: a rubber-band select of ten nodes would otherwise
 * paint forty circles over the graph, and "which item does this handle
 * resize?" stops being answerable at a glance.
 */
export function resolveTarget(
  canvas: CanvasLike | null | undefined,
  cfg: Config = CONFIG,
): Target | null {
  const targets = selectedResizables(canvas, cfg);
  return targets.length === 1 ? (targets[0] ?? null) : null;
}

// --- Pure controller (the unit-tested reducer) -------------------------- //

/**
 * Drag reducer. Pure: holds private grab state, takes plain pointer/target
 * data, returns commands. Never mutates nodes/groups or touches the DOM.
 */
export function createResizeController(): ResizeController {
  let grab: Grab | null = null;

  return {
    /**
     * Try to start a drag. Returns a grab command only when the pointer lands
     * on one of the target's handles; otherwise null, and the adapter leaves
     * the event alone so LiteGraph handles it normally.
     */
    onPointerDown(pointer: Pointer, target: Target | null, hitRadius: number): GrabCommand | null {
      if (grab || !target) return null;
      const corner = hitTestHandles(pointer, handleCenters(target.rect), hitRadius);
      if (!corner) return null;
      grab = {
        targetId: target.id,
        pointerId: pointer.id,
        corner,
        startPos: [target.pos[0], target.pos[1]],
        startSize: [target.size[0], target.size[1]],
        startPoint: { x: pointer.x, y: pointer.y },
        minSize: target.minSize ?? [0, 0],
      };
      return { type: "grab", targetId: target.id, corner };
    },

    /**
     * Resize against the grab's ORIGINAL geometry and the total delta since
     * the grab, not incrementally frame to frame — so rounding and clamping
     * never accumulate, and a drag back to the start restores the start size
     * exactly.
     */
    onPointerMoved(pointer: Pointer): ResizeCommand | null {
      if (!grab || pointer.id !== grab.pointerId) return null;
      const delta: Vec2 = [pointer.x - grab.startPoint.x, pointer.y - grab.startPoint.y];
      const { pos, size } = resizeFromCorner(
        grab.startPos,
        grab.startSize,
        grab.corner,
        delta,
        grab.minSize,
      );
      return { type: "resize", targetId: grab.targetId, pos, size };
    },

    /**
     * End the drag. A pointer that is not the one holding the grab is ignored,
     * so a stray second touch lifting cannot end someone else's drag. Call
     * with no id (or null) to force-release from a non-pointer path.
     */
    onPointerEnded(pointerId?: number | null): ReleaseCommand | null {
      if (!grab) return null;
      if (pointerId != null && pointerId !== grab.pointerId) return null;
      const { targetId } = grab;
      grab = null;
      return { type: "release", targetId };
    },

    /** Unconditionally drop any active grab (Escape, blur, second finger). */
    reset(): ReleaseCommand | null {
      return this.onPointerEnded(null);
    },

    get locked(): boolean {
      return grab !== null;
    },

    get activeCorner(): Corner | null {
      return grab?.corner ?? null;
    },
  };
}

// --- Wiring (DOM + canvas adapter; browser-matrix tested) --------------- //

function installHandleLayer(canvas: CanvasLike, el: HTMLCanvasElement): ResizeController {
  const controller = createResizeController();
  // The target the active grab is mutating. Captured at grab time so a
  // selection change mid-drag cannot retarget the resize.
  let activeTarget: Target | null = null;

  const graphPoint = (e: PointerEvent): Point => {
    const r = el.getBoundingClientRect();
    return screenToGraph(
      { x: e.clientX - r.left, y: e.clientY - r.top },
      canvas.ds?.scale ?? 1,
      canvas.ds?.offset ?? [0, 0],
    );
  };
  const pointerOf = (e: PointerEvent): Pointer => ({ id: e.pointerId, ...graphPoint(e) });
  const onCanvas = (e: Event): boolean =>
    e.target === el || (el.contains?.(e.target as Node) ?? false);

  // Pointer events on the canvas TARGET the <canvas> element, so they reach it
  // in the AT_TARGET phase where listeners fire in *registration* order and the
  // capture flag is ignored. LiteGraph binds its handlers on that same element
  // in its constructor — before our setup() — so a capture listener on `el`
  // would still run AFTER LiteGraph's and lose the race. Listening on an
  // ANCESTOR (window) in the capture phase provably precedes any AT_TARGET
  // listener, which is what lets us suppress the grab's pointerdown before
  // LiteGraph opens a drag transaction on it.
  const captureRoot = window;
  const suppress = (e: Event): void => {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };

  const applyResize = (cmd: ResizeCommand): void => {
    const t = activeTarget;
    if (!t || t.id !== cmd.targetId) return;
    const [x, y] = cmd.pos;
    const [w, h] = cmd.size;

    // ASSIGN, never mutate the arrays in place. LGraphNode's `pos`/`size`
    // setters push the new geometry into the Vue layout store
    // (useLayoutMutations().moveNode / .resizeNode); an in-place
    // `obj.size[0] = w` skips the setter entirely, so the canvas redraws but
    // the layout store keeps the stale geometry. Verified in the sourcemap.
    // Only write pos when it actually changed — every write costs a store
    // mutation, and a bottom-right drag never moves it.
    if (t.obj.pos[0] !== x || t.obj.pos[1] !== y) t.obj.pos = [x, y];

    if (t.kind === "group") {
      t.obj.size = [w, h]; // setter self-clamps to LGraphGroup min size
      // Re-membership the group so dragging it still carries the right nodes.
      t.obj.recomputeInsideNodes?.();
    } else if (typeof t.obj.setSize === "function") {
      t.obj.setSize([w, h]); // assigns size AND fires onResize
    } else {
      t.obj.size = [w, h];
      t.obj.onResize?.(t.obj.size);
    }
    canvas.setDirty?.(true, true);
  };

  const endGrab = (): void => {
    activeTarget = null;
    canvas.setDirty?.(true, true);
  };
  const forceRelease = (): void => {
    if (controller.reset()) endGrab();
  };

  captureRoot.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (!e.isTrusted) return; // ignore synthetic events (SimpleTouchSupport's long-press right-click)
      if (!onCanvas(e)) return;

      // A second finger during a drag: abandon the resize and let it through,
      // so SimpleTouchSupport's two-finger pinch-zoom takes over cleanly
      // rather than the two gestures fighting over the same fingers.
      if (controller.locked) {
        forceRelease();
        return;
      }

      // Stand down while any pack's kit modal is open. `isModalActive()`
      // reflects a modal opened by ANY pack (all inlined kit copies share the
      // `Symbol.for` global), which is the intended cross-pack coordination.
      if (isModalActive()) return;

      const target = resolveTarget(canvas, CONFIG);
      if (!target) return;
      // Hit radius is specified on-screen; divide by scale to compare in graph
      // space, so the touch target stays the same physical size at any zoom.
      const scale = canvas.ds?.scale || 1;
      const cmd = controller.onPointerDown(pointerOf(e), target, CONFIG.hitRadiusPx / scale);
      if (!cmd) return; // not on a handle — leave the event entirely alone

      activeTarget = target;
      // Announce ownership of this gesture on the shared kit channel so peers
      // can observe who holds the pointer (advisory / observability).
      claimPointer("touch-resize");
      suppress(e);
      canvas.setDirty?.(true, true);
    },
    true,
  );

  captureRoot.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!e.isTrusted || !controller.locked) return;
      const cmd = controller.onPointerMoved(pointerOf(e));
      if (!cmd) return; // a different pointer — not ours to swallow
      applyResize(cmd);
      suppress(e);
    },
    true,
  );

  const endPointer = (e: PointerEvent): void => {
    if (!e.isTrusted || !controller.locked) return;
    if (!controller.onPointerEnded(e.pointerId)) return;
    endGrab();
    suppress(e);
  };
  captureRoot.addEventListener("pointerup", endPointer, true);
  captureRoot.addEventListener("pointercancel", endPointer, true);

  // Guaranteed manual exits, independent of the pointer stream: Escape ends a
  // stuck drag, and losing the window (app switch, alert) drops it so you never
  // return to a half-held handle. Both are no-ops when nothing is grabbed.
  //
  // NOTE the deliberate omission: v1 also hedged on touchstart/touchmove/wheel.
  // It must not — swallowing `touchstart` desynchronizes
  // Comfy.SimpleTouchSupport's `touchCount` and kills tap handling canvas-wide
  // (see the header). This layer is pointer-events-only, by design.
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") forceRelease();
  });
  window.addEventListener("blur", forceRelease);

  console.log(`[${EXT_NAME}] handle layer installed — select a node, drag a corner circle`);
  return controller;
}

// Paint the handles. onDrawForeground runs UNDER the ds transform (verified in
// the sourcemap: the canvas-level call sits inside the scale/translate block),
// so we draw in graph space and divide on-screen lengths by ds.scale to keep
// the circles a constant size as the user zooms.
function drawHandles(
  ctx: CanvasRenderingContext2D,
  canvas: CanvasLike,
  cfg: Config,
  activeCorner: Corner | null,
): void {
  const target = resolveTarget(canvas, cfg);
  if (!target) return;
  const scale = canvas.ds?.scale || 1;
  const radius = cfg.handleRadiusPx / scale;
  ctx.save();
  ctx.globalAlpha = cfg.alpha;
  ctx.fillStyle = cfg.fillColor;
  ctx.strokeStyle = cfg.strokeColor;
  ctx.lineWidth = 2 / scale;
  for (const handle of handleCenters(target.rect)) {
    const r = handle.corner === activeCorner ? radius * cfg.activeScale : radius;
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Instance-chain onDrawForeground (not a prototype patch) so the overlay is
// additive and tears down cleanly if the canvas is replaced.
function installAffordance(
  canvas: CanvasLike | undefined,
  cfg: Config,
  activeCorner: () => Corner | null,
): void {
  if (!canvas || !cfg.showHandles) return;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function (
    this: CanvasLike,
    ctx: CanvasRenderingContext2D,
    visibleRect: unknown,
  ): void {
    prev?.call(this, ctx, visibleRect);
    try {
      drawHandles(ctx, this, cfg, activeCorner());
    } catch (err) {
      console.warn(`[${EXT_NAME}] handle draw failed`, err);
    }
  };
}

app.registerExtension({
  name: "comfy.touch-resize",
  async setup() {
    const canvas = app.canvas as unknown as CanvasLike | undefined;
    const el = canvas?.canvas;
    if (!canvas || !el) {
      console.warn(`[${EXT_NAME}] no canvas element — handle layer not installed`);
      return;
    }
    const controller = installHandleLayer(canvas, el);
    installAffordance(canvas, CONFIG, () => controller.activeCorner);
  },
});
