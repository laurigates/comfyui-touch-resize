// src/index.ts
import { app } from "/scripts/app.js";
var EXT_NAME = "comfyui-touch-resize";
var DEFAULT_TITLE_HEIGHT = 30;
var CONFIG = {
  mode: "uniform",
  groupMinSize: [140, 80],
  showHint: true,
  hintColor: "#ffb02e",
  hintAlpha: 0.9,
  hintSizePx: 18,
  anisoEps: 8
};
function pinchDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function centroid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function pointInRect(x, y, rect) {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}
function nodeScreenRect(node, scale, offset, titleHeight = DEFAULT_TITLE_HEIGHT) {
  const x = (node.pos[0] + offset[0]) * scale;
  const yBody = (node.pos[1] + offset[1]) * scale;
  return {
    x,
    y: yBody - titleHeight * scale,
    w: node.size[0] * scale,
    h: node.size[1] * scale + titleHeight * scale
  };
}
function scaledSize(startSize, ratio, minSize = [0, 0]) {
  return [Math.max(minSize[0], startSize[0] * ratio), Math.max(minSize[1], startSize[1] * ratio)];
}
function anisoSize(startSize, startVec, curVec, minSize = [0, 0], eps = 8) {
  const startLen = Math.hypot(startVec[0], startVec[1]) || 1;
  const uniform = Math.hypot(curVec[0], curVec[1]) / startLen;
  const axisRatio = (start, cur) => Math.abs(start) <= eps ? uniform : Math.abs(cur) / Math.abs(start);
  return [
    Math.max(minSize[0], startSize[0] * axisRatio(startVec[0], curVec[0])),
    Math.max(minSize[1], startSize[1] * axisRatio(startVec[1], curVec[1]))
  ];
}
function cornerHintPath(rect, sizePx) {
  const x = rect.x + rect.w;
  const y = rect.y + rect.h;
  return [
    { x, y: y - sizePx },
    { x, y },
    { x: x - sizePx, y }
  ];
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
function groupScreenRect(group, scale, offset) {
  return {
    x: (group.pos[0] + offset[0]) * scale,
    y: (group.pos[1] + offset[1]) * scale,
    w: group.size[0] * scale,
    h: group.size[1] * scale
  };
}
function selectedGroups(canvas) {
  if (!(canvas?.selectedItems instanceof Set))
    return [];
  return [...canvas.selectedItems].filter((it) => it?.pos && it?.size && typeof it.title === "string" && typeof it.computeSize !== "function");
}
function resolveTargets(canvas, cfg = CONFIG) {
  const scale = canvas?.ds?.scale ?? 1;
  const offset = canvas?.ds?.offset ?? [0, 0];
  const targets = [];
  const nodes = selectedNodes(canvas);
  for (let i = 0;i < nodes.length; i++) {
    const n = nodes[i];
    if (!n)
      continue;
    targets.push({
      id: `node:${n.id ?? i}`,
      kind: "node",
      obj: n,
      screenRect: nodeScreenRect(n, scale, offset),
      size: [n.size[0], n.size[1]],
      minSize: typeof n.computeSize === "function" ? n.computeSize() : [0, 0]
    });
  }
  const groups = selectedGroups(canvas);
  for (let i = 0;i < groups.length; i++) {
    const g = groups[i];
    if (!g)
      continue;
    const key = g.id != null && g.id !== -1 ? g.id : `idx${i}`;
    targets.push({
      id: `group:${key}`,
      kind: "group",
      obj: g,
      screenRect: groupScreenRect(g, scale, offset),
      size: [g.size[0], g.size[1]],
      minSize: cfg.groupMinSize ?? [0, 0]
    });
  }
  return targets;
}
function createGestureController(cfg = CONFIG) {
  let lock = null;
  return {
    onPointersChanged(pointers, targets) {
      if (pointers.length !== 2 || lock)
        return null;
      const [p1, p2] = pointers;
      if (!p1 || !p2)
        return null;
      const c = centroid(p1, p2);
      for (const t of targets) {
        if (pointInRect(c.x, c.y, t.screenRect)) {
          lock = {
            targetId: t.id,
            pointerIds: [p1.id, p2.id],
            startDist: pinchDistance(p1, p2) || 1,
            startVec: [p2.x - p1.x, p2.y - p1.y],
            startSize: [t.size[0], t.size[1]],
            minSize: t.minSize ?? [0, 0]
          };
          return { type: "lock", targetId: t.id };
        }
      }
      return null;
    },
    onPointersMoved(pointers) {
      if (!lock || pointers.length < 2)
        return null;
      const [p1, p2] = pointers;
      if (!p1 || !p2)
        return null;
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
    onPointerEnded(pointerId) {
      if (!lock)
        return null;
      if (pointerId != null && !lock.pointerIds.includes(pointerId))
        return null;
      const { targetId } = lock;
      lock = null;
      return { type: "release", targetId };
    },
    reset() {
      if (!lock)
        return null;
      const { targetId } = lock;
      lock = null;
      return { type: "release", targetId };
    },
    get locked() {
      return lock !== null;
    }
  };
}
function installGestureLayer() {
  const canvas = app.canvas;
  const el = canvas?.canvas;
  if (!canvas || !el) {
    console.warn(`[${EXT_NAME}] no canvas element — gesture layer not installed`);
    return;
  }
  const controller = createGestureController(CONFIG);
  const pointers = new Map;
  let targetsById = new Map;
  let gestureIds = [];
  const localPoint = (e) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointerList = () => [...pointers.values()];
  const captureRoot = window;
  const onCanvas = (e) => e.target === el || (el.contains?.(e.target) ?? false);
  const applyResize = (cmd) => {
    const t = targetsById.get(cmd.targetId);
    if (!t)
      return;
    const [w, h] = cmd.size;
    t.obj.size[0] = w;
    t.obj.size[1] = h;
    if (t.kind === "group") {
      t.obj.recomputeInsideNodes?.();
    } else {
      t.obj.onResize?.(t.obj.size);
    }
    canvas.setDirty?.(true, true);
  };
  const suppress = (e) => {
    e.stopImmediatePropagation();
    if (e.cancelable)
      e.preventDefault();
  };
  captureRoot.addEventListener("pointerdown", (e) => {
    if (!onCanvas(e))
      return;
    pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
    if (pointers.size === 2 && !controller.locked) {
      const targets = resolveTargets(canvas, CONFIG);
      targetsById = new Map(targets.map((t) => [t.id, t]));
      const cmd = controller.onPointersChanged(pointerList(), targets);
      if (cmd?.type === "lock") {
        gestureIds = pointerList().map((p) => p.id);
        suppress(e);
      }
    }
  }, true);
  captureRoot.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId))
      return;
    pointers.set(e.pointerId, { id: e.pointerId, ...localPoint(e) });
    if (!controller.locked)
      return;
    const cmd = controller.onPointersMoved(pointerList());
    if (cmd?.type === "resize")
      applyResize(cmd);
    suppress(e);
  }, true);
  const recoverNativePointerState = () => {
    try {
      for (const id of gestureIds) {
        el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true, cancelable: true }));
      }
    } catch {}
    gestureIds = [];
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
  const forceRelease = () => {
    const released = controller.reset()?.type === "release";
    pointers.clear();
    if (released)
      recoverNativePointerState();
  };
  el.style.touchAction = "none";
  captureRoot.addEventListener("wheel", (e) => {
    if (controller.locked && onCanvas(e))
      suppress(e);
  }, { capture: true, passive: false });
  for (const type of ["touchstart", "touchmove"]) {
    captureRoot.addEventListener(type, (e) => {
      if (controller.locked && onCanvas(e))
        suppress(e);
    }, { capture: true, passive: false });
  }
  const onTouchEnd = (e) => {
    if (controller.locked && (e.touches?.length ?? 0) < 2)
      forceRelease();
  };
  captureRoot.addEventListener("touchend", onTouchEnd, true);
  captureRoot.addEventListener("touchcancel", onTouchEnd, true);
  const endPointer = (e) => {
    if (!e.isTrusted)
      return;
    pointers.delete(e.pointerId);
    const cmd = controller.onPointerEnded(e.pointerId);
    if (cmd?.type === "release") {
      pointers.clear();
      recoverNativePointerState();
    }
  };
  captureRoot.addEventListener("pointerup", endPointer, true);
  captureRoot.addEventListener("pointercancel", (e) => {
    if (!e.isTrusted)
      return;
    pointers.delete(e.pointerId);
    if (controller.locked)
      forceRelease();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && controller.locked)
      forceRelease();
  });
  window.addEventListener("blur", () => {
    if (controller.locked)
      forceRelease();
  });
  console.log(`[${EXT_NAME}] gesture layer installed — pinch a selected node to resize`);
}
function drawHints(ctx, canvas, cfg) {
  const scale = canvas?.ds?.scale ?? 1;
  const items = [...selectedNodes(canvas), ...selectedGroups(canvas)];
  if (!items.length)
    return;
  const sizeG = cfg.hintSizePx / scale;
  ctx.save();
  ctx.globalAlpha = cfg.hintAlpha;
  ctx.strokeStyle = cfg.hintColor;
  ctx.lineWidth = 2.5 / scale;
  for (const it of items) {
    const pts = cornerHintPath({ x: it.pos[0], y: it.pos[1], w: it.size[0], h: it.size[1] }, sizeG);
    ctx.beginPath();
    const first = pts[0];
    if (!first)
      continue;
    ctx.moveTo(first.x, first.y);
    for (let i = 1;i < pts.length; i++) {
      const pt = pts[i];
      if (pt)
        ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
function installAffordance(canvas, cfg) {
  if (!canvas || !cfg.showHint)
    return;
  const prev = canvas.onDrawForeground;
  canvas.onDrawForeground = function(ctx, visibleRect) {
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
  }
});
export {
  selectedNodes,
  selectedGroups,
  scaledSize,
  resolveTargets,
  pointInRect,
  pinchDistance,
  nodeScreenRect,
  groupScreenRect,
  createGestureController,
  cornerHintPath,
  centroid,
  anisoSize
};
