# README screenshot pipeline

Containerized [Playwright](https://playwright.dev) + ComfyUI generator that
regenerates the README screenshot (`docs/hint.png`) reproducibly, so the
shot doesn't depend on whatever theme/frontend a particular dev machine
happens to have.

## Run

From the repo root:

```sh
just screenshots
```

First build is ~4 min (clones ComfyUI, installs CPU torch + ComfyUI deps,
pulls the npm driver dep on top of the pre-baked Chromium). Cached rebuilds
are ~30s. The PNG lands at `docs/hint.png`.

## How it works — gesture pack, no modal

Unlike the modal packs in the family, touch-resize is a **canvas-gesture**
pack: a two-finger pinch resizes a selected node. There is no dialog to
screenshot, and the pinch itself can't be shown in a still. The honest,
statically-screenshottable surfaces are the pack's own canvas-painted
affordance plus the *outcome* of a resize:

1. `Dockerfile` builds on the official Playwright image, clones a pinned
   ComfyUI release, and installs CPU-only torch + ComfyUI's requirements.
2. `entrypoint.sh` launches ComfyUI headless on `:8188` (`--cpu`), waits for
   `/system_stats`, then runs the capture driver.
3. `capture.mjs` (Playwright) loads `workflow.json` (two identical KSampler
   nodes — one default size, one resized larger), **selects both directly**
   on the canvas (so the pack's `onDrawForeground` corner-hint affordance
   paints, without triggering the frontend's Vue selection toolbox), forces
   a redraw, and clips the canvas region spanning both nodes.
4. The before/after size pair + the real corner brackets read as "pinch a
   selected node to resize it" without fabricating any UI.
5. The driver writes to `/out`, which the `just` recipe mounts to `docs/`.

| File | Purpose |
|------|---------|
| `Dockerfile` | Single-stage build (Playwright base + ComfyUI + CPU torch). |
| `Dockerfile.dockerignore` | Keeps the build context lean. |
| `entrypoint.sh` | Boots ComfyUI, waits for ready, runs the driver, asserts `$EXPECTED_OUTPUTS` exist. |
| `capture.mjs` | Playwright driver — selects nodes, paints the affordance, clips the canvas. |
| `workflow.json` | Two-KSampler graph (default + resized) the driver loads. |
| `package.json` | Pins the Playwright npm version for the driver. |

## Pins (bump deliberately)

- **`ARG COMFYUI_REF`** (`Dockerfile`) — the ComfyUI release. The canvas is
  rendered by the frontend bundle that ships with this release; `v0.22.0`
  ships `comfyui-frontend-package==1.43.18`.
- **Playwright version** — pinned in BOTH `Dockerfile` (`FROM
  mcr.microsoft.com/playwright:v1.49.1-noble`) and `package.json`. Keep them
  in lockstep: the base-image tag pins the Chromium revision (the largest
  source of cross-host font-rendering drift) and the npm dep is the driver
  API. Bump both together.

## Don't hand-edit `docs/hint.png`

It's generated. To change it, edit `capture.mjs` / `workflow.json` and
re-run `just screenshots`.
