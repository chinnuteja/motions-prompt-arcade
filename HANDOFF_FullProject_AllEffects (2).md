# Hand-VFX Compiler — FULL Technical Handoff (All 4 Effects)

> Paste into a new chat to continue. Covers the WHOLE project: the architecture, the shared tracking hook (the "intersection" file all effects depend on), and all FOUR effects — current state, what's been changed, what's pending. Tiles are being worked first; the other three are queued for the same treatment. No external/personal context — pure engineering.

---

## 1. WHAT THE PROJECT IS

Web app (Next.js 16 + React 19 + TypeScript, Vercel) that turns a text prompt into a real-time, hand-controlled visual effect on the user's webcam.

Pipeline:
- **Prompt → AI → config:** user types a prompt; an LLM (Azure OpenAI) compiles it into a strict JSON `EffectConfig` (constrained menu, low temperature, JSON-only, Zod-validated). AI is a constrained router, not a free generator.
- **Config → engine:** config is base64-encoded into the URL (no database; effect lives in the shareable link). Play page decodes and runs it.
- **Tracking:** MediaPipe **Hands** (21 keypoints/hand, up to 2 hands), on-device, GPU. The hook `useHandTracking.ts` turns raw landmarks into clean `HandSignals`, exposed via a ref (no React re-render in the 60fps loop).
- **Effects:** FOUR engines, each its own file, each implementing a `VfxEffect` interface (`init/step/draw`-style). They are INDEPENDENT — editing one does NOT affect the others. Only the shared hook is common.
- **Rendering:** 60fps `requestAnimationFrame`, dt-clamped (≤33ms). Visible canvas + hidden composite canvas for clip recording (MediaRecorder → WebM). Live FPS overlay. Adaptive `stepDownQuality()` tiers on all effects to hold 60fps on weak hardware.

Adapted from an earlier "PROMPT.arcade" (prompt→body-game compiler) by swapping pose→hands and games→visual-effects.

---

## 2. FILE MAP

**Shared / core:**
- **`src/hooks/useHandTracking.ts`** — THE INTERSECTION FILE. Loads MediaPipe Hands, computes per-hand `HandSignals`, stable Left/Right slot routing by handedness, smoothing. **Shared by all four effects. Changes here affect all four (usually for the better).**
- **`src/lib/effects/oneEuro.ts`** — One-Euro adaptive filter (`OneEuroFilter` scalar, `OneEuroFilter2D` point). "Smooth when slow, responsive when fast."
- **`src/lib/effects/fxUtils.ts`** — shared math/physics: `springStep` (semi-implicit Euler), `expDamp` (frame-rate-independent damping), `easeOutBack`, `clamp`, `lerpColor`, sprite makers, `EmberPool` (Float32Array particle pool, zero-alloc).
- **`src/lib/vfx-schema.ts`** — `EffectConfig` schema (discriminated union), palettes, base64 encode/decode.
- **`src/app/api/generate-vfx/route.ts`** — LLM compile endpoint (system prompt = the effect menu + palette/intensity mapping + few-shot examples; Zod-validated; retry+fallback).
- **`src/components/EffectEngine/EffectEngine.tsx`** — orchestrator: webcam, tracking, session state machine (permission/onboarding/coasting/idle), rAF loop, perf overlay, hot-swaps active effect by config.

**The four effect files:**
- **`src/lib/effects/glitchTiles.ts`** — Glass Cards (CURRENTLY BEING WORKED ON). ~1140 lines.
- **`src/lib/effects/particleNebula.ts`** — Particle Nebula (QUEUED).
- **`src/lib/effects/fireMagic.ts`** (or similar name) — Fire Magic (QUEUED).
- **`src/lib/effects/auraBlaster.ts`** (or similar name) — Aura Blaster (QUEUED).

> NOTE: only glitchTiles.ts, useHandTracking.ts, oneEuro.ts have been shared with the assistant so far. The other three effect files must be PASTED when work on them begins.

---

## 3. THE SHARED HOOK (`useHandTracking.ts`) — signals + recent changes

