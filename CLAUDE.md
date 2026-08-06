# CLAUDE.md

Frontend-only ComfyUI custom-node pack in the canvas-affordance vein. `__init__.py`
is a loader stub; the extension is authored in TypeScript (`src/index.ts`) and
compiled to browser ESM via `bun build`, emitted to `web/dist/` (see ADR-0001).

## Architecture Decisions

| ID | Title | Domain |
|----|-------|--------|
| [ADR-0001](docs/blueprint/adrs/0001-adopt-typescript-bun-build.md) | Adopt TypeScript + bun build (supersedes the implicit no-bundler / single-file-JS decisions) | build-tooling |
| [ADR-0002](docs/blueprint/adrs/0002-adopt-kit-pointer-claim-protocol.md) | Adopt the comfy-modal-kit pointer-claim protocol (`isModalActive` veto + `claimPointer`) | frontend-framework |
| [ADR-0003](docs/blueprint/adrs/0003-corner-handles-over-pinch-gesture.md) | Resize via corner grab-handles, replacing the two-finger pinch gesture | frontend-framework |

## The pattern ("the vein")

A mobile-first ComfyUI usability pack in the *canvas-affordance* vein: instead of
intercepting a single widget, a frontend JS extension paints controls onto the
canvas and adds a CANVAS-LEVEL pointer layer to drive them. When exactly one node
or group is selected, four big amber circles are drawn at the corners of its
resizable body; a `pointerdown` within a handle's hit radius starts a resize that
anchors the opposite corner. The enhancement is **additive** (no-op fallback if
`app.canvas` or the pointer model is absent — native corner-handle resize still
works), **touch-first**, and never breaks serialized workflows (it writes only
`pos`/`size`, both already serialized). Pure geometry helpers live at the top of
the extension and are unit-tested; DOM/canvas wiring stays below them.

**This pack used to be a pinch-gesture pack.** ADR-0003 records why that was
replaced and what it cost; read it before reintroducing any multi-finger idea.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Empty `NODE_CLASS_MAPPINGS`; exports `WEB_DIRECTORY = "./web/dist"`. |
| `src/index.ts` | The extension: pure geometry helpers + the pure reducer + the canvas pointer layer + the handle painter. Compiled to `web/dist/index.js`. |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import (see ADR-0001 type-seam notes). |
| `web/dist/` | **Generated** — `bun build` output (`index.js`). Git-tracked (not git-ignored) and CI-sync-gated (`ci.yml` runs `git diff --exit-code -- web/dist`), so `git clone` / a touch-manager update carries the real served artifact; also force-shipped to the registry via `[tool.comfy] includes`. Rebuild with `bun run build` and commit alongside `src/` — do not edit by hand. |
| `tsconfig.json` | TypeScript config — strict, `tsc --noEmit` type gate, `paths` shim. |
| `knip.json` | Dead-code / unused-dependency check config. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch. `[tool.comfy] includes = ["web/dist"]` force-ships the built artifact. |
| `package.json` | Dev toolchain — `bun build`, `tsc`, Vitest, Biome, knip. |
| `.github/workflows/` | `ci.yml` (ruff/biome/typecheck+build/pytest/vitest/gitleaks), `publish.yml` (builds, then auto-publishes on version bump), `release-please.yml`. |
| `tests/` | pytest stub suite. `tests/js/` Vitest suite for the pure helpers + reducer in `src/index.ts`. |
| `screenshots/` | Containerized Playwright driver that regenerates `docs/handles.png`. |
| `justfile` | `lint`, `format`, `typecheck`, `build`, `knip`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** The built `web/dist/index.js` is
  served at `/extensions/comfyui-touch-resize/index.js`. Renaming the pack dir
  breaks every fetch. If unavoidable, sync `EXT_NAME` in `src/index.ts`.
- **Never listen to `touchstart`/`touchmove`/`touchend`, and never set
  `touch-action`.** ComfyUI's built-in `Comfy.SimpleTouchSupport` keeps a global
  `touchCount` from those events and gates `LGraphCanvas.processMouseDown` on it;
  swallowing one side of the count kills tap handling canvas-wide. This layer is
  **pointer-events only**. See the API table below and ADR-0003.
- **Assign `pos`/`size`; never mutate the arrays in place.** `LGraphNode`'s
  setters push geometry into the Vue layout store — an in-place
  `obj.size[0] = w` skips them and desynchronizes it.
- **No Python dependencies. The pack is frontend-only; a feature genuinely needing Python belongs in a separate companion pack.**
- **Additive only.** Never clobber an existing control; fall back to the native
  behavior when there's no match. Never fabricate data.
