# CLAUDE.md

Frontend-only ComfyUI custom-node pack in the canvas-gesture vein. `__init__.py`
is a loader stub; the extension is authored in TypeScript (`src/index.ts`) and
compiled to browser ESM via `bun build`, emitted to `web/dist/` (see ADR-0001).

## Architecture Decisions

| ID | Title | Domain |
|----|-------|--------|
| [ADR-0001](docs/blueprint/adrs/0001-adopt-typescript-bun-build.md) | Adopt TypeScript + bun build (supersedes the implicit no-bundler / single-file-JS decisions) | build-tooling |

## The pattern ("the vein")

A mobile-first ComfyUI usability pack in the *gesture* vein: instead of intercepting a single widget, a frontend JS extension adds a CANVAS-LEVEL pointer layer. A two-finger pinch whose centroid lands inside a **selected** node (single tap selects it) resizes that node and suppresses the native canvas zoom for the gesture's duration. The enhancement is **additive** (no-op fallback if `app.canvas` or the pointer model is absent — native corner-handle resize still works), **touch-first**, and never breaks serialized workflows (it only writes `node.size`, which is already serialized). Pure geometry helpers live at the top of the extension and are unit-tested; DOM/canvas wiring stays below them.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Empty `NODE_CLASS_MAPPINGS`; exports `WEB_DIRECTORY = "./web/dist"`. |
| `src/index.ts` | The extension — TypeScript source (port of the former single-file JS): canvas pointer layer + pure geometry helpers + the pure reducer. Compiled to `web/dist/index.js`. |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import (see ADR-0001 type-seam notes). |
| `web/dist/` | **Generated** — `bun build` output (`index.js`). Git-ignored; force-shipped to the registry via `[tool.comfy] includes`. Do not edit by hand. |
| `tsconfig.json` | TypeScript config — strict, `tsc --noEmit` type gate, `paths` shim. |
| `knip.json` | Dead-code / unused-dependency check config. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch. `[tool.comfy] includes = ["web/dist"]` force-ships the built artifact. |
| `package.json` | Dev toolchain — `bun build`, `tsc`, Vitest, Biome, knip. |
| `.github/workflows/` | `ci.yml` (ruff/biome/typecheck+build/pytest/vitest/gitleaks), `publish.yml` (builds, then auto-publishes on version bump), `release-please.yml`. |
| `tests/` | pytest stub suite. `tests/js/` Vitest suite for the pure helpers + reducer in `src/index.ts`. |
| `justfile` | `lint`, `format`, `typecheck`, `build`, `knip`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** The built `web/dist/index.js` is
  served at `/extensions/comfyui-touch-resize/index.js`. Renaming the pack dir
  breaks every fetch. If unavoidable, sync `EXT_NAME` in `src/index.ts`.
- **No Python dependencies. The pack is frontend-only; a feature genuinely needing Python belongs in a separate companion pack.**
- **Additive only.** Never clobber an existing tooltip/control; fall back to
  the native widget when there's no match. Never fabricate data.
