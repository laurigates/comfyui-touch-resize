---
id: ADR-0002
date: 2026-07-02
status: Accepted
deciders: Lauri Gates
domain: frontend-framework
supersedes: []
relates-to: [ADR-0001]
github-issues: [laurigates/comfy-modal-kit#9]
name: adopt-kit-pointer-claim-protocol
---

# ADR-0002: Adopt the comfy-modal-kit pointer-claim protocol (`isModalActive` veto + `claimPointer`)

## Context and Problem Statement

This pack installs a **window-level, capture-phase** `pointerdown` listener
(the "gesture vein" — see ADR-0001 and the `installGestureLayer` adapter). That
listener fires for *every* pointerdown on the page before it reaches any
AT_TARGET handler, which is exactly what lets it win the race against
LiteGraph. The same reach, though, means the gesture layer can act on a pointer
that a **sibling pack's modal** is already using: the modal-vein packs
(gallery-loader, model-gallery, prompt-editor, sampler-info) open HTML modals,
and a two-finger pinch while such a modal is open should not resize a canvas
node underneath it.

`comfy-modal-kit` ADR-0001 (`laurigates/comfy-modal-kit#8`, tracked by kit
issue #9) defines a lightweight **pointer-claim protocol** for exactly this
cross-pack coordination:

- `isModalActive()` — true while any pack's kit modal is on screen. The state
  lives on a `Symbol.for` global, so every inlined copy of the kit (each pack
  bundles its own at build time) observes the *same* flag.
- `claimPointer(id)` — a window-level gesture pack announces that it has taken
  a pointer, so peers can observe who owns the gesture (currently advisory /
  diagnostic).

The question is whether this pack should adopt that protocol.

## Decision Drivers

- **Cross-pack correctness at the window-capture seam.** A window-level gesture
  layer is the one place that can act on a pointer meant for another pack's
  modal. The kit gives a shared, explicit channel to stand down.
- **Not a live, reproducible bug — defense-in-depth.** The kit modal renders a
  full-screen `position:fixed; inset:0` backdrop, and this pack already gates on
  `onCanvas(e)` (target is the canvas or a descendant). A tap over an open modal
  therefore already lands on the backdrop, `onCanvas` returns false, and the
  gesture bails **today**. Adopting the protocol makes that veto *intentional
  and robust* (it survives a future non-backdrop or partial modal) rather than
  an emergent side effect of the backdrop's geometry.
- **Observability.** `claimPointer("touch-resize")` records, on the shared kit
  channel, that this pack owns the active gesture — useful for diagnostics and
  any future arbitration between window-level packs.
- **Near-zero cost.** The kit is inlined at build time (`bun build --target
  browser` bundles it into `web/dist/index.js`), so nothing ships from
  `node_modules` at runtime; the change is two call sites and one import.

## Considered Options

1. **Adopt the kit protocol** — import `isModalActive` / `claimPointer`; veto
   the gesture when a modal is active; claim the pointer on lock.
2. **Rely on the existing `onCanvas` backdrop bail only** — do nothing, trust
   that the full-screen backdrop keeps canvas gestures from firing under a
   modal.
3. **Hand-roll a private cross-pack flag** — a bespoke global instead of the
   shared kit protocol.

## Decision Outcome

**Chosen option**: "Adopt the kit protocol". It is defense-in-depth over the
existing backdrop bail (option 2), which is correct today but implicit and
fragile to modal-layout changes; and it uses the shared, single-sourced kit
channel rather than a private flag (option 3) that peers could not observe.

### Mechanics

- **Import** (bundled, not a runtime dependency):
  `import { claimPointer, isModalActive } from "@laurigates/comfy-modal-kit";`
- **Veto** — in the window-capture `pointerdown` listener, immediately after the
  `onCanvas` gate and before any pointer is tracked:
  `if (isModalActive()) return;`
- **Claim** — inside the `cmd?.type === "lock"` branch, alongside `suppress(e)`:
  `claimPointer("touch-resize");`
- The `@laurigates/comfy-modal-kit` entry is a **runtime `dependencies` entry**
  in `package.json` (the pack's first), but the built artifact inlines it — the
  served `web/dist/index.js` carries no import of `node_modules`.

### Positive Consequences

- The gesture layer explicitly stands down while any pack's modal is open,
  independent of the modal's DOM geometry.
- Pointer ownership is announced on the shared kit channel for diagnostics.
- One shared, single-sourced protocol across the gesture-vein packs (touch-
  connect, touch-tooltips, touch-numeric, this pack) instead of per-pack ad-hoc
  guards.

### Negative Consequences

- Adds the pack's first runtime `dependencies` entry (inlined at build, so no
  runtime cost — but the dep must resolve at build time).
- The claim is currently advisory only; no arbitration acts on it yet.

## Links

- comfy-modal-kit ADR-0001 — pointer-claim protocol (`laurigates/comfy-modal-kit#8`)
- Tracking issue: `laurigates/comfy-modal-kit#9`
- Relates to ADR-0001 (the TypeScript + bun build that inlines the kit)
- `src/index.ts` § `installGestureLayer` window-capture `pointerdown` listener

---
*Authored as part of adopting the comfy-modal-kit pointer-claim protocol.*
