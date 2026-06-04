// Playwright driver for the README screenshot.
//
// touch-resize is a CANVAS-GESTURE pack — there is no modal to capture, and a
// two-finger pinch can't be performed headlessly. So this driver composes an
// honest illustration of the gesture:
//
//   1. load a single KSampler node and select it, so the pack's real
//      onDrawForeground corner-hint affordance (the amber bracket) paints;
//   2. inject a clearly-illustrative pinch overlay (two fingertip dots + a
//      diverging double-arrow) over the node body — a documentation callout
//      showing the two-finger spread, NOT product chrome;
//   3. clip the canvas region around the node.
//
// Selection is set directly on the canvas (no canvas.selectNode → no Vue
// selection toolbox) so only the pack's own affordance + our callout show.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";
const ACCENT = "#ffb02e"; // matches the pack's hintColor

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

  // Inject the pinch callout over the node body. Two fingertip dots with a
  // diverging double-arrow = "spread two fingers to resize". Clearly an
  // annotation (the pack draws no fingers) — it documents the gesture.
  console.log("Injecting pinch callout…");
  await page.evaluate(
    ({ bx, by, bw, bh, accent }) => {
      const cx = bw / 2;
      const cy = bh / 2;
      const L = Math.min(bw, bh) * 0.26; // half-length of the arrow
      const ux = Math.SQRT1_2;
      const uy = Math.SQRT1_2; // unit diagonal ↘
      const ax = cx - ux * L;
      const ay = cy - uy * L; // upper-left arrowhead tip
      const bxp = cx + ux * L;
      const byp = cy + uy * L; // lower-right arrowhead tip
      const f1x = cx - ux * (L - 22);
      const f1y = cy - uy * (L - 22); // fingertip 1 (inside the head)
      const f2x = cx + ux * (L - 22);
      const f2y = cy + uy * (L - 22); // fingertip 2

      // markerUnits=userSpaceOnUse keeps the heads a fixed size instead of
      // scaling with stroke-width (which made them huge).
      const svg = `
        <svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}"
             xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;">
          <defs>
            <marker id="tr-ah" markerUnits="userSpaceOnUse" markerWidth="18"
                    markerHeight="18" refX="12" refY="9" orient="auto-start-reverse">
              <path d="M0,0 L16,9 L0,18 Z" fill="${accent}"/>
            </marker>
          </defs>
          <!-- dark halo for contrast on the node body -->
          <line x1="${ax}" y1="${ay}" x2="${bxp}" y2="${byp}"
                stroke="rgba(0,0,0,0.5)" stroke-width="9" stroke-linecap="round"/>
          <line x1="${ax}" y1="${ay}" x2="${bxp}" y2="${byp}"
                stroke="${accent}" stroke-width="5" stroke-linecap="round"
                marker-start="url(#tr-ah)" marker-end="url(#tr-ah)"/>
          <circle cx="${f1x}" cy="${f1y}" r="15" fill="rgba(255,255,255,0.95)"
                  stroke="${accent}" stroke-width="2.5"/>
          <circle cx="${f2x}" cy="${f2y}" r="15" fill="rgba(255,255,255,0.95)"
                  stroke="${accent}" stroke-width="2.5"/>
        </svg>`;

      const overlay = document.createElement("div");
      overlay.id = "tr-pinch-callout";
      overlay.style.cssText = [
        "position:fixed",
        `left:${bx}px`,
        `top:${by}px`,
        `width:${bw}px`,
        `height:${bh}px`,
        "pointer-events:none",
        "z-index:10000",
      ].join(";");
      overlay.innerHTML = svg;
      document.body.appendChild(overlay);
    },
    { bx: rect.bx, by: rect.by, bw: rect.bw, bh: rect.bh, accent: ACCENT },
  );

  await page.waitForTimeout(300);

  // Clip the node (title + body + corner bracket) with margin.
  const TITLE = 30;
  const PAD = 60;
  const clip = {
    x: Math.max(0, rect.bx - PAD),
    y: Math.max(0, rect.by - TITLE - PAD),
    width: rect.bw + PAD * 2,
    height: rect.bh + TITLE + PAD * 2,
  };

  console.log(`Capturing ${OUT_DIR}/hint.png…`);
  await page.screenshot({ path: `${OUT_DIR}/hint.png`, clip });

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