- **Canvas pointer model is version-sensitive.** The pinch layer reads `app.canvas` / `ds.scale` / `ds.offset` and the pointer-event stream. Keep the no-op fallback (do nothing when they are absent) so native corner-handle resize always works.

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TS toolchain (typescript, types, vitest, biome, knip)
pre-commit install
just check                   # lint + typecheck + build + knip + test — the local CI gate
```

The served file is the built `web/dist/index.js` (`web/dist/` is git-ignored
and generated). After editing `src/index.ts` you must **`bun run build`** before
hard-refreshing the tab. No ComfyUI restart is needed — only a rebuild + refresh.

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

`src/index.ts` is split so the gesture logic is testable without a
browser (no jsdom — by design, matching the other packs in the vein):

- **Pure helpers** (exported, unit-tested): `pinchDistance`, `centroid`,
  `pointInRect`, `nodeScreenRect`, `groupScreenRect`, `scaledSize`, `anisoSize`,
  `cornerHintPath`, `selectedNodes`, `selectedGroups`, `resolveTargets`.
- **`createGestureController(cfg)`** — a PURE reducer. Holds private lock state;
  takes plain pointer/target data; returns `{type:"lock"|"resize"|"release"}`
  commands. Never touches the DOM or `app`. This is where the lock / scale /
  clamp / release decisions live, and it is exhaustively unit-tested
  (`tests/js/controller.test.js`). The lock records its two **pointer ids**, so
  `onPointerEnded(id)` releases the moment *either* gesture finger lifts (a stray
  third touch can't strand it), and `reset()` is an unconditional force-release
  for the adapter's non-pointer exits.
- **`installGestureLayer()`** — thin DOM adapter: pointer/wheel events → data,
  controller commands → `node.size`/`group.size` mutation. Per gesture it calls
  `resolveTargets()` and keeps a `targetId → Target` map to apply commands. On
  release it **hands the gesture's pointers back to LiteGraph** with a synthetic
  `pointercancel` so LiteGraph clears the drag it began on the first finger (see
  the "Hand the pointer back" row in the API table).
- **`installAffordance(canvas, cfg)`** — instance-chains `onDrawForeground` to
  stroke the corner hint (additive; the previous handler still runs).

Targets are normalized so nodes and groups share one resize path. They are
discriminated by **shape, not `instanceof`** (the LGraphGroup class is renamed
under minification / forks): a node has `computeSize()`, a group has
`pos`+`size`+string `title` and no `computeSize`, a reroute has no `size`.

`CONFIG` (module constant near the top) is the only knob — no in-UI settings for
v1. `mode` (`"uniform"`|`"aniso"`), `groupMinSize`, `showHint`/`hintColor`/
`hintAlpha`/`hintSizePx`, `anisoEps`. `hintColor` is a vivid accent (default
`#ffb02e`) rather than white so the grab affordance stands out against both the
node body and the white selection outline.

## Verified frontend API (from the sourcemap)

Checked against
`.venv/.../comfyui_frontend_package/static/assets/api-vjhDtP5R.js.map`
(LiteGraph is bundled there; grep `sourcesContent`). Re-verify after a
`comfyui-frontend-package` bump:

