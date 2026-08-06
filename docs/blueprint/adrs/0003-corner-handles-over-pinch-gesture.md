---
id: ADR-0003
date: 2026-08-06
status: Accepted
deciders: Lauri Gates
domain: frontend-framework
supersedes: []
relates-to: [ADR-0001, ADR-0002]
github-issues: [laurigates/comfyui-touch-resize#5]
name: corner-handles-over-pinch-gesture
---

# ADR-0003: Resize via corner grab-handles, replacing the two-finger pinch gesture

## Context and Problem Statement

v1 of this pack resized a selected node or group with a **two-finger pinch**
whose centroid landed inside it. It never worked reliably on a real device.
Issue #5 ("Verify pinch-to-resize browser smoke matrix on a touch device")
stayed open from 2026-06 with several matrix rows unverified, and the one
symptom that was reproduced on-device — the canvas becoming unresponsive to
taps after a resize, recovering only when the user backgrounded the browser —
survived two rounds of fixes (PR #44's `recoverNativePointerState` among them).

The root problem is not a bug in the implementation; it is the **shape of the
interaction**:

> A pinch is not recognizable until the SECOND finger lands.

By then the first finger's `pointerdown` has already reached LiteGraph, which
has opened a node-drag or canvas-pan transaction and taken pointer capture.
Every subsequent mechanism in v1 existed to paper over that: window-capture
suppression of the move stream, a `wheel` interceptor, `touchstart`/`touchmove`
hedges, `touch-action: none`, a synthetic `pointercancel` on release, a direct
`canvas.pointer.reset()`, manual clearing of six canvas-level drag flags, plus
Escape and `blur` escape hatches. That is roughly half the module, all of it
compensating for having recognized the gesture one finger too late.

### The stuck-canvas root cause (found while writing this ADR)

Reading the frontend sourcemap turned up the actual mechanism, which
`recoverNativePointerState` never addressed because it is not LiteGraph state
at all. ComfyUI ships a built-in extension, `Comfy.SimpleTouchSupport`
(`src/extensions/core/simpleTouchSupport.ts`), which:

- keeps a module-global `touchCount`, `+= e.changedTouches.length` on
  `touchstart` and `-=` on `touchend`; and
- monkey-patches `LGraphCanvas.prototype.processMouseDown` to **return early
  whenever `touchZooming || touchCount`** is truthy.

v1 suppressed `touchstart` at window capture but deliberately did **not**
suppress `touchend` (a prior fix, to avoid starving its own release path). So
the increment was swallowed and the decrement was not: `touchCount` drifted
**negative**, which is truthy, and `processMouseDown` returned early for every
subsequent tap. The only reset is `resetTouchState`, wired to `touchcancel` and
`visibilitychange` — precisely matching "it recovers when I switch apps".

The same file is also where two-finger pinch-zoom actually lives (a `touchmove`
handler on `canvasEl.parentElement` driving `ds.scale`/`ds.offset`), which
corrects a claim in the old CLAUDE.md that native zoom is wheel-driven. It is
wheel-driven for a trackpad; on a touchscreen it is this handler.

## Decision Drivers

- The interaction must be recognizable from the **first** pointer event, so the
  event can be suppressed before LiteGraph opens a transaction.
- It must not desynchronize `Comfy.SimpleTouchSupport`'s `touchCount`.
- It must be discoverable — v1's affordance was a faint corner bracket that
  told you nothing about the gesture available.
- It must remain additive: only `pos`/`size` written, no-op fallback intact.

## Considered Options

1. **Keep the pinch, fix `touchCount`** — add a compensating decrement, or
   suppress `touchend` symmetrically.
2. **Corner grab-handles** — draw hit-testable controls, drag to resize.
3. **Both**, handles plus pinch behind a config flag.

## Decision Outcome

**Option 2: corner grab-handles**, and the pinch is deleted outright.

Four amber circles are painted at the corners of the single selected item, and
a `pointerdown` within the hit radius of one starts a resize. The decisive
property is that this is knowable on the **first** event, so the adapter
suppresses that `pointerdown` and LiteGraph never opens a transaction. There is
no half-open state, therefore nothing to recover — `recoverNativePointerState`
and the entire suppression apparatus are deleted rather than repaired.

Option 1 was rejected because fixing `touchCount` would leave every other
consequence of late recognition in place; the stuck canvas was the loudest
symptom, not the only one. Option 3 was rejected because a dormant, unexercised
gesture path carries the same fragility at the same cost in complexity, with
nobody using it to notice when it rots.

### Consequential design choices

- **Pointer events only.** This layer never listens to `touchstart`,
  `touchmove`, or `touchend`, so `touchCount` stays balanced by construction.
  It also does not set `touch-action`. Recorded as a hard rule in CLAUDE.md.
- **Single selection only.** Handles render when exactly one item is selected;
  a ten-node rubber-band selection would otherwise paint forty circles.
- **Handles trace the item's visual outline.** The first draft placed a node's
  handles on its *body* corners, reasoning that the title bar's collapse toggle
  had to stay clear. Measuring the generated screenshot refuted it: body-corner
  handles sit ~17px from the first input and output slots — inside the hit
  radius — so tapping a slot on a selected node would grab a handle instead of
  starting a link drag. The title-bar corners are ~21px from the collapse
  toggle and ~45px from the slots, clearing both, so the rect spans the full
  outline and `hitRadiusPx` is capped at 18 with that ceiling recorded in
  `CONFIG`.
- **Anchor-based geometry.** `resizeFromCorner` derives the new box from the
  fixed opposite corner rather than by adding the delta to the size, which is
  what makes the min-size clamp stop moving `pos` instead of letting the box
  slide away from its anchor.
- **Assign `pos`/`size`, never mutate the arrays in place.** `LGraphNode`'s
  setters push geometry into the Vue layout store
  (`useLayoutMutations().moveNode` / `.resizeNode`); v1's `obj.size[0] = w`
  skipped them, so the canvas redrew while the layout store kept stale
  geometry. This was a latent bug in v1, fixed incidentally here.
- **A second finger aborts the drag** rather than fighting
  `SimpleTouchSupport`'s pinch-zoom for the same fingers.

## Consequences

- **Good:** the entire class of "LiteGraph left mid-transaction" bugs is
  designed out; the affordance is self-explanatory instead of a hint bracket;
  the module lost roughly half its lines; the screenshot pipeline no longer
  needs to fake a gesture illustration, because the handles are real UI.
- **Good:** pinned and collapsed items are now honoured (LiteGraph forbids
  resizing pinned items; v1 ignored the flag).
- **Bad:** handles are canvas-drawn, so they are invisible under the
  experimental Nodes 2.0 DOM renderer (`Comfy.VueNodes.Enabled`, default off
  for self-hosted). A DOM overlay would be needed to support that mode.
- **Bad:** the bottom-right handle sits over LiteGraph's native resize grip and
  takes priority there. Behaviour is equivalent, and the handle is the larger
  target, so this is accepted.
- **Neutral:** the pinch is gone. Anyone who relied on it must use the handles.
  This is a `feat!`-scale UX change and is released as such.

## Verification

The pure geometry and the reducer are unit-tested (51 assertions). Per the
`modal-pack-test-tiers` rule, the three load-bearing regression assertions were
mutation-tested — each was made to fail against a deliberately broken
implementation, and each mutant killed exactly one test:

| Mutant | Test that went red |
|---|---|
| `pos` follows the raw delta instead of the anchor | `STOPS moving pos once the clamp binds` |
| hit test takes the first match, not the nearest | `picks the NEAREST corner when two hit discs overlap` |
| reducer measures frame-to-frame instead of from the grab | `measures from the ORIGINAL geometry, not the previous frame` |

The DOM adapter and the drawing remain browser-matrix territory — see the
smoke matrix in CLAUDE.md, still to be run on a real device.
