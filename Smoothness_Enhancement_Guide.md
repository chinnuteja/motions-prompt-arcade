# Smoothness Enhancement — "Jarvis" Upgrade Guide

> Goal: make hand motion buttery (One-Euro filter), make the circle radius grow/shrink off ONE smoothed index-to-index distance, and add the clap-to-fade magic. Test locally, don't push until it's clearly better.
>
> Apply in this order. Each step is small and testable. Files touched: a new `oneEuro.ts`, then `useHandTracking.ts`, then `glitchTiles.ts`.

---

## WHY (the diagnosis — understand this, it's also your interview answer)

Two root causes of the "Siri, not Jarvis" feel:

1. **Over-snappy smoothing.** In `useHandTracking.ts`, `POSITION_ALPHA` was raised to `0.65` ("snappier"). Higher alpha = follows raw jittery MediaPipe data more closely = wobble. His product is *more* smoothed. The fix isn't just "lower alpha" (that adds lag) — it's the **One-Euro filter**: smooth when slow (kills jitter at rest), responsive when fast (no lag on quick moves). Best of both.

2. **Formations driven by too many noisy inputs.** His formations anchor to ONE stable reference — the index-to-index line — so the geometry is calm. Yours computes from many fingertips/palms at once, compounding jitter. Fix: keep rich gesture *detection*, but drive formation *geometry* (especially the circle radius) off ONE heavily-smoothed distance.

---

## STEP 1 — Add the One-Euro filter utility

Create `src/lib/effects/oneEuro.ts` (or wherever your fxUtils live) with this:

```ts
// ─── One-Euro Filter ────────────────────────────────────────────
// Smooth when slow, responsive when fast. Standard filter for real-time
// interactive tracking. Beats plain EMA: low speed → heavy smoothing
// (kills jitter at rest), high speed → light smoothing (no lag).
// Ref: Casiez, Roussel, Vogel (2012), "1€ Filter".
//   minCutoff ↓  => more smoothing at low speed
//   beta      ↑  => more responsive at high speed

export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private initialized = false;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, dt: number): number {
    if (!this.initialized || dt <= 0) {
      this.xPrev = x; this.dxPrev = 0; this.initialized = true;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat; this.dxPrev = dxHat;
    return xHat;
  }
  reset(): void { this.initialized = false; this.xPrev = 0; this.dxPrev = 0; }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }
  filter(x: number, y: number, dt: number): { x: number; y: number } {
    return { x: this.fx.filter(x, dt), y: this.fy.filter(y, dt) };
  }
  reset(): void { this.fx.reset(); this.fy.reset(); }
}
```

**Test after this step:** nothing visual yet — just confirm it compiles / imports clean.

---

## STEP 2 — Use One-Euro for palm + indexTip in `useHandTracking.ts`

We replace the EMA on the two *positions that drive visuals* (palm, indexTip) with One-Euro. Keep EMA for the other signals (pinch, openness, scale) — they're fine. We also lower `POSITION_ALPHA` back down for the landmark array.

**2a. Imports** — at top of `useHandTracking.ts`:
```ts
import { OneEuroFilter2D } from '../lib/effects/oneEuro'; // adjust path
```

**2b. Change the alpha constant** (line ~31). Lower it — One-Euro now handles the important positions, and the landmark array can be gently smoothed:
```ts
const POSITION_ALPHA = 0.4;   // was 0.65 — One-Euro now smooths palm/tip; this is just for the raw landmark array
```

**2c. Add filters to the slot.** In `HandSlotInternal` interface, add:
```ts
  // One-Euro filters for the visual-critical positions
  palmFilter: OneEuroFilter2D;
  tipFilter: OneEuroFilter2D;
```

**2d. In `createEmptySlot`**, instantiate them. Tuned for a smooth-but-alive feel:
```ts
    palmFilter: new OneEuroFilter2D(1.0, 0.015),  // palm: heavier smoothing (it's a slow anchor)
    tipFilter:  new OneEuroFilter2D(1.6, 0.03),   // tip: a bit snappier (it draws/leads)
```
(Higher minCutoff on the tip = follows fast draws; lower on palm = rock-steady anchor. Tune these two pairs to taste in Step 5.)