| Symbol | Finding |
|---|---|
| `LiteGraph.NODE_TITLE_HEIGHT` | `= 30` (matches `DEFAULT_TITLE_HEIGHT`). |
| `canvas.selectedItems` | `Set<Positionable>` — "All selected nodes, groups, and reroutes". Groups ARE individually selectable; no separate store needed. |
| `canvas.selected_nodes` | `Dictionary<LGraphNode>` (nodes only). |
| `LGraphGroup.pos` / `.size` | getters/setters over `_pos`/`_size`. **`size` setter self-clamps** to `minWidth=140`/`minHeight=80`. |
| `LGraphGroup.recomputeInsideNodes()` | present; called after a group resize so it re-memberships the right nodes. |
| `LGraphGroup.id` | defaults to `-1`, not guaranteed unique → target key falls back to selection index. |
| Native zoom | **wheel-driven** (`processMouseWheel` → `ds.changeScale`; browsers send pinch-zoom as ctrl+wheel). The pack therefore intercepts `wheel` (capture, `passive:false`) while a gesture is locked, in addition to `stopImmediatePropagation` on pointer events. |
| Listener phase (critical) | LiteGraph binds its pointer/wheel handlers on the **canvas element** in its constructor — *before* our `setup()`. Those events TARGET that element, so in the `AT_TARGET` phase listeners fire in **registration order, capture flag ignored** → a capture listener on `el` still runs *after* LiteGraph and loses the race. The suppression layer therefore binds on an **ancestor (`window`) in the capture phase**, which provably precedes any `AT_TARGET` listener. Without this the canvas zooms *and* the node body-drags while we resize (groups felt fine only because they drag by their title bar, not their body). |
| Gesture exit (don't strand the lock) | Suppressing the move stream (`preventDefault` + `touch-action:none`) can make a build that derives pointer events from touch **drop the gesture pointers' terminal `pointerup`/`pointercancel`** — leaving the lock stuck with suppression eating every wheel/touch, so the user can't recover. Defenses, in layers: (1) the lock owns its two pointer ids → release on the *first* to lift; (2) **don't** suppress `touchend`/`touchcancel` — instead use them as a fallback exit (`touches.length < 2` ⇒ release); (3) `pointercancel` force-releases the whole gesture; (4) **Escape** and window **`blur`** are guaranteed manual exits independent of the touch/pointer stream. |
| Hand the pointer back to LiteGraph on release (critical) | The FIRST finger's `pointerdown` reaches LiteGraph *before* the second finger locks the gesture, so LiteGraph starts a drag/pan; we then starve its event stream. When our resize ends, LiteGraph is left mid-transaction with a pointer it still thinks is down → **"stuck in two-finger mode": the canvas won't pan and a tap won't deselect** until a window `blur` (app switch) resets it. Fix: on *every* release the adapter **dispatches a synthetic `pointercancel`** (`isTrusted:false`) to the canvas for the gesture's pointer ids — the exact signal a blur sends — so LiteGraph tears down its own drag state automatically. Our listeners ignore non-trusted events so the synthetic cancel can't perturb the gesture. Additive: a no-op if `PointerEvent` can't be constructed. |

## Browser smoke matrix (manual)

Unit tests cover the pure logic; these must be verified live (devtools console
+ a touch device or emulated touch). Hard-refresh the tab after editing.

| # | Check | Expect |
|---|---|---|
| 1 | Pinch inside a selected node | node resizes (uniform) |
| 2 | Pinch inside a selected group | group resizes + inside-node membership recomputes |
| 3 | Pinch on empty canvas / unselected item | native zoom still works |
| 4 | Native bottom-right corner handle | still resizes (additive, not clobbered) |
| 5 | Min-size clamp | node floors at `computeSize()`; group floors at 140×80 |
| 6 | Corner hint | faint bracket on selected node/group; stays ~constant size across zoom |
| 7 | `CONFIG.mode = "aniso"` | horizontal-only / vertical-only pinch changes W or H independently |
| 8 | Endpoint reachable | the `curl` check above returns `200` |
| 9 | Exit the resize | lift either finger → gesture ends immediately; native zoom/pan work again right after |
| 10 | Stuck-state recovery | if a resize ever sticks, **Escape** or switching apps (window blur) drops it |
| 11 | Post-resize canvas | right after a resize: panning, single-tap deselect, and node-drag all work without an app-switch (LiteGraph drag state was handed back) |

**Open items still needing a real device** (sourcemap can't settle these):

- **Native-zoom suppression (risk #2):** ~~confirm the `wheel` interceptor~~
  **Resolved on-device:** the original wiring bound on `el`, so LiteGraph's
  earlier-registered handlers won the `AT_TARGET` race and the canvas zoomed
  (and nodes body-dragged) *while* resizing. The suppression layer now binds on
  `window` in the capture phase (see "Listener phase" above), plus a
  `touchstart/move` hedge and `touch-action:none`. Re-verify matrix #1–#3.
- **Gesture exit (risk #6):** the same suppression could strand the lock when a
  build drops the gesture pointers' terminal events — fixed with id-based
  release + a touchend/touchcancel fallback + Escape/blur escape hatches (see
  the "Gesture exit" row above). Re-verify matrix #9–#10 on a real device.
- **Post-resize LiteGraph drag state (risk #7):** the first finger's down
  reaches LiteGraph before the lock, so after a resize the canvas gets "stuck in
  two-finger mode" (no pan / no tap-deselect) until an app-switch. **Confirmed
  on-device (2026-07) that the synthetic-`pointercancel`-only fix was
  insufficient — the stick persisted, recovering only by backgrounding Chrome.**
  Root cause found in the frontend sourcemap: LiteGraph's own
  `processMouseCancel` runs *only* `this.pointer.reset()` (release capture +
  clear `isDown`/`dragStarted`) and does **not** clear the canvas-level drag
  flags (`dragging_canvas`, `last_mouse_dragging`, `connecting_links`,
  `state.draggingCanvas`, …) — those are cleared only by `processMouseUp`. So a
  lone `pointercancel` under-clears and leaves the flags set (the stuck state).
  Fix (`recoverNativePointerState`): keep the synthetic `pointercancel`, but
  ALSO call `canvas.pointer.reset()` directly and clear the canvas-level drag
  flags (the ones `processMouseUp` clears), all defensively/feature-detected;
  selection is left untouched so the corner hint survives. **Re-verify matrix
  #11 on a real device:** lift fingers after a resize → pan + single-tap
  deselect + node-drag all work immediately, WITHOUT an app-switch, and the
  selection/corner-hint is preserved.
- **Anisotropic feel (risk #5):** finger rotation while spreading can feel
  unpredictable — validate on-device before flipping `mode` on by default.
- **Hint coordinate space (risk #4):** current choice is constant-screen-size
  (legs divided by `ds.scale`); confirm it reads well at extreme zoom.

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`Comfy-Org/publish-node-action` publishes to the Comfy Registry. Requires
the `REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits;
release-please maintains `CHANGELOG.md` and the version bump PR.
