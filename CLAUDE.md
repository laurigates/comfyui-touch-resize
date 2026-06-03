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

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`Comfy-Org/publish-node-action` publishes to the Comfy Registry. Requires
the `REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits;
release-please maintains `CHANGELOG.md` and the version bump PR.
