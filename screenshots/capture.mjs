// Playwright driver for the README screenshot.
//
// touch-resize is a CANVAS-GESTURE pack — there is no modal to capture, and a
// two-finger pinch can't be shown in a still. The honest static surfaces are:
//   1. the pack's discoverability affordance — a faint corner bracket the pack
//      strokes on SELECTED nodes/groups (drawHints → onDrawForeground), and
//   2. the OUTCOME of a pinch — a node resized larger than its default.
//
// So this driver loads two identical KSampler nodes, one at default size and
// one resized larger, selects BOTH (which makes the corner-hint affordance
// paint on each), then clips the canvas region spanning both. The before/after
// size pair plus the real affordance reads as "pinch a selected node to
// resize it" without fabricating any UI.
//
// Selection is set directly on the canvas (selected_nodes + node.selected)
// rather than via canvas.selectNode(), so the frontend's Vue "selection
// toolbox" overlay does not pop up and clutter the shot — only the pack's own
// canvas-painted affordance shows.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";

async function dismissStartupDialog(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function main() {
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, "utf8"));

  const browser = await chromium.launch({
    args: ["--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      console.log(`[page:${t}] ${msg.text()}`);
    }
  });

  console.log(`Navigating to ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  console.log("Loading two-node (default + resized) workflow…");
  await page.evaluate((wf) => {
    window.app.loadGraphData(wf, true);
  }, workflow);

  await page.waitForFunction(() => window.app.graph._nodes.length === 2, null, {
    timeout: 10_000,
  });

  await dismissStartupDialog(page);

  console.log("Positioning + selecting both nodes…");
  const clip = await page.evaluate(() => {
    const graph = window.app.graph;
    const canvas = window.app.canvas;
    const ds = canvas.ds;
    ds.scale = 1;

    // Frame both nodes near the top-left with dark-canvas margin around them.
    const nodes = graph._nodes;
    const minX = Math.min(...nodes.map((n) => n.pos[0]));
    const minY = Math.min(...nodes.map((n) => n.pos[1]));
    const TARGET_X = 180;
    const TARGET_Y = 170;
    ds.offset[0] = TARGET_X - minX;
    ds.offset[1] = TARGET_Y - minY;

    // Select BOTH nodes directly (no selectNode → no Vue selection toolbox).
    const dict = {};
    for (const n of nodes) {
      n.selected = true;
      dict[n.id] = n;
    }
    canvas.selected_nodes = dict;

    canvas.setDirty(true, true);
    canvas.draw(true, true);

    // Clip spanning both nodes (+ title bars + a little margin).
    const TITLE = 30;
    const PAD = 56;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      const sx = (n.pos[0] + ds.offset[0]) * ds.scale;
      const sy = (n.pos[1] + ds.offset[1]) * ds.scale - TITLE;
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx + n.size[0] * ds.scale);
      y1 = Math.max(y1, sy + n.size[1] * ds.scale + TITLE);
    }
    return {
      x: Math.max(0, x0 - PAD),
      y: Math.max(0, y0 - PAD),
      width: x1 - x0 + PAD * 2,
      height: y1 - y0 + PAD * 2,
    };
  });

  await page.waitForTimeout(400);
  await page.evaluate(() => window.app.canvas.draw(true, true));
  await page.waitForTimeout(200);

  console.log(`Capturing ${OUT_DIR}/hint.png…`);
  await page.screenshot({ path: `${OUT_DIR}/hint.png`, clip });

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
