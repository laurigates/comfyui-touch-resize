/* web/dist bundle built by bun from src/ in this repository (see package.json). Inlines @laurigates/comfy-modal-kit (MIT) - a first-party library by the same publisher, published to npm with provenance attestation: https://www.npmjs.com/package/@laurigates/comfy-modal-kit */

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = { fieldProviders: [], activeModal: null, pointerClaim: null };
    g[KEY] = kit;
  }
  return kit;
}
function isModalActive() {
  return getKit().activeModal !== null;
}
function claimPointer(id) {
  getKit().pointerClaim = id;
}

// src/index.ts
import { app } from "/scripts/app.js";
var EXT_NAME = "comfyui-touch-resize";
var DEFAULT_TITLE_HEIGHT = 30;
var CONFIG = {
  showHandles: true,
  handleRadiusPx: 10,
  hitRadiusPx: 18,
  fillColor: "#ffb02e",
  strokeColor: "#1a1a1a",
  alpha: 0.95,
  activeScale: 1.35,
  groupMinSize: [140, 80]
};
function screenToGraph(point, scale, offset) {
  const s = scale || 1;
  return { x: point.x / s - offset[0], y: point.y / s - offset[1] };
}
function nodeHandleRect(node, titleHeight = DEFAULT_TITLE_HEIGHT) {
  return {
    x: node.pos[0],
    y: node.pos[1] - titleHeight,
    w: node.size[0],
    h: node.size[1] + titleHeight
  };
}
function groupHandleRect(group) {
  return { x: group.pos[0], y: group.pos[1], w: group.size[0], h: group.size[1] };
}
function handleCenters(rect) {
  const { x, y, w, h } = rect;
  return [
    { corner: "tl", x, y },
    { corner: "tr", x: x + w, y },
    { corner: "bl", x, y: y + h },
    { corner: "br", x: x + w, y: y + h }
  ];
}
function hitTestHandles(point, centers, radius) {
  let best = null;
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
function resizeFromCorner(startPos, startSize, corner, delta, minSize = [0, 0]) {
  const left = corner === "tl" || corner === "bl";
  const top = corner === "tl" || corner === "tr";
  const minW = Math.max(0, minSize[0] ?? 0);
  const minH = Math.max(0, minSize[1] ?? 0);
  const anchorX = left ? startPos[0] + startSize[0] : startPos[0];
  const anchorY = top ? startPos[1] + startSize[1] : startPos[1];
  const dragX = (left ? startPos[0] : startPos[0] + startSize[0]) + delta[0];
  const dragY = (top ? startPos[1] : startPos[1] + startSize[1]) + delta[1];
  const w = Math.max(minW, left ? anchorX - dragX : dragX - anchorX);
  const h = Math.max(minH, top ? anchorY - dragY : dragY - anchorY);
  return {
    pos: [left ? anchorX - w : anchorX, top ? anchorY - h : anchorY],
    size: [w, h]
  };
}
function selectedNodes(canvas) {
  if (!canvas)
    return [];
  const sel = canvas.selected_nodes;
  if (sel && typeof sel === "object" && !(sel instanceof Set))
    return Object.values(sel);
  if (canvas.selectedItems instanceof Set) {
    return [...canvas.selectedItems].filter((it) => it?.pos && it?.size && typeof it.computeSize === "function");
  }
  return [];
}
function selectedGroups(canvas) {
  if (!(canvas?.selectedItems instanceof Set))
    return [];
  return [...canvas.selectedItems].filter((it) => it?.pos && it?.size && typeof it.title === "string" && typeof it.computeSize !== "function");
}
function isResizable(it, kind) {
  const pinned = it.pinned === true || it.flags?.pinned === true;
  if (pinned)
    return false;
  return !(kind === "node" && it.flags?.collapsed === true);
}
function selectedResizables(canvas, cfg = CONFIG) {
  const targets = [];
  const nodes = selectedNodes(canvas);
  for (let i = 0;i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || !isResizable(n, "node"))
      continue;
    targets.push({
      id: `node:${n.id ?? i}`,
      kind: "node",
      obj: n,
      rect: nodeHandleRect(n),
      pos: [n.pos[0], n.pos[1]],
      size: [n.size[0], n.size[1]],
      minSize: typeof n.computeSize === "function" ? n.computeSize() : [0, 0]
    });
  }
  const groups = selectedGroups(canvas);
  for (let i = 0;i < groups.length; i++) {
    const g = groups[i];
    if (!g || !isResizable(g, "group"))
      continue;
    const key = g.id != null && g.id !== -1 ? g.id : `idx${i}`;
    targets.push({
      id: `group:${key}`,
      kind: "group",
      obj: g,
      rect: groupHandleRect(g),
      pos: [g.pos[0], g.pos[1]],
      size: [g.size[0], g.size[1]],
      minSize: cfg.groupMinSize ?? [0, 0]
    });
  }
  return targets;
}
function resolveTarget(canvas, cfg = CONFIG) {
  const targets = selectedResizables(canvas, cfg);
  return targets.length === 1 ? targets[0] ?? null : null;
}
function createResizeController() {
  let grab = null;
  return {
    onPointerDown(pointer, target, hitRadius) {
      if (grab || !target)
        return null;
      const corner = hitTestHandles(pointer, handleCenters(target.rect), hitRadius);
      if (!corner)
        return null;
      grab = {
        targetId: target.id,
        pointerId: pointer.id,
        corner,
        startPos: [target.pos[0], target.pos[1]],
        startSize: [target.size[0], target.size[1]],
        startPoint: { x: pointer.x, y: pointer.y },
        minSize: target.minSize ?? [0, 0]
      };
      return { type: "grab", targetId: target.id, corner };
    },
    onPointerMoved(pointer) {
      if (!grab || pointer.id !== grab.pointerId)
        return null;
      const delta = [pointer.x - grab.startPoint.x, pointer.y - grab.startPoint.y];
      const { pos, size } = resizeFromCorner(grab.startPos, grab.startSize, grab.corner, delta, grab.minSize);
      return { type: "resize", targetId: grab.targetId, pos, size };
    },
    onPointerEnded(pointerId) {
      if (!grab)
        return null;
      if (pointerId != null && pointerId !== grab.pointerId)
        return null;
      const { targetId } = grab;
      grab = null;
      return { type: "release", targetId };
    },
    reset() {
      return this.onPointerEnded(null);
    },
    get locked() {
      return grab !== null;
    },
    get activeCorner() {
      return grab?.corner ?? null;
    }
  };
}
function installHandleLayer(canvas, el) {
  const controller = createResizeController();
  let activeTarget = null;
  const graphPoint = (e) => {
    const r = el.getBoundingClientRect();
    return screenToGraph({ x: e.clientX - r.left, y: e.clientY - r.top }, canvas.ds?.scale ?? 1, canvas.ds?.offset ?? [0, 0]);
  };
  const pointerOf = (e) => ({ id: e.pointerId, ...graphPoint(e) });
  const onCanvas = (e) => e.target === el || (el.contains?.(e.target) ?? false);
  const captureRoot = window;
  const suppress = (e) => {
    e.stopImmediatePropagation();
    if (e.cancelable)
      e.preventDefault();
  };
  const applyResize = (cmd) => {
    const t = activeTarget;
    if (!t || t.id !== cmd.targetId)
      return;
    const [x, y] = cmd.pos;
    const [w, h] = cmd.size;
    if (t.obj.pos[0] !== x || t.obj.pos[1] !== y)
      t.obj.pos = [x, y];
    if (t.kind === "group") {
      t.obj.size = [w, h];
      t.obj.recomputeInsideNodes?.();
    } else if (typeof t.obj.setSize === "function") {
      t.obj.setSize([w, h]);
    } else {
      t.obj.size = [w, h];
      t.obj.onResize?.(t.obj.size);
    }
    canvas.setDirty?.(true, true);
  };
  const endGrab = () => {
    activeTarget = null;
    canvas.setDirty?.(true, true);
  };
  const forceRelease = () => {
    if (controller.reset())
      endGrab();
  };
  captureRoot.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted)
      return;
    if (!onCanvas(e))
      return;
    if (controller.locked) {
      forceRelease();
      return;
    }
    if (isModalActive())
      return;
    const target = resolveTarget(canvas, CONFIG);
    if (!target)
      return;
    const scale = canvas.ds?.scale || 1;
    const cmd = controller.onPointerDown(pointerOf(e), target, CONFIG.hitRadiusPx / scale);
    if (!cmd)
      return;
    activeTarget = target;
    claimPointer("touch-resize");
    suppress(e);
    canvas.setDirty?.(true, true);
  }, true);
  captureRoot.addEventListener("pointermove", (e) => {
    if (!e.isTrusted || !controller.locked)
      return;
    const cmd = controller.onPointerMoved(pointerOf(e));
    if (!cmd)
      return;
    applyResize(cmd);
    suppress(e);
  }, true);
  const endPointer = (e) => {
    if (!e.isTrusted || !controller.locked)
      return;
    if (!controller.onPointerEnded(e.pointerId))
      return;
    endGrab();
    suppress(e);
  };
  captureRoot.addEventListener("pointerup", endPointer, true);
  captureRoot.addEventListener("pointercancel", endPointer, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      forceRelease();
  });
  window.addEventListener("blur", forceRelease);
  console.log(`[${EXT_NAME}] handle layer installed — select a node, drag a corner circle`);
  return controller;
}
function drawHandles(ctx, canvas, cfg, activeCorner) {
  const target = resolveTarget(canvas, cfg);
  if (!target)
    return;
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
function installAffordance(canvas, cfg, activeCorner) {
  if (!canvas || !cfg.showHandles)
    return;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function(ctx, visibleRect) {
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
    const canvas = app.canvas;
    const el = canvas?.canvas;
    if (!canvas || !el) {
      console.warn(`[${EXT_NAME}] no canvas element — handle layer not installed`);
      return;
    }
    const controller = installHandleLayer(canvas, el);
    installAffordance(canvas, CONFIG, () => controller.activeCorner);
  }
});
export {
  selectedResizables,
  selectedNodes,
  selectedGroups,
  screenToGraph,
  resolveTarget,
  resizeFromCorner,
  nodeHandleRect,
  hitTestHandles,
  handleCenters,
  groupHandleRect,
  createResizeController
};
