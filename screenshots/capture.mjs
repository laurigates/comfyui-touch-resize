// Playwright driver for the README screenshot.
//
// touch-resize paints its affordance on the canvas, so the shot is entirely
// real product output — no illustration is composed:
//
//   1. load a single KSampler node and select it, so the pack's real
//      onDrawForeground handle affordance (four amber corner circles) paints;
//   2. clip the canvas region around the node.
//
// This driver USED to inject a fake two-finger-pinch callout (fingertip dots
// and a diverging arrow) because the pack's v1 gesture could not be performed
// headlessly and drew only a faint corner bracket. v2's handles ARE the UI, so
// the illustration is gone — what you see in the PNG is what the pack draws.
//
// Selection is set directly on the canvas (no canvas.selectNode → no Vue
// selection toolbox) so only the pack's own affordance shows.

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

  console.log("Loading single-node workflow…");
  await page.evaluate((wf) => {
    window.app.loadGraphData(wf, true);
  }, workflow);

  await page.waitForFunction(() => window.app.graph._nodes.length === 1, null, {
    timeout: 10_000,
  });

  await dismissStartupDialog(page);

  console.log("Positioning + selecting the node…");
  const rect = await page.evaluate(() => {
    const node = window.app.graph._nodes[0];
    const canvas = window.app.canvas;
    const ds = canvas.ds;
    ds.scale = 1;
    const TARGET_X = 240;
    const TARGET_Y = 190;
    ds.offset[0] = TARGET_X - node.pos[0];
    ds.offset[1] = TARGET_Y - node.pos[1];

    // Select directly (no selectNode → no Vue selection toolbox).
    node.selected = true;
    canvas.selected_nodes = { [node.id]: node };
    canvas.setDirty(true, true);
    canvas.draw(true, true);

    // Body rect in screen space (pos is the body top-left; title sits above).
    return {
      bx: (node.pos[0] + ds.offset[0]) * ds.scale,
      by: (node.pos[1] + ds.offset[1]) * ds.scale,
      bw: node.size[0] * ds.scale,
      bh: node.size[1] * ds.scale,
    };
  });

  await page.waitForTimeout(300);

  // Clip the node (title + body + all four corner handles) with margin.
  // PAD must exceed the handle radius so the circles are not clipped at the edge.
  const TITLE = 30;
  const PAD = 60;
  const clip = {
    x: Math.max(0, rect.bx - PAD),
    y: Math.max(0, rect.by - TITLE - PAD),
    width: rect.bw + PAD * 2,
    height: rect.bh + TITLE + PAD * 2,
  };

  console.log(`Capturing ${OUT_DIR}/handles.png…`);
  await page.screenshot({ path: `${OUT_DIR}/handles.png`, clip });

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