Per tracked hand → `HandSignals`:
- `track`: 'tracking' | 'coasting' | 'lost'; `confidence`; `framesSinceSeen`
- `palm {x,y}`, `indexTip {x,y}` — smoothed px positions (now One-Euro filtered)
- `landmarks[]` — 21 points (EMA-smoothed, `POSITION_ALPHA = 0.4`)
- `indexVel {x,y}`; `pinch` (0–1), `pinching` (hysteresis), `pinchJustStarted/Ended`
- `openness` (0 fist → 1 splayed); `scale` (hand-size px); `edgeClipped`

Internals: stable Left/Right slots keyed by handedness (MediaPipe array order is unstable); per-slot smoothing state; coasting (12 frames ~200ms) → lost.

**RECENT CHANGES ALREADY APPLIED (live):**
- Replaced fixed-alpha EMA on `palm` + `indexTip` with **One-Euro filters** (smoother, less jitter at rest, no lag when fast).
- `POSITION_ALPHA` 0.65 → 0.4 (landmark array).
- Pinch exit threshold widened (PINCH_EXIT 0.40 → 0.65) so the pen/grab doesn't drop.

**IMPACT ON ALL FOUR EFFECTS (important):**
- This smoothing helps ALL effects' hand-following (Nebula particles, Fire hand-basis, Aura charge, Tiles formations) — generally a net positive (smoother).
- CAVEAT: an effect tuned for the OLD snappier movement might feel slightly laggy on fast flicks. Fix if needed = per-effect: read positions through a snappier One-Euro setting (higher minCutoff) or use `indexVel` for fast gestures. Not a rewrite. **All three queued effects should be RE-TESTED after this hook change.**

---

## 4. THE FOUR EFFECTS — concept + gesture map + likely work needed

### 4.1 GLITCH TILES (Glass Cards) — IN PROGRESS
Live webcam slices ("cards") float around the hands and snap into formations. Grab with pinch, throw to ignite (fire trail via EmberPool).
- **Formations:** keeping **line** + **circle** + **clap-to-fade**; **dropping square + pack** (they misfire).
- Geometry (`getFormationTarget`) is GOOD: circle = smoothed midpoint center + smoothed index-distance radius + tilted ellipse; line = cards along index-to-index axis + travelling shimmer.
- Bugs/fixes: see §5 (this is the active task).

### 4.2 PARTICLE NEBULA — QUEUED
4,000+ particle system (Float32Array SoA, zero-alloc) orbiting the hands.
- **Gestures:** fist → particles pull into a black-hole orbit around palm; open hand → explode/release; two pinches → two black holes (density splits); open hands → "constellation" polygon at fingertips; hands together → "galaxy core."
- Uses symplectic Euler, velocity-stretch motion blur, additive blending.
- **Likely work:** re-test after hook change; check gestures don't misfire (same multi-finger ambiguity risk as tiles); possibly anchor formations to stable signals (palm, openness) and reduce noisy triggers; tune feel.

### 4.3 FIRE MAGIC — QUEUED
Fluid-ish fire sim (heat advection, curl noise, ping-pong canvas).
- **Gestures:** fists "charge" heat; open palms erupt; "flamethrower" = tight ribbon from knuckles; "burst" = open hand → jets from all five fingertips; uses a "HandBasis" (forward/side vectors) so fire shears/twists with wrist rotation.
- **Likely work:** re-test after hook change (fluid sims are sensitive to input smoothness — may need its own snappier filter on the driving point); verify the curl-noise/ping-pong perf holds 60fps; tune gesture thresholds.

### 4.4 AURA BLASTER — QUEUED
DBZ/Iron-Man energy blast.
- **Gestures:** closed fist charges a rotating energy sphere; opening palm unloads a screen-spanning beam; beam pushes a shockwave; ambient particles in the path get supercharged + blasted off.
- **Likely work:** re-test after hook change; check charge/release gesture reliability (fist→open detection); tune beam feel + shockwave; perf check.

---

## 5. GLITCH TILES — THE THREE ACTIVE BUGS + FIXES

`glitchTiles.ts` structure: `Card` interface (x,y,vx,vy,rot, held(-1 free), fire(0–1), formationSlot, formDepth…); `FormationMode = 'none'|'line'|'circle'|'square'|'pack'`; `targetCount` (12, raising to ~18); `step()` (per-frame: twoHand metrics → clap → selectFormation → slot assign → grab/throw → physics); `selectFormation()` (BUG SOURCE); `getFingerProfile()` (finger-extended detection via `ratio(idx)=dist(landmark,palm)/handScale`); `getFormationTarget()` (geometry — GOOD).