**2e. In `updateSlot`**, replace the EMA lines for palm/tip with One-Euro. Find:
```ts
    slot.palmX = ema(slot.palmX, rawPalmX, POSITION_ALPHA);
    slot.palmY = ema(slot.palmY, rawPalmY, POSITION_ALPHA);
    slot.tipX = ema(slot.tipX, rawTipX, POSITION_ALPHA);
    slot.tipY = ema(slot.tipY, rawTipY, POSITION_ALPHA);
```
Replace with (compute dt in seconds first):
```ts
    const dtSec = Math.max(0.001, (timestamp - slot.prevTimestamp) / 1000);
    const palmF = slot.palmFilter.filter(rawPalmX, rawPalmY, dtSec);
    const tipF  = slot.tipFilter.filter(rawTipX, rawTipY, dtSec);
    slot.palmX = palmF.x; slot.palmY = palmF.y;
    slot.tipX = tipF.x;  slot.tipY = tipF.y;
```
(The landmark-array EMA loop below stays as-is with the lowered POSITION_ALPHA.)

**2f. In the `if (!slot.initialized)` block**, reset the filters so they snap on first frame (no chase from 0,0):
```ts
    slot.palmFilter.reset();
    slot.tipFilter.reset();
    // then the existing snap assignments...
```
And on going LOST (in the loop where `slot.initialized = false`), the filters auto-reset on next init — but to be safe you can also call reset there.

**Test after this step:** move your hand. It should feel noticeably smoother when moving slowly / holding still, while still keeping up when you move fast. If it feels laggy, raise the minCutoff numbers (2c→2d). If still jittery, lower them. This is the main "Jarvis" win — spend a few minutes here.

---

## STEP 3 — Add ONE smoothed index-to-index distance to the hook

This is the single stable signal that will drive the circle radius AND the clap. Compute it once, smooth it hard, expose it.

**3a. Extend the output type** `HandTrackingState`:
```ts
export interface HandTrackingState {
  hands: [HandSignals | null, HandSignals | null];
  detectionHz: number;
  t: number;
  // NEW: stable two-hand metrics (null when fewer than 2 hands)
  twoHand: {
    indexDist: number;   // smoothed px distance between the two index tips
    palmDist: number;    // smoothed px distance between palms (fallback / clap)
    midX: number;        // midpoint (for centering formations)
    midY: number;
  } | null;
}
```

**3b. Add module-level smoothing filters** (near the other refs in the hook), using One-Euro on the scalar distance so it's smooth but still reacts when you deliberately spread/close hands:
```ts
const twoHandIndexFilter = useRef(new OneEuroFilter(0.8, 0.01));  // heavy smoothing: a calm radius
const twoHandPalmFilter  = useRef(new OneEuroFilter(0.8, 0.01));
```
(Import `OneEuroFilter` too.)

**3c. After you build `leftSignals` / `rightSignals`** in the loop, compute the two-hand block:
```ts
let twoHand: HandTrackingState['twoHand'] = null;
if (leftSignals && rightSignals) {
  const dtSec = Math.max(0.001, (now - (signalsRef.current.t || now)) / 1000);

  const ix = leftSignals.indexTip.x, iy = leftSignals.indexTip.y;
  const jx = rightSignals.indexTip.x, jy = rightSignals.indexTip.y;
  const rawIndexDist = Math.hypot(jx - ix, jy - iy);

  const px = leftSignals.palm.x, py = leftSignals.palm.y;
  const qx = rightSignals.palm.x, qy = rightSignals.palm.y;
  const rawPalmDist = Math.hypot(qx - px, qy - py);

  twoHand = {
    indexDist: twoHandIndexFilter.current.filter(rawIndexDist, dtSec),
    palmDist:  twoHandPalmFilter.current.filter(rawPalmDist, dtSec),
    midX: (px + qx) / 2,
    midY: (py + qy) / 2,
  };
} else {
  twoHandIndexFilter.current.reset();
  twoHandPalmFilter.current.reset();
}

signalsRef.current = {
  hands: [leftSignals, rightSignals],
  detectionHz: detectionHzRef.current,
  t: now,
  twoHand,
};
```
(Also add `twoHand: null` to the two places that reset `signalsRef.current` to empty.)

