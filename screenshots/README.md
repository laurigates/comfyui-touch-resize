# README screenshot pipeline

Containerized [Playwright](https://playwright.dev) + ComfyUI generator that
regenerates the README screenshot (`docs/handles.png`) reproducibly, so the
shot doesn't depend on whatever theme/frontend a particular dev machine
happens to have.

## Run

From the repo root:

```sh
just screenshots
```

First build is ~4 min (clones ComfyUI, installs CPU torch + ComfyUI deps,
pulls the npm driver dep on top of the pre-baked Chromium). Cached rebuilds
are ~30s. The PNG lands at `docs/handles.png`.

## How it works — canvas affordance, no modal

Unlike the modal packs in the family, touch-resize paints its UI onto the
canvas: selecting a node makes the pack draw four corner grab-handles. There is
no dialog to screenshot, but there is also **nothing to fake** — selecting a
node is enough to produce the real affordance.

1. `Dockerfile` builds on the official Playwright image, clones a pinned
   ComfyUI release, and installs CPU-only torch + ComfyUI's requirements.
2. `entrypoint.sh` launches ComfyUI headless on `:8188` (`--cpu`), waits for
   `/system_stats`, then runs the capture driver.
3. `capture.mjs` (Playwright) loads `workflow.json` (a single KSampler),
   **selects it directly** on the canvas — so the pack's real
   `onDrawForeground` handles paint, without triggering the frontend's Vue
   selection toolbox — then clips the canvas region around the node.
4. The driver writes to `/out`, which the `just` recipe mounts to `docs/`.

Everything in the resulting PNG is drawn by the pack. Earlier versions of this
driver injected an illustrative two-finger-pinch callout (fingertip dots and a
diverging arrow), because the pack's v1 gesture could not be performed
headlessly and drew only a faint corner bracket. That overlay is gone — see
ADR-0003.

| File | Purpose |
|------|---------|
| `Dockerfile` | Single-stage build (Playwright base + ComfyUI + CPU torch). Pins `EXPECTED_OUTPUTS` — keep it in sync with the filename `capture.mjs` writes. |
| `Dockerfile.dockerignore` | Keeps the build context lean. |
| `entrypoint.sh` | Boots ComfyUI, waits for ready, runs the driver, asserts `$EXPECTED_OUTPUTS` exist. |
| `capture.mjs` | Playwright driver — selects the node so the handles paint, then clips the canvas. |
| `workflow.json` | Single-KSampler graph the driver loads. |
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

## Don't hand-edit `docs/handles.png`

It's generated. To change it, edit `capture.mjs` / `workflow.json` and
re-run `just screenshots`.