twoHand metrics in step() (~line 256): `twoHandIndexDist`, `twoHandPalmDist`, `twoHandMidX/Y`, `twoHandActive`, via `indexDistFilter`/`palmDistFilter` (OneEuroFilter). Clap (~line 279): `clapT` ramps when `twoHandPalmDist < CLAP_DIST`.

### BUG 1 — Line never triggers (always circle)
Cause: `selectFormation` returns circle as DEFAULT for any two hands; and `getFingerProfile` index test (`ratio(8) > 1.02`) too strict so "two index fingers" rarely reads.
Fix — circle must REQUIRE open hands, fallback = none, loosen index threshold, add clap guard:
```ts
private selectFormation(hands, profiles): FormationIntent {
  const h0 = hands[0], h1 = hands[1];
  const tracked0 = h0 && h0.track !== 'lost';
  const tracked1 = h1 && h1.track !== 'lost';
  if (this.clapT > 0.4) return { mode: 'none', handIndex: 0 };
  if (tracked0 && tracked1 && h0 && h1) {
    const p0 = profiles[0], p1 = profiles[1];
    const anyPinch = h0.pinching || h1.pinching;
    if (!anyPinch) {
      const idx0 = !!(p0?.index && !p0?.middle && !p0?.ring && !p0?.pinky);
      const idx1 = !!(p1?.index && !p1?.middle && !p1?.ring && !p1?.pinky);
      if (idx0 && idx1) return { mode: 'line', handIndex: 0 };
      const bothOpenish = h0.openness > 0.45 && h1.openness > 0.45;
      if (bothOpenish) return { mode: 'circle', handIndex: 0 };
      return { mode: 'none', handIndex: 0 };
    }
  }
  for (let hi = 0; hi < 2; hi++) {
    const hand = hands[hi], profile = profiles[hi];
    if (!hand || hand.track === 'lost' || !profile) continue;
    if (hand.pinching) continue;
    const indexUp = profile.index && !profile.middle && !profile.ring && !profile.pinky;
    if (indexUp) return { mode: 'line', handIndex: hi };
  }
  return { mode: 'none', handIndex: 0 };
}
```
Plus in `getFingerProfile`: `const index = ratio(8) > 0.95;` (was 1.02).

### BUG 2 — Formation degrades after the first (spacing grows / scramble)
Cause: slots re-sorted+re-assigned EVERY frame (~line 322) → cards jump slots on any change.
Fix: assign slots ONCE per formation, hold stable. Add `private _slottedMode: FormationMode = 'none';`. Re-assign only when `formationMode !== _slottedMode` OR a free card has `formationSlot === -1`. (Stable slots = no churn.) This is the fix for the biggest complaint.

### BUG 3 — Clap doesn't collapse
Cause: Bug 1 made circle always-on (competes); `CLAP_DIST=90` too tight; nothing moved/faded cards.
Fix: `CLAP_DIST = 140`; in per-card update when `clapT>0.01 && twoHandActive`: `c.x += (twoHandMidX-c.x)*clapT*0.35` (same y); in draw multiply card alpha by `(1-clapT)`; formation suppressed by the `clapT>0.4` guard.

Then: `targetCount` 12 → ~18 (density); feel pass (engage speed `expDamp` ~7–11, radius `*0.55` multiplier, stiffness/damping).

DEBUG: if line still won't trigger after Bug 1 fix, log `profiles[0]` while holding ONE index up; read `index/middle/ring/pinky/extendedCount` to set exact threshold.

---

## 6. STATUS

**Done & live:** One-Euro in hook; POSITION_ALPHA 0.4; circle radius from smoothed dist; clap scaffolding; engage softened; selectFormation first pass.

**First-pass test results (problems):** circle only works palms-to-camera (fixed via openness 0.45); line never triggers (Bug 1); clap doesn't collapse (Bug 3); formations degrade after first (Bug 2); too much empty space (need targetCount ~18).

**Pending — TILES:** apply Bug 1/2/3 fixes (user has implemented, NEEDS TESTING), then density + feel pass.

**Pending — OTHER 3 EFFECTS (after tiles):** re-test all three after the hook smoothing change; diagnose gesture misfires; simplify triggers to stable signals where noisy; per-effect feel/perf tuning. **Their files must be pasted when starting each.**