- **Canvas pointer model is version-sensitive.** The layer reads `app.canvas` /
  `ds.scale` / `ds.offset` and the pointer-event stream. Keep the no-op fallback
  (do nothing when they are absent) so native corner-handle resize always works.

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TS toolchain (typescript, types, vitest, biome, knip)
pre-commit install
just check                   # lint + typecheck + build + knip + test — the local CI gate
```

The served file is the built `web/dist/index.js` (generated, but git-tracked and
CI-sync-gated — see the `web/dist/` row above). After editing `src/index.ts` you
must **`bun run build`** and commit the rebuilt bundle before hard-refreshing the
tab. No ComfyUI restart is needed — only a rebuild + refresh.

### Gates before commit

```sh
bun run typecheck   # tsc --noEmit
bun run build       # emit web/dist/index.js
bunx biome check .  # lint + format
bun run knip        # dead-code / unused-dep
bun run test        # Vitest (pure helpers + reducer)
uv run pytest -v    # Python loader-stub smoke tests
```

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-touch-resize/index.js
```

## Architecture: pure controller + thin adapter

`src/index.ts` is split so the drag logic is testable without a browser (no
jsdom — by design, matching the other packs in the vein):

- **Pure helpers** (exported, unit-tested): `screenToGraph`, `nodeHandleRect`,
  `groupHandleRect`, `handleCenters`, `hitTestHandles`, `resizeFromCorner`,
  `selectedNodes`, `selectedGroups`, `selectedResizables`, `resolveTarget`.
- **`createResizeController()`** — a PURE reducer. Holds private grab state;
  takes a pointer, a normalized target and a hit radius; returns
  `{type:"grab"|"resize"|"release"}` commands. Never touches the DOM or `app`,
  and is exhaustively unit-tested (`tests/js/controller.test.js`). It measures
  every frame from the ORIGINAL geometry and the total delta since the grab, so
  rounding and clamping never accumulate.
- **`installHandleLayer(canvas, el)`** — thin DOM adapter: pointer events → data,
  commands → `pos`/`size` mutation. Returns the controller so the painter can
  read `activeCorner`.
- **`installAffordance(canvas, cfg, activeCorner)`** — instance-chains
  `onDrawForeground` to paint the handles (additive; the previous handler still
  runs). The grabbed handle is drawn enlarged so a fingertip covering it still
  shows which corner is being dragged.

Targets are normalized so nodes and groups share one resize path, discriminated
by **shape, not `instanceof`** (the LGraphGroup class is renamed under
minification / forks): a node has `computeSize()`, a group has `pos`+`size`+string
`title` and no `computeSize`, a reroute has no `size`.

`Target.rect` (where handles are drawn and hit-tested) is the item's **visual
outline**, which is not the same as its `pos`/`size` for a node:

| Kind | Handle rect | Why |
|---|---|---|
| node | visual outline — `pos[1] - titleHeight` … `pos[1] + size[1]` | A node's `pos` is its BODY's top-left; the title is drawn above. Handles on the body's top corners land **~17px from the first input/output slots** — inside the hit radius — so tapping a slot on a selected node grabs a handle instead of starting a link drag. The title-bar corners are ~21px from the collapse toggle and ~45px from the slots. Both figures measured off a real KSampler render (`docs/handles.png`). |
| group | the box as-is | A group's `pos` already IS its visual top-left (title drawn inside). The top handles do sit on the group's drag strip, but it spans the full width (≥140), so only its ends are covered. |

**`CONFIG.hitRadiusPx` has a measured ceiling** of ~20 because of the collapse-toggle
clearance above. Re-measure before raising it.

`Target.pos`/`size` remain the item's own geometry, which is what a resize
writes; the two differ by a constant, so `resizeFromCorner` needs no special
case. It is formulated around the fixed **anchor** corner rather than by adding
the delta to the size — that is what makes the min-size clamp pin `pos` instead
of letting the box slide away once a dimension bottoms out.

`CONFIG` (module constant near the top) is the only knob — no in-UI settings.
`showHandles`, `handleRadiusPx` (drawn) vs `hitRadiusPx` (touch target — these
are deliberately decoupled), `fillColor`/`strokeColor`/`alpha`, `activeScale`,
`groupMinSize`.

## Verified frontend API (from the sourcemap)

Checked against `comfyui_frontend_package` **1.45.14**
(`.venv/.../static/assets/api-vjhDtP5R.js.map`; LiteGraph and the core
extensions are bundled there — `python3` + `json.load` over `sourcesContent` is
the way to read it). Re-verify after a `comfyui-frontend-package` bump.

