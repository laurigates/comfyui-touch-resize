---
id: ADR-0001
date: 2026-06-06
status: Accepted
deciders: Lauri Gates
domain: build-tooling
supersedes: []
relates-to: []
github-issues: []
name: typescript-bun-build-migration
---

# ADR-0001: Adopt TypeScript + bun build (supersedes the implicit no-bundler / single-file-JS decisions)

> This pack had no `docs/blueprint/adrs/` before this migration. The prior
> build decisions — **single-file vanilla JavaScript, served with no bundler
> and no transpilation, importing ComfyUI via the relative
> `../../../scripts/app.js` path** — were never captured as numbered ADRs;
> they lived implicitly in `CLAUDE.md` ("the whole extension lives in
> `web/js/`", "Iterating on JS/CSS/JSON needs no restart"). This ADR is the
> first record in the series and **supersedes those implicit decisions**.
> CLAUDE.md has been updated to mark the superseded prose.

## Decision Drivers

- The single-file vanilla-JS implementation reached deep into the minified
  ComfyUI frontend's LiteGraph canvas/pointer/group objects (`app.canvas`,
  `canvas.ds.scale/offset`, `canvas.selected_nodes`, `canvas.selectedItems`,
  `LGraphGroup.size`/`recomputeInsideNodes`, the pointer-event stream). Those
  accesses are exactly where a `comfyui-frontend-package` bump silently breaks
  the pack (see the "Canvas pointer model is version-sensitive" hard rule and
  the "Verified frontend API" table in CLAUDE.md). Type checking against
  `@comfyorg/comfyui-frontend-types` turns a class of those breakages into
  compile errors.
- A bun-externalization spike confirmed the toolchain keeps the
  zero-runtime-bundle property: `bun build ./src/index.ts --target browser
  --format esm --outdir web/dist --external '/scripts/*'` emits browser-clean
  ESM with the `/scripts/app.js` runtime import left **unbundled** (resolved at
  runtime against ComfyUI's served module). This is the property the
  no-bundler decision valued — the browser still loads a plain ES module,
  ComfyUI still serves it as a static file — now with a typed source.
- A `package.json` + Vitest dev dependency already existed for the pure-helper
  / controller unit tests, so the "no `package.json` / no `node_modules`"
  premise no longer held in full. Adding a build step on top of an existing dev
  toolchain is a small delta.

## Considered Options

1. **TypeScript source in `src/`, built to `web/dist/` via `bun build`** —
   typed authoring, browser-ESM output, `/scripts/*` externalized.
2. **Stay on single-file vanilla JS** — no build, no types.
3. **TypeScript with `tsc` emit instead of `bun build`** — `tsc` can emit ESM,
   but does not understand the `--external '/scripts/*'` runtime-import concept
   and would not keep the served-path import cleanly; it is a type checker
   first, a bundler never.

## Decision Outcome

**Chosen option**: "TypeScript source in `src/`, built to `web/dist/` via
`bun build`". The spike proved the output preserves the runtime contract, and
the type checker pays for itself at the frontend seam. `tsc --noEmit` is the
type gate; `bun build` is the emit. The two are decoupled — `tsc` never emits,
`bun` never type-checks — which keeps each fast and single-purpose.

### Build & serve mechanics

- **Source**: `src/index.ts` (the port of the former
  `web/js/touch-resize.js`) plus `src/comfyui-shims.d.ts`.
- **Type gate**: `bun run typecheck` → `tsc --noEmit` against
  `@comfyorg/comfyui-frontend-types` (dev dependency).
- **Emit**: `bun run build` →
  `bun build ./src/index.ts --target browser --format esm --outdir web/dist
  --external '/scripts/*'`. This pack ships no static data corpus, so there is
  no `web/data/` copy step — the build emits `web/dist/index.js` only.
- **Serve**: `__init__.py` sets `WEB_DIRECTORY = "./web/dist"`. ComfyUI serves
  that tree at `/extensions/comfyui-touch-resize/`, so the built JS is at
  `/extensions/comfyui-touch-resize/index.js`. The served URL therefore moves
  from the old `/extensions/comfyui-touch-resize/js/touch-resize.js` to
  `/extensions/comfyui-touch-resize/index.js`. `EXT_NAME` is unchanged.
- **Distribution**: `web/dist/` is git-ignored (it is generated). The Comfy
  Registry tarball includes it via `[tool.comfy] includes = ["web/dist"]`, and
  CI (`publish.yml`) runs `bun run build` before `publish-node-action` so the
  artifact exists at publish time.

### Type-seam notes (for future maintainers)

- `@comfyorg/comfyui-frontend-types` exports `ComfyApp` and `ComfyExtension` at
  the module root, but **not** `LGraphNode` / `LGraphCanvas` / `LGraphGroup` /
  the widget interfaces (they are declared internally, un-exported). The pack
  therefore models the small surface it touches with local structural
  interfaces (`GraphItem`, `CanvasLike`, `Target`, `Pointer`) rather than
  importing un-exportable types. This matches the existing
  discriminate-by-shape approach the pack already used for nodes vs groups vs
  reroutes.
- TypeScript will not match an ambient `declare module` against a rooted
  (`/scripts/app.js`) path specifier. A `paths` mapping in `tsconfig.json`
  points that import at `src/comfyui-shims.d.ts` for type resolution; the
  emitted import string stays `/scripts/app.js` and `--external '/scripts/*'`
  keeps it unbundled.

### Positive Consequences

- Static type checking at the version-sensitive frontend seam — the single
  largest source of silent breakage now has a compile-time gate.
- Output is still plain browser ESM served as a static file; no runtime
  bundler, no framework, no change to how ComfyUI loads the extension.
- The exported pure helpers and `createGestureController` keep their exact
  names, so the Vitest suite imports the `.ts` source directly with no build
  dependency in tests.
- `knip` + `tsc` + Vitest + Biome give a complete local gate chain.

### Negative Consequences

- The "edit → hard-refresh" loop now requires a `bun run build` step (the
  served file is `web/dist/index.js`, not the source). Mitigated by `just
  build` and a fast (~12ms) build.
- A build artifact must be present for the registry publish; CI is wired to
  build first, but a fresh checkout has no `web/dist/` until `bun run build`
  runs.
- The served URL changed (`/js/touch-resize.js` → `/index.js`). No external
  consumer depends on the old path; bookmarks / direct fetches must update.

## Pros and Cons of Options

### TypeScript + bun build

- ✅ Static types at the frontend seam
- ✅ Browser-ESM output preserves the runtime contract (spike-confirmed)
- ✅ Decoupled type gate (`tsc --noEmit`) and emit (`bun build`)
- ❌ Adds a build step to the edit-refresh loop
- ❌ Generated artifact must be built before publish

### Stay on single-file vanilla JS

- ✅ Zero build toolchain
- ❌ No type safety at the exact place breakage happens
- ❌ The "no package.json" premise was already eroded by the Vitest harness

### TypeScript with `tsc` emit

- ✅ Single tool for typecheck + emit
- ❌ `tsc` is not a bundler; the `/scripts/*` externalize concept is a bundler
  feature
- ❌ Worse fit than `bun build` for the browser-ESM-with-external target

## Links

- Bun externalization spike: `bun build ./src/index.ts --target browser
  --format esm --outdir web/dist --external '/scripts/*'` (PASSED)
- `CLAUDE.md` § "File layout", § "Dev workflow"
- Mirrors `comfyui-sampler-info` ADR-0010 (the pilot for this migration)

---
*Authored as part of the TypeScript + bun build migration.*