---

## 7. WORKING RULES
- Test LOCALLY; don't push until clearly better (a working version is live).
- Editing one effect file does NOT affect the others. Only `useHandTracking.ts` is shared — its changes ripple to all four (re-test all four after any hook change).
- Geometry is generally fine; fixes tend to be in TRIGGERS + slot stability + feel-tuning, not shape math.
- Apply fixes in order, test after each.
- Sequence: finish TILES → then Nebula → Fire → Aura, one at a time, same diagnose→simplify→test→tune method.

---

## 8. IMMEDIATE NEXT ACTION
Confirm the 3 tile fixes work (line triggers on two index fingers; circle works any palm orientation; clap collapses+fades; formations stay clean on repeat). Bump `targetCount` to 18, feel-tune. THEN move to the other three effects — paste each file as you start it, re-test it against the new smoothed hook, and fix gesture misfires / tune feel the same way. The other three are "mostly working" but need the same polish pass to feel premium.


# ADDENDUM v2 — Changes Since the Handoff Doc (paste AFTER the main handoff)

> Read with HANDOFF_FullProject_AllEffects.md. This is the LATEST state. Supersedes addendum v1.

## FINAL DESIGN DECISION FOR TILES (the "last iteration")
Abandoned finger-profile gesture detection for formations entirely — it was the root of every line failure (thresholds unreliable after One-Euro smoothing). New design copies the reference product's structural trick:

**Two hands tracked = the index↔index tether line ALWAYS exists. One smoothed distance signal decides the formation. ZERO finger detection in the formation path.**

- d (smoothed twoHandIndexDist) in 140–420px → LINE (cards along the index↔index axis)
- d ≥ 420px → CIRCLE (same axis = diameter)
- palms together → CLAP collapse+fade, then 0.8s cooldown (clapCooldown field) before formations re-engage
- pinching suppresses formations (grab wins)
- A VISIBLE white tether line + endpoint dots is drawn between the two index tips whenever both hands tracked (the "Jarvis" beam) — drawn in draw() before cards, hidden when clapT > 0.5
- targetCount → 20 (density; fixes empty-space complaint)
- getFingerProfile may remain in file but is NO LONGER USED for formation selection (pinch grabbing unaffected — it uses pinch hysteresis from the hook)

### New selectFormation (current intended code):
```ts
private selectFormation(hands, profiles): FormationIntent {
  if (this.clapCooldown > 0 || this.clapT > 0.4) return { mode: 'none', handIndex: 0 };
  const h0 = hands[0], h1 = hands[1];
  const both = h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost';
  if (both) {
    const anyPinch = h0!.pinching || h1!.pinching;
    if (!anyPinch) {
      const d = this.twoHandActive ? this.twoHandIndexDist : 0;
      if (d > 140 && d < 420) return { mode: 'line', handIndex: 0 };
      if (d >= 420) return { mode: 'circle', handIndex: 0 };
    }
  }
  return { mode: 'none', handIndex: 0 };
}
```
Tuning knobs: the 140 / 420 px thresholds (set live to taste per camera).

### Clap cooldown (applied):
```ts
private clapCooldown = 0;
// in step after clapT update:
if (this.clapT > 0.9) this.clapCooldown = 0.8;
this.clapCooldown = Math.max(0, this.clapCooldown - dt);
```

### Visible tether (added to draw(), before cards):
White 2px line + glow (shadowBlur 12, primary color) between h0.indexTip and h1.indexTip, plus 5px white dots at each tip. Skipped when clapT >= 0.5 or either hand lost.

## STATUS AFTER PREVIOUS TESTS (why this redesign)
- Circle: worked (better with smoothed distance) but sparse → targetCount 20.
- Line: NEVER triggered via finger profiles (threshold unreliable post-smoothing) → eliminated detection entirely.
- Clap: collapsed then instantly re-formed randomly → cooldown fix.
- Formations degraded after first use → stable-slot fix (handoff §5 Bug 2: _slottedMode, assign once, hold).

## TILES CHECKLIST (verify after this iteration)
1. Two hands up, medium apart → visible tether + cards form LINE along it (any angle/diagonal) ✓?
2. Spread wide → smooth transition to CIRCLE ✓?
3. Clap → collapse + fade → 0.8s calm → clean re-form ✓?
4. Repeat formations 5+ times → no degradation, no growing gaps ✓?
5. Density: 20 cards, line/circle look full ✓?
6. Pinch-grab still works, doesn't fight formations ✓?
7. FPS stays ~60 with 20 cards ✓?