| Symbol | Finding |
|---|---|
| `ds.convertCanvasToOffset(p)` | `p / scale - offset` — the screen→graph inverse `screenToGraph` implements. `convertOffsetToCanvas` is `(p + offset) * scale`. CSS pixels; **no devicePixelRatio factor**. |
| `canvas.convertEventToCanvasOffset(e)` | `convertCanvasToOffset([clientX - rect.left, clientY - rect.top])` — the authoritative conversion, and exactly what the adapter reproduces. |
| `ds.toCanvasContext(ctx)` | `ctx.scale(scale)` then `ctx.translate(offset)`. The canvas-level `onDrawForeground?.(ctx, visible_area)` call sits INSIDE that transform block, so the painter draws in **graph space** and divides on-screen lengths by `ds.scale`. |
| `LiteGraph.NODE_TITLE_HEIGHT` | `= 30`. `LGraphGroup.titleHeight` returns it. |
| `canvas.selectedItems` | `Set<Positionable>` — nodes, groups, and reroutes. Groups ARE individually selectable. |
| `canvas.selected_nodes` | `Dictionary<LGraphNode>` (nodes only). |
| `LGraphGroup.pos` setter | Writes `_pos` only — **no side effects**, does not move member nodes. Safe to assign during a resize. |
| `LGraphGroup.size` setter | Self-clamps to `minWidth=140`/`minHeight=80`; `CONFIG.groupMinSize` mirrors that so our `pos` math agrees with what is stored. |
| `LGraphNode.pos` / `.size` setters | **Also call `useLayoutMutations().moveNode` / `.resizeNode`** — the Vue layout store. An in-place array write bypasses them. `setSize(size)` = assign + `onResize?.()`; prefer it for nodes. |
| `node.flags.pinned` / `group.pinned` | "Prevents the node being accidentally moved or **resized** by mouse interaction." Pinned items get no handles. |
| `node.flags.collapsed` | No body to grab → no handles. |
| Listener phase (critical) | LiteGraph binds its pointer handlers on the **canvas element** in its constructor — *before* our `setup()`. Those events TARGET that element, so in the `AT_TARGET` phase listeners fire in **registration order, capture flag ignored** → a capture listener on `el` still runs *after* LiteGraph and loses the race. The layer therefore binds on an **ancestor (`window`) in the capture phase**, which provably precedes any `AT_TARGET` listener. This is what lets the grab's `pointerdown` be suppressed before LiteGraph opens a drag transaction. |
| `Comfy.SimpleTouchSupport` (critical) | Core extension `src/extensions/core/simpleTouchSupport.ts`. Keeps a module-global **`touchCount`** (`+= changedTouches.length` on `touchstart`, `-=` on `touchend`) and monkey-patches `LGraphCanvas.prototype.processMouseDown` to **return early while `touchZooming \|\| touchCount`** is truthy (and `processMouseMove` while `touchCount > 1`). Swallowing `touchstart` without swallowing `touchend` drives the count **negative** — truthy — so the canvas stops responding to taps until `resetTouchState` fires on `touchcancel`/`visibilitychange` (i.e. an app switch). **This was v1's "stuck in two-finger mode".** Hence the pointer-events-only hard rule. |
| Touch pinch-zoom | Lives in that same file: a `touchmove` handler on `canvasEl.parentElement` driving `ds.scale`/`ds.offset` when `touches.length === 2`. **Not** wheel-driven on a touchscreen (the old CLAUDE.md claimed otherwise); `processMouseWheel` is the trackpad/ctrl+wheel path. A second finger during a drag therefore aborts our resize and lets this take over. |
| Long-press right-click | Same file: a >600ms stationary touch dispatches a **synthetic** `pointerdown`/`pointerup` on the canvas. The adapter ignores `!e.isTrusted`, so these can't start a phantom grab. |
| `Comfy.VueNodes.Enabled` | Nodes 2.0 DOM rendering. `defaultValue: false` (true only for cloud/desktop installs from 1.41.0). Canvas-drawn handles are invisible in that mode — a known limitation, documented in the README. |

## Browser smoke matrix (manual)

Unit tests cover the pure logic; these must be verified live (devtools console
+ a touch device or emulated touch). Hard-refresh the tab after editing.
**None of these have been run against v2 yet** — issue #5 tracks it.

| # | Check | Expect |
|---|---|---|
| 1 | Select a node | four amber circles on the node's outline corners (title bar included) |
| 2 | Select a group | four circles on the group box's corners |
| 3 | Select two or more items | no handles at all |
| 4 | Select a pinned or collapsed node | no handles |
| 5 | Drag the bottom-right handle | node grows; `pos` does not move |
| 6 | Drag the top-left handle | node grows toward the top-left; the bottom-right corner stays put |
| 7 | Drag any handle past the minimum | size floors (node at `computeSize()`, group at 140×80) and the anchored corner stays pinned — the box must not slide |
| 8 | Zoom far in / far out, then look at the handles | circles stay the same on-screen size and stay hittable |
| 9 | Tap the node body / a slot / the collapse toggle | all behave normally — the layer only claims handle hits, and the clearances above must hold |
| 10 | Tap empty canvas / pan / two-finger pinch-zoom | all native behavior unaffected |
| 11 | **After a resize, tap the canvas** | selection changes normally — no "stuck" canvas, no app-switch needed (this is the v1 regression; `touchCount` must stay ≥ 0) |
| 12 | Second finger down mid-drag | resize abandons; pinch-zoom takes over cleanly |
| 13 | Escape / switch apps mid-drag | drag ends; canvas usable immediately |
| 14 | Resize a group | member nodes recomputed (drag the group — it carries the right nodes) |
| 15 | Save + reload the workflow | the new size persists |
| 16 | Endpoint reachable | the `curl` check above returns `200` |

To watch `touchCount` while testing #11, there is no exported handle on it —
verify behaviorally (taps keep working after ten resizes) rather than by reading
the variable.

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`Comfy-Org/publish-node-action` publishes to the Comfy Registry. Requires
the `REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits;
release-please maintains `CHANGELOG.md` and the version bump PR.
