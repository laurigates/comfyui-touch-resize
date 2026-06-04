# CLAUDE.md

Frontend-only ComfyUI custom-node pack in the canvas-gesture vein. `__init__.py` is a loader stub; the whole extension lives in `web/js/`.

## The pattern ("the vein")

A mobile-first ComfyUI usability pack in the *gesture* vein: instead of intercepting a single widget, a frontend JS extension adds a CANVAS-LEVEL pointer layer. A two-finger pinch whose centroid lands inside a **selected** node (single tap selects it) resizes that node and suppresses the native canvas zoom for the gesture's duration. The enhancement is **additive** (no-op fallback if `app.canvas` or the pointer model is absent — native corner-handle resize still works), **touch-first**, and never breaks serialized workflows (it only writes `node.size`, which is already serialized). Pure geometry helpers live at the top of the extension and are unit-tested; DOM/canvas wiring stays below them.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Empty `NODE_CLASS_MAPPINGS`; exports `WEB_DIRECTORY = "./web"`. |
| `web/js/touch-resize.js` | The extension: canvas pointer layer + pure geometry helpers. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch. |
| `.github/workflows/` | `ci.yml` (ruff/biome/pytest/vitest/gitleaks), `publish.yml` (auto-publish on version bump), `release-please.yml`. |
| `tests/` | pytest backend suite. `tests/js/` Vitest suite for pure JS helpers. |
| `justfile` | `lint`, `format`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** `web/js/touch-resize.js` is
  served at `/extensions/comfyui-touch-resize/js/touch-resize.js`. Renaming the pack dir
  breaks every fetch. If unavoidable, sync `EXT_NAME` in the JS.
- **No Python dependencies. The pack is frontend-only; a feature genuinely needing Python belongs in a separate companion pack.**
- **Additive only.** Never clobber an existing tooltip/control; fall back to
  the native widget when there's no match. Never fabricate data.
- **Canvas pointer model is version-sensitive.** The pinch layer reads `app.canvas` / `ds.scale` / `ds.offset` and the pointer-event stream. Keep the no-op fallback (do nothing when they are absent) so native corner-handle resize always works.

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
npm install --no-audit --no-fund   # Vitest (dev-only; nothing ships from node_modules)
pre-commit install
just check                   # lint + test — the local CI gate
```

Iterating on JS/CSS/JSON needs **no ComfyUI restart** — hard-refresh the tab.


### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-touch-resize/js/touch-resize.js
```

## Architecture: pure controller + thin adapter

`web/js/touch-resize.js` is split so the gesture logic is testable without a
browser (no jsdom — by design, matching the other packs in the vein):

- **Pure helpers** (exported, unit-tested): `pinchDistance`, `centroid`,
  `pointInRect`, `nodeScreenRect`, `groupScreenRect`, `scaledSize`, `anisoSize`,
  `cornerHintPath`, `selectedNodes`, `selectedGroups`, `resolveTargets`.
- **`createGestureController(cfg)`** — a PURE reducer. Holds private lock state;
  takes plain pointer/target data; returns `{type:"lock"|"resize"|"release"}`
  commands. Never touches the DOM or `app`. This is where the lock / scale /
  clamp / release decisions live, and it is exhaustively unit-tested
  (`tests/js/controller.test.js`).
- **`installGestureLayer()`** — thin DOM adapter: pointer/wheel events → data,
  controller commands → `node.size`/`group.size` mutation. Per gesture it calls
  `resolveTargets()` and keeps a `targetId → Target` map to apply commands.
- **`installAffordance(canvas, cfg)`** — instance-chains `onDrawForeground` to
  stroke the corner hint (additive; the previous handler still runs).

Targets are normalized so nodes and groups share one resize path. They are
discriminated by **shape, not `instanceof`** (the LGraphGroup class is renamed
under minification / forks): a node has `computeSize()`, a group has
`pos`+`size`+string `title` and no `computeSize`, a reroute has no `size`.

`CONFIG` (module constant near the top) is the only knob — no in-UI settings for
v1. `mode` (`"uniform"`|`"aniso"`), `groupMinSize`, `showHint`/`hintAlpha`/
`hintSizePx`, `anisoEps`.

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

**Open items still needing a real device** (sourcemap can't settle these):

- **Native-zoom suppression (risk #2):** confirm the `wheel` interceptor
  actually stops zoom during a lock. If the canvas sets `touch-action: none`
  and pinch arrives purely as pointer events (no wheel), the pointer
  `stopImmediatePropagation` already covers it; the wheel handler is the hedge
  for the ctrl+wheel path.
- **Anisotropic feel (risk #5):** finger rotation while spreading can feel
  unpredictable — validate on-device before flipping `mode` on by default.
- **Hint coordinate space (risk #4):** current choice is constant-screen-size
  (legs divided by `ds.scale`); confirm it reads well at extreme zoom.

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`Comfy-Org/publish-node-action` publishes to the Comfy Registry. Requires
the `REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits;
release-please maintains `CHANGELOG.md` and the version bump PR.