## OTHER 3 EFFECTS (Nebula, Fire, Aura) — still queued, unchanged
After tiles verified: paste each effect file, re-test against the One-Euro-smoothed hook, fix gesture misfires, tune feel. (Handoff §4 has each effect's concept + gesture map.)


# ADDENDUM v2 — Changes Since the Handoff Doc (paste AFTER the main handoff)

> Read with HANDOFF_FullProject_AllEffects.md. This is the LATEST state. Supersedes addendum v1.

## FINAL DESIGN DECISION FOR TILES (the "last iteration")
Abandoned finger-profile gesture detection for formations entirely — it was the root of every line failure (thresholds unreliable after One-Euro smoothing). New design copies the reference product's structural trick:

**Two hands tracked = the index↔index tether line ALWAYS exists. One smoothed distance signal decides the formation. ZERO finger detection in the formation path.**

- d (smoothed twoHandIndexDist) in 140–420px → LINE (cards along the index↔index axis)
- d ≥ 420px → CIRCLE (same axis = diameter)
- palms together → CLAP collapse+fade, then 0.8s cooldown (clapCooldown field) before formations re-engage
- pinching suppresses formations (grab wins)
- A VISIBLE white tether line + endpoint dots is drawn between the two index tips whenever both hands tracked (the "Jarvis" beam) — drawn in draw() before cards, hidden when clapT > 0.5
- targetCount → 20 (density; fixes empty-space complaint)
- getFingerProfile may remain in file but is NO LONGER USED for formation selection (pinch grabbing unaffected — it uses pinch hysteresis from the hook)

### New selectFormation (current intended code):
```ts
private selectFormation(hands, profiles): FormationIntent {
  if (this.clapCooldown > 0 || this.clapT > 0.4) return { mode: 'none', handIndex: 0 };
  const h0 = hands[0], h1 = hands[1];
  const both = h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost';
  if (both) {
    const anyPinch = h0!.pinching || h1!.pinching;
    if (!anyPinch) {
      const d = this.twoHandActive ? this.twoHandIndexDist : 0;
      if (d > 140 && d < 420) return { mode: 'line', handIndex: 0 };
      if (d >= 420) return { mode: 'circle', handIndex: 0 };
    }
  }
  return { mode: 'none', handIndex: 0 };
}
```
Tuning knobs: the 140 / 420 px thresholds (set live to taste per camera).

### Clap cooldown (applied):
```ts
private clapCooldown = 0;
// in step after clapT update:
if (this.clapT > 0.9) this.clapCooldown = 0.8;
this.clapCooldown = Math.max(0, this.clapCooldown - dt);
```

### Visible tether (added to draw(), before cards):
White 2px line + glow (shadowBlur 12, primary color) between h0.indexTip and h1.indexTip, plus 5px white dots at each tip. Skipped when clapT >= 0.5 or either hand lost.

## STATUS AFTER PREVIOUS TESTS (why this redesign)
- Circle: worked (better with smoothed distance) but sparse → targetCount 20.
- Line: NEVER triggered via finger profiles (threshold unreliable post-smoothing) → eliminated detection entirely.
- Clap: collapsed then instantly re-formed randomly → cooldown fix.
- Formations degraded after first use → stable-slot fix (handoff §5 Bug 2: _slottedMode, assign once, hold).

## TILES CHECKLIST (verify after this iteration)
1. Two hands up, medium apart → visible tether + cards form LINE along it (any angle/diagonal) ✓?
2. Spread wide → smooth transition to CIRCLE ✓?
3. Clap → collapse + fade → 0.8s calm → clean re-form ✓?
4. Repeat formations 5+ times → no degradation, no growing gaps ✓?
5. Density: 20 cards, line/circle look full ✓?
6. Pinch-grab still works, doesn't fight formations ✓?
7. FPS stays ~60 with 20 cards ✓?

## OTHER 3 EFFECTS (Nebula, Fire, Aura) — still queued, unchanged
After tiles verified: paste each effect file, re-test against the One-Euro-smoothed hook, fix gesture misfires, tune feel. (Handoff §4 has each effect's concept + gesture map.)