**Test after this step:** log `signalsRef.current.twoHand?.indexDist` — when both hands are up, it should be a smooth number that rises as you spread hands apart and falls as you bring them together, without jitter.

---

## STEP 4 — Use that one distance in `glitchTiles.ts` for the radius + clap

Now the payoff. Two changes in the circle formation.

**4a. Pass `twoHand` into the effect.** Wherever the engine calls the effect's `step`, include the new `twoHand` (or read it from the shared signals the effect already gets). You're already passing `latestHands`; pass `twoHand` alongside.

**4b. Drive the circle radius off `twoHand.indexDist`.** Find the circle-formation block (around the `RING_R` / circle target computation). Instead of deriving radius from noisy multi-finger data, do:
```ts
// Circle radius from ONE smoothed signal → neat grow/shrink like the reference
const baseR = 120;
const radius = twoHand
  ? clamp(baseR + twoHand.indexDist * 0.45, 90, 380)   // tune 0.45 / bounds to taste
  : RING_R;
// center the circle on the smoothed midpoint
const cx = twoHand ? twoHand.midX : near.palm.x;
const cy = twoHand ? twoHand.midY : near.palm.y;
// ...place each formation card at angle θ around (cx, cy) with this radius
```
This makes the circle expand/contract smoothly with hand spread — the exact behavior you described in his demo.

**4c. The clap-to-fade magic.** Add near the top of the formation logic:
```ts
// CLAP: hands brought together → cards converge to midpoint and fade out
const CLAP_DIST = 90;          // px palm-to-palm to trigger
if (twoHand && twoHand.palmDist < CLAP_DIST) {
  this.clapT = Math.min(1, this.clapT + dt * 3);  // ramp 0→1 over ~0.33s
} else {
  this.clapT = Math.max(0, this.clapT - dt * 2);
}
```
Add `private clapT = 0;` to the class. Then in the per-card update, when `clapT > 0`, pull cards toward the midpoint and fade their alpha by `(1 - clapT)`:
```ts
if (this.clapT > 0 && twoHand) {
  const k = this.clapT;
  c.x += (twoHand.midX - c.x) * k * 0.4;
  c.y += (twoHand.midY - c.y) * k * 0.4;
  // shrink + fade (apply cardAlpha *= (1 - k) at draw time)
}
```
And in `draw`, multiply each card's alpha by `(1 - this.clapT)` so they vanish as hands meet — the "magic" disappearance. When hands part again, `clapT` ramps back to 0 and cards return.

**Test after this step:** two hands up → cards form a circle; spread hands → circle grows smoothly; bring hands to a clap → cards rush to center and fade out; part hands → they come back.

---

## STEP 5 — Tune to taste (the "feel" pass)

These are the knobs. Adjust live while watching:
- **Too laggy?** raise `minCutoff` on tip (Step 2d) and on `twoHandIndexFilter` (Step 3b).
- **Still jittery?** lower those `minCutoff` values.
- **Radius too sensitive / not enough?** the `0.45` multiplier in 4b.
- **Clap triggers too easily / not enough?** `CLAP_DIST` in 4c.
- **Formation engages too snappy?** in glitchTiles, line ~255, lower the `expDamp(15, dt)` to `expDamp(9, dt)` for a smoother, more "premium" settle.

Spend most of your time in Step 2 and Step 5 — that's where 80% of the "Jarvis" feel comes from.

---

## INTERVIEW NOTE (say this if he asks how you improved it)

> "The original tracking used a fixed EMA cranked high for responsiveness, which followed the raw MediaPipe jitter too closely. I swapped the visual-critical positions to a One-Euro filter — it smooths heavily when the hand is slow or still, and loosens up when you move fast, so you get no jitter at rest and no lag on quick moves. And I noticed the formations were reacting to too many noisy keypoints, so I drive the circle geometry off a single heavily-smoothed index-to-index distance instead — one stable signal in, one calm radius out. Same idea as measuring relative to body scale: reduce the noisy inputs, anchor to one stable reference."

That's a precise, senior-sounding explanation — and it's true.
```
