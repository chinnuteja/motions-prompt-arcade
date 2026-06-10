# PROMPT.arcade → Hand-Controlled Visual Effects Compiler
## Implementation Plan — v2 (single source of truth)

---

## 1. Summary — what's reused vs. what's new

You are reusing roughly 70% of PROMPT.arcade unchanged: the constrained-router AI pattern (`/api/generate` with a fixed menu, temperature 0.2, JSON-only output, server-side validation), the base64-config-in-URL sharing architecture (`encodeGameConfig`/`decodeGameConfig` work as-is with a new schema), the ref-based 60fps rendering philosophy (landmarks in `useRef`, direct canvas drawing, no React state in the hot path), and the hidden-composite-canvas + `MediaRecorder` clip pipeline. What's new is five things: (a) the tracking layer swaps `PoseLandmarker` for `HandLandmarker` and gains a **derived-signals layer** (pinch, palm center, openness, fingertip velocity, tracking confidence — computed and smoothed once per frame so every effect consumes clean signals instead of raw jittery keypoints); (b) a new **EffectConfig schema** — a fixed menu of 3 effect types × palettes × enum params; (c) the **EffectEngine** with three physics-driven effects (Glitch Tiles, Particle Nebula, Light Ribbons); (d) a **session state machine** that owns the entire unhappy path — permission flow, onboarding gate, hand-loss coasting, condition hints — so the experience never shows a dead or broken screen, even cold, in bad lighting, to a first-timer; and (e) a **toggleable performance overlay** that both proves the 60fps claim on screen and feeds an adaptive-quality fallback. No scoring, no win conditions — GameEngine's "evaluator" concept becomes a "simulator" concept.

---

## 2. The new config schema (the constrained effect menu)

The schema follows the same principle as GameConfig: **the AI can only choose, never invent.** Every field is an enum or a bounded integer. Anything aesthetic that needs a continuous value (force strengths, particle counts, decay rates) is derived deterministically on the client from `intensity` — the LLM never touches raw physics numbers, which is what keeps output validation trivial and effects un-breakable.

```ts
// schema.ts (new)

export type EffectType = "glitch_tiles" | "particle_nebula" | "light_ribbons";

export type PaletteId = "neon" | "ember" | "vapor" | "mono" | "acid" | "ocean";
// Each palette is a client-side preset: { primary, secondary, glow, bgTreatment }
// e.g. neon = cyan/magenta on dimmed video; ember = orange/red; mono = white/grey.

export interface EffectConfigBase {
  v: 1;                      // schema version (future-proofs old share links)
  effect: EffectType;
  palette: PaletteId;
  intensity: 1 | 2 | 3;      // scales particle counts, forces, tile density
  prompt: string;            // original user prompt, shown in HUD + clip watermark
}

export interface GlitchTilesConfig extends EffectConfigBase {
  effect: "glitch_tiles";
  params: {
    tileShape: "square" | "wide" | "shard";   // grid cell aspect / jitter style
    pullMode: "attract" | "repel" | "vortex"; // what fingertips do to tiles
    snapBack: "spring" | "drift";             // how tiles return home
  };
}

export interface ParticleNebulaConfig extends EffectConfigBase {
  effect: "particle_nebula";
  params: {
    motion: "orbit" | "stream" | "swarm";     // tangential vs radial vs noisy
    openHandAction: "explode" | "release";    // what spreading fingers does
    trail: "short" | "long";                  // per-particle motion blur
  };
}

export interface LightRibbonsConfig extends EffectConfigBase {
  effect: "light_ribbons";
  params: {
    brush: "ribbon" | "lightning" | "smoke";  // stroke rendering style
    persistence: "fading" | "lasting";        // trail-canvas decay rate
    pinchAction: "penDown" | "widthControl";  // pinch gates emission or maps to width
  };
}

export type EffectConfig =
  | GlitchTilesConfig
  | ParticleNebulaConfig
  | LightRibbonsConfig;
```

Alongside the schema lives a small static **per-effect metadata table** (client-side, not LLM-visible) used by onboarding and the HUD:

```ts
const EFFECT_META: Record<EffectType, { gestureHint: string; idleBehavior: string }> = {
  glitch_tiles:    { gestureHint: "point to warp · pinch to grab",  idleBehavior: "settle" },
  particle_nebula: { gestureHint: "make a fist to gather the stars", idleBehavior: "drift" },
  light_ribbons:   { gestureHint: "pinch to draw in the air",        idleBehavior: "fade" },
};
```

**Validation:** a zod schema (discriminated union on `effect`) on the server in `/api/generate`, and again client-side in the `/play` decoder — because URLs are user-editable, the client must never trust the decoded config. On validation failure client-side, fall back to a default config rather than crashing (someone hand-editing a share link should get *an* effect, not an error page).

**URL encoding:** `encodeGameConfig`/`decodeGameConfig` are reused byte-for-byte — same `JSON.stringify → encodeURIComponent → btoa` pipeline. These configs are ~200 chars of JSON → ~300 chars of base64. Well within URL limits.

---

## 3. The three effects (the heart)

All three share the same engine skeleton, so I'll state it once:

**Shared engine contract.** Each effect is a module exporting `{ init(config, w, h), step(signals, dt, ramp, video), draw(ctx, video) }`. State lives in plain objects/typed arrays held by the engine in a `useRef` — never React state. The engine's `requestAnimationFrame` loop each frame: (1) reads the latest smoothed hand signals from the tracking ref, (2) calls `step` with `dt` clamped to ≤ 33ms (so a dropped frame or tab-switch doesn't make physics explode — this matters, an unclamped dt after a 2-second tab switch teleports every particle off-screen), (3) calls `draw` on the visible canvas, (4) composites onto the hidden recording canvas. The `ramp` argument is a 0→1 envelope owned by the session state machine (§4): forces, spawn rates and ink emission are multiplied by it, so the effect *blooms in* over ~600ms when the session goes live instead of popping into existence — and ramps back toward an idle level when hands are lost. Fast-moving DOM elements (HUD counters etc.) update via direct `element.style`/`textContent`, your existing pattern.

**Shared smoothing.** Raw MediaPipe landmarks jitter at the sub-pixel-to-few-pixel level even on a still hand. Every fingertip/palm signal passes through an exponential moving average before any effect sees it:

```
smoothed = smoothed + α · (raw − smoothed)     // α ≈ 0.35 for positions
```

α = 0.35 at 60fps means ~90% convergence in ~6 frames (100ms) — responsive enough to feel instant, slow enough to kill jitter. Velocity signals use α ≈ 0.5 (they need to feel snappy). Binary signals (pinch) use **hysteresis** instead — explained in §3.1.

**Shared coordinate handling.** MediaPipe returns normalized [0,1] coords in *camera space*. The webcam is mirrored for UX (you expect your right hand on the right of screen), so every x becomes `(1 − x) · canvasWidth`, y becomes `y · canvasHeight`. Do this once, in the derived-signals layer, so no effect code ever thinks about mirroring.

**Shared loss behavior.** Every effect implements a `gracefulRelease(handIndex)` callback, invoked by the state machine when a hand transitions to LOST (§4.4) — never by the effect polling raw presence itself. What each effect does in it is specified per effect below. This keeps "what happens when tracking hiccups" a first-class, designed behavior rather than an accident.

---

### 3.1 Effect 1 — GLITCH TILES (the reference effect, the hardest, the flagship)

**The wow.** The live webcam image is the effect's raw material: the frame is sliced into a grid of ~300 video tiles. Your index fingertip warps the grid — tiles within reach get pulled toward (or flung away from, or swirled around) your finger, dragging *pieces of your own face and room* with them. Pinch your thumb and index together and you *grab* a fistful of tiles; drag them across the screen; release and they spring home with a satisfying elastic snap. It reads as "I am physically tearing the video apart with my hands."

**Driving keypoints.**
- Index fingertip (landmark 8) of each hand → the force source / grab cursor.
- Pinch distance: `dist(landmark 4, landmark 8)` (thumb tip ↔ index tip), **normalized by hand scale** = `dist(landmark 0, landmark 9)` (wrist ↔ middle-finger MCP). Normalization is essential: raw pinch distance shrinks as the hand moves away from the camera, so an unnormalized threshold would mean "pinch works only at one distance from the lens." Normalized pinch is depth-invariant — same idea as your torso-length normalization in `evaluators.ts`, transplanted to hands.
- Fingertip velocity (frame-to-frame delta of the smoothed position) → tiles get an extra "fling" impulse from fast-moving fingers, which makes swipes feel powerful.

**Tile state.** Each tile is a struct in pre-allocated typed arrays (no per-frame allocation, no GC hitches):

```
homeX, homeY     // grid cell center — where it belongs
x, y             // current position
vx, vy           // velocity
held             // -1, or index of the hand currently grabbing it
srcX, srcY, srcW, srcH   // its fixed slice of the source video (precomputed once)
```

Grid density scales with intensity: 1 → 18×11 (~200 tiles), 2 → 24×14 (~340), 3 → 30×17 (~510). `tileShape` changes cell aspect ratio (`wide` = 2:1 cells, `shard` = square cells + small fixed random rotation per tile for a shattered look).

**Per-frame physics (semi-implicit Euler, per tile):**

```
// 1. Spring toward home (always active unless held)
fx = (homeX − x) · k_home          // k_home ≈ 90 for "spring", ≈ 25 for "drift"
fy = (homeY − y) · k_home

// 2. Finger force, per tracked fingertip (scaled by ramp from the state machine)
dx = fingerX − x;  dy = fingerY − y
d  = sqrt(dx² + dy²)
if d < R:                           // R = influence radius ≈ 22% of canvas width
    falloff = (1 − d/R)²            // smooth quadratic falloff, zero at the rim
    if attract:  fx += (dx/d) · F · falloff · ramp
    if repel:    fx −= (dx/d) · F · falloff · ramp
    if vortex:   // rotate the direction 90°: push tangentially + slight inward pull
                 fx += (−dy/d · 0.85 + dx/d · 0.25) · F · falloff · ramp
    // plus fling: inherit a fraction of finger velocity
    fx += fingerVX · 0.6 · falloff · ramp

// 3. Integrate with damping
vx = (vx + fx · dt) · damping       // damping ≈ 0.88 per frame
x  = x + vx · dt
```

Why quadratic falloff rather than inverse-square: inverse-square forces blow up near d = 0 (a tile that drifts onto the fingertip gets infinite force and rockets off-screen); `(1 − d/R)²` is bounded, zero at the edge of influence (no visible "cliff" where the effect stops), and strongest at the center. It's the difference between physics that's *correct* and physics that *feels good* — for an effect, feel wins.

**Pinch-to-grab with hysteresis.** Pinch is a binary state derived from a continuous noisy signal, so a single threshold would flicker grab/release several times per second right at the boundary. Two thresholds fix it:

```
if !pinching and normalizedPinch < 0.28  → pinching = true   // enter
if  pinching and normalizedPinch > 0.40  → pinching = false  // exit
```

On pinch-enter: all free tiles within a grab radius (≈ 12% of canvas width) of the fingertip set `held = handIndex` and record their offset from the fingertip. While held: tiles ignore physics and lerp toward `fingertip + offset` with factor 0.4/frame — the slight lag makes the cluster feel like it has mass. On pinch-exit: `held = −1`, and tiles inherit the finger's current velocity as their `vx,vy` — so you can pinch, *throw*, and watch a chunk of video fly and spring back. That throw is the moment people gasp.

**Loss behavior (`gracefulRelease`).** Because the COASTING window (§4.4) preserves `pinching` through brief occlusion, a grab survives a one-frame dropout untouched. If the hand is truly LOST while grabbing, held tiles release with **zero inherited velocity** — they spring home gently rather than being flung by a phantom velocity spike (the last frames before tracking loss are usually garbage, so inheriting them would hurl tiles off-screen and look exactly like a bug). With no hands present, all tiles spring home and the frame quietly reassembles into ordinary video — the effect's idle state is literally "your webcam, intact," which is the most legible possible resting screen.

**Drawing at 60fps.** One visible canvas, full opaque draw (no separate video element underneath — the tiles *are* the video):

```
for each tile:
    ctx.drawImage(video, srcX, srcY, srcW, srcH,   // fixed source slice
                  x − w/2, y − h/2, w, h)          // current position
```

~500 `drawImage` calls per frame from a video source is comfortably within budget on any GPU-accelerated 2D canvas (browsers batch these well). Displaced tiles naturally reveal black gaps where they used to be — that's the glitch aesthetic, free. For `shard` shape add `ctx.save/translate/rotate/restore` only for tiles whose displacement exceeds a few pixels (rotating tiles sitting at home is wasted work and visually invisible). Palette applies as a thin pass: a low-alpha `fillRect` tint over the whole canvas plus colored 1px tile borders on displaced tiles only.

**Recording composite.** Glitch Tiles is the special case: the effect canvas already *contains* the video (as slices), so the hidden recording canvas does **not** draw the raw video first — it draws the effect canvas, then the HUD/prompt watermark on top. (The other two effects composite video → effect → HUD; see §3.2.) This per-effect difference is one boolean in the engine: `effectIncludesVideo`.

---

### 3.2 Effect 2 — PARTICLE NEBULA (sculpting light)

**The wow.** Two to four thousand glowing particles drift in space. Close your hand into a loose fist and they rush inward, condensing into a tight, brilliant star orbiting your palm. Open your fingers and the star detonates outward in a shockwave. Move your hand and the swarm follows like iron filings chasing a magnet, with comet trails. With two hands you hold two galaxies and pour particles between them. It's the "I have powers" effect.

**Driving keypoints.**
- Palm center: average of landmarks 0, 5, 9, 13, 17 (wrist + the four finger MCP knuckles) — far more stable than any single landmark, because averaging five points cancels per-point jitter.
- Hand openness: mean distance of the 5 fingertips (4, 8, 12, 16, 20) from palm center, normalized by hand scale, then remapped to [0, 1] (≈0.4 = fist → 0, ≈1.1 = splayed → 1). This is the *throttle*: it continuously interpolates between maximum attraction (fist) and zero/negative attraction (open).
- Palm velocity → swarm inherits momentum, so flinging your hand slingshots particles.

**Per-particle physics.** Fixed pool (count: 1500 / 2800 / 4500 by intensity) in typed arrays `x, y, vx, vy, life, hue`. No allocation after init; "dead" particles respawn in place.

```
for each hand:
    dx = palmX − px;  dy = palmY − py
    d² = dx² + dy² + ε                  // ε ≈ 400 prevents the divide-by-zero singularity
    d  = sqrt(d²)

    // radial: openness 0 (fist) → strong pull; openness 1 (open) → push or nothing
    radial = G · (0.5 − openness) · 2 · ramp   // signed: + attract, − repel
    fx += (dx/d) · radial / (d² · invScale)    // clamped: |f| ≤ fMax

    // tangential (the orbit): force perpendicular to the radial direction
    if motion == "orbit":
        fx += (−dy/d) · swirl · ramp / (d · invScale)
    if motion == "swarm":
        fx += curlNoise(px, py, t).x · noiseAmt   // cheap pseudo-curl: two sin/cos octaves

vx = (vx + fx·dt) · 0.94                 // damping — the swarm's "viscosity"
px += vx·dt
```

The two key tricks: (1) **the tangential component is what creates orbits** — pure attraction makes particles fall straight into the palm and jitter there; adding a perpendicular force gives them angular momentum, so they spiral and circle instead, which is the entire visual difference between "dots stuck to my hand" and "a galaxy around my hand." (2) **`explode` mode** adds a one-frame impulse when openness crosses 0.7 upward (with the same hysteresis pattern as pinch): every particle within a radius gets `v += (dir from palm) · burst` — a detonation, then damping reins it back in. `release` mode just sets G→0 so the cloud drifts free.

**Loss behavior (`gracefulRelease`).** On hand LOST, that hand's G doesn't cut to zero — it decays to zero over ~300ms (multiply by 0.85/frame). An instant cutoff makes the orbiting swarm visibly "let go" with a jolt at the exact moment of a tracking miss, which advertises the failure; the decay reads as the energy naturally dissipating. With no hands, the ambient `curlNoise` term keeps the field drifting slowly — the idle screen is a living, attractive nebula, never a frozen scatter of dots.

**Drawing at 60fps.** This is the perf-critical effect, so the draw is engineered:
- Pre-render **one glow sprite** at init: a 32×32 offscreen canvas with a radial gradient (white core → palette color → transparent). Per frame, each particle is a single `ctx.drawImage(sprite, x, y, size, size)` — drawImage of a small canvas is far cheaper than `ctx.arc()+fill()` per particle (no path rasterization), and it's the standard trick that makes 4k particles trivial.
- `ctx.globalCompositeOperation = "lighter"` (additive blending): overlapping particles sum brightness, so dense regions bloom into hot white cores for free — that's where the "nebula" look comes from, zero extra cost.
- Trails: instead of clearing the canvas, fill it with `rgba(0,0,0, trailAlpha)` each frame (trailAlpha ≈ 0.25 for `short`, 0.08 for `long`). Old frames fade rather than vanish → motion blur for the price of one fillRect. The effect canvas is composited onto the video with `"screen"` blend mode, which treats black as transparent — one line, looks gorgeous.

**Recording composite.** Hidden canvas: mirrored video → effect canvas with `"screen"` blend → HUD watermark. `effectIncludesVideo = false`.

---

### 3.3 Effect 3 — LIGHT RIBBONS (air calligraphy)

**The wow.** Your index fingertip trails a flowing ribbon of light — not a dumb line, but a ribbon with *physics*: it lags behind your finger, whips around corners, tapers with speed, and slowly dissolves. Pinch to lift the pen, release to write. `lightning` brush draws crackling jittered bolts; `smoke` draws soft wide wisps that curl upward. Two hands = two-color calligraphy. It's the simplest effect and the one people use longest, because it's *expressive* — people write their names.

**Driving keypoints.** Index fingertip (8) per hand; pinch (same normalized + hysteresis machinery as Glitch Tiles — build it once in the signals layer, use it everywhere); fingertip speed.

**The chain — follow-the-leader.** Each hand owns a chain of N = 28 nodes. Node 0 chases the fingertip; every other node chases the one before it:

```
node[0] += (fingertip − node[0]) · 0.45
for i in 1..N−1:
    node[i] += (node[i−1] − node[i]) · 0.45
```

That's the entire simulation — and it's the right one. Each lerp is a low-pass filter, so the chain is 28 cascaded smoothing filters: jitter is annihilated, and sharp finger turns propagate down the chain as a *whip*, arriving later at the tail. This is why the ribbon feels alive and silky instead of looking like `ctx.lineTo` (which faithfully reproduces every pixel of hand tremor). It's the cheapest possible physics with the most organic possible output — that asymmetry is the thing to defend.

**Width and rendering.** Width tapers along the chain (head ≈ 18px → tail ≈ 1px, scaled by intensity) and modulates with speed: `w · clamp(1.6 − speed·k, 0.4, 1.6)` — fast strokes go thin and bright like real ink, slow strokes go fat and soft. Rendering builds a **ribbon polygon**, not a stroked line: for each segment compute the perpendicular unit vector, offset both sides by `width[i]/2`, collect left-edge points forward and right-edge points backward, fill the closed path with a head→tail gradient (palette primary → secondary), composite `"lighter"`. Brush variants are pure render-time changes on the same chain: `lightning` strokes 2–3 thin polylines with per-node random perpendicular jitter re-rolled each frame (the re-rolling is what makes it crackle) plus a wide low-alpha glow pass; `smoke` draws overlapping soft radial-gradient blobs along the chain with a slow upward drift added to node positions.

**Persistence — the two-canvas trick.** The live chain alone vanishes when you stop moving. Persistence comes from an offscreen **trail canvas**:

1. Each frame, first dim the trail canvas: for `fading`, `globalCompositeOperation = "destination-out"` + fill `rgba(0,0,0,0.045)` (uniformly reduces existing alpha ~4.5%/frame → strokes dissolve over ~2s); for `lasting`, 0.008 (→ ~20s).
2. Stamp only the chain's *head segment* (nodes 0–3) onto the trail canvas — the head is the "pen" depositing ink; the rest of the live chain is drawn fresh each frame on the main effect canvas as the bright "wet" part of the stroke.
3. Composite: video → trail canvas → live chains → HUD.

Cost is two fills and a few drawImages — persistence is nearly free, and `destination-out` fading (unlike black-fill fading) keeps the trail canvas genuinely transparent, so it layers over video correctly.

Pinch as `penDown`: pinch-enter starts depositing and snaps the whole chain to the fingertip (so the ribbon doesn't whip across the screen from its last position — that snap-on-pen-down is a small detail that prevents the most common visual glitch in trail effects); pinch-exit stops depositing while the live chain drains out. As `widthControl`: pinch distance maps linearly to base width, always-on ink.

**Loss behavior (`gracefulRelease`).** Hand LOST = pen up, exactly as if the user un-pinched: deposition stops, the live chain drains gracefully into the trail canvas, nothing snaps. Crucially, the COASTING freeze (§4.4) means a one-frame dropout mid-stroke leaves the pen *resting in place* instead of stamping a streak to wherever a garbage landmark landed. With no hands, existing ink keeps fading on its own schedule — the idle screen is the user's slowly dissolving drawing, which is genuinely beautiful.

---

## 4. The session state machine — failure states, empty states, first run

This is the section that makes the difference between "great demo" and "never looks broken." The person evaluating this opens it cold, in imperfect lighting, with no instructions. The design principle: **at every moment, the screen tells the user exactly one thing to do, and no tracking failure is ever visible as a failure.**

The engine owns a small explicit state machine:

```
boot → permissionPrompt → (permissionDenied | noCamera | initializing)
initializing → awaitingHands → live ⇄ idle → ended
```

Transitions are rare (seconds apart, not per-frame), so — unlike landmarks — session state IS allowed to live in React state: overlays are ordinary DOM components with CSS transitions, costing the hot loop nothing. Per-hand tracking sub-states (TRACKING / COASTING / LOST) live in the signals layer (§5) and never touch React.

### 4.1 Camera permission — the request moment

Do **not** call `getUserMedia` on page load. A cold permission popup with zero context is the highest-denial-rate pattern in the browser; and on Chrome, a dismissed prompt starts counting toward permanent auto-block. Instead, `/play` decodes the config and shows a **pre-permission screen**: the user's prompt rendered big and styled in the effect's palette ("⚡ *neon lightning storm* — ready"), one line of trust copy ("your camera feed never leaves this device — all tracking runs in your browser"), and a single button: **"Enable camera to begin."** The click calls `getUserMedia` — a user-initiated request with visible context, which converts dramatically better.

Two things happen *behind* that screen, in parallel, while the user reads: the MediaPipe WASM + hand model start downloading, and the effect module pre-`init`s. By the time permission is granted, tracking is warm — the pre-permission screen converts dead loading time into onboarding time.

**Granted:** transition to `initializing`. The mirrored video must appear within ~1s of grant (paint the raw `<video>` immediately; people instinctively check their hair — instant video is instant feedback that everything works). If the model is still warming, a subtle shimmer caption: "warming up hand tracking…" over live video — never over black.

**Denied** (`NotAllowedError`): a friendly full-screen card, not an error. Camera icon, "Camera access is blocked — this experience is your camera." Recovery instructions matched to the actual recovery path: *click the 🔒/camera icon in the address bar → allow camera → tap retry*, with a **"Try again"** button that simply re-calls `getUserMedia` (it succeeds if the user flipped the setting, no reload needed; if the browser requires reload, catch the repeat failure and swap the button to "Reload page"). Plus the same on-device trust line — the most common *reason* for denial is the fear this screen should disarm.

**No camera** (`NotFoundError` — desktops, some VMs): distinct copy ("no camera found on this device") and a link back home. Don't show camera-permission recovery steps for hardware that doesn't exist.

### 4.2 The first 10 seconds (`awaitingHands` — the onboarding gate)

The effect does **not** start the instant tracking starts. A designed beat:

- **t = 0.0s** — mirrored live video appears, lightly dimmed (≈ 25% black) so overlay text reads clearly.
- **t ≈ 0.3s** — a title card slides up from the bottom third: the user's prompt in the palette's colors. This is the product's thesis on screen: *you typed this; it's about to be real.*
- **t ≈ 1.0s** — the invitation fades in, centered: **"✋ Show me your hands"** — large, friendly, with a slow float/pulse (a 2s CSS keyframe animation on a DOM element: zero canvas cost, zero JS). Beneath it, one quiet line from `EFFECT_META.gestureHint` ("pinch to draw in the air").
- **The gate:** the session goes live only after a hand is present with detection confidence above threshold for **500ms continuously** (~15 detection frames). The debounce matters: a single-frame false positive (a face edge, a lamp) would otherwise start the show at a wall. When the gate opens: the invitation dissolves (300ms CSS fade), the **ramp envelope eases 0 → 1 over ~600ms** so the effect *blooms* around the user's hand rather than popping on, the gesture hint stays for 4 more seconds then fades, and the recording indicator appears. The choreography makes the hand-raise feel like *the user* ignited the effect — which is the whole fantasy.

A first-timer's complete mental model is built in three lines they were shown at the right moments: what this is (their prompt), what to do (show hands), how to play (the gesture hint). Nothing else is needed.

### 4.3 No hands during the session (`live ⇄ idle`)

If **both** hands are LOST for > 2.5s mid-session, transition to `idle`: the "✋ show me your hands" hint fades back in at reduced opacity, and the effect plays its `idleBehavior` from the metadata table — particles drift on ambient noise, tiles settle home into clean video, ink keeps dissolving. The screen is never dead, never frozen, and always re-states the one thing to do. On re-detection, return to `live` **instantly** — no gate, no debounce (the gate is a first-run ceremony; mid-session, responsiveness wins), just the ramp easing back up over ~300ms.

### 4.4 Hand lost mid-interaction — the coasting window

Per-hand, in the signals layer, three sub-states:

```
TRACKING  — fresh landmarks this frame; normal operation
COASTING  — no detection for ≤ 12 frames (~200ms): signals are FROZEN at their
            last smoothed values; `pinching` and grabs are PRESERVED
LOST      — dropout exceeded the window: fire gracefulRelease(hand), clear state
```

The reasoning: MediaPipe drops single frames *constantly* — motion blur on a fast swipe, a finger crossing the other hand, a half-rotation. If presence were binary, every one-frame miss would release your grab, lift your pen, scatter your swarm: the experience would feel haunted. Freezing for 200ms is invisible (the EMA was already adding ~100ms of inertia) and bridges virtually all real dropouts. Freezing — not extrapolating — is the right call for position: the last frames before a loss are often garbage, and extrapolating garbage velocity shoots the cursor across the screen. When LOST does fire, each effect's `gracefulRelease` (§3) turns the failure into a designed, gentle exit. Recovery from LOST re-enters through nearest-slot matching (§5) and resets that slot's smoothing state so the cursor doesn't lerp visibly across the screen from its stale position.

### 4.5 Poor conditions — the quality monitor

An orthogonal, low-key hint channel — a single small DOM toast, bottom-center. Hard rules so it never nags: **one hint at a time; a condition must persist 2s before its hint shows; the same hint never repeats within 30s; no hints during `awaitingHands`** (the invitation is already on screen).

- **Hand too far:** `scale` (wrist→middle-MCP, px) < ~6% of frame height, sustained → "come a little closer ✋". Small hands mean low-precision landmarks; pinch detection degrades first.
- **Hand too close / clipped:** `scale` > ~35% of frame height, or ≥ 4 landmarks within 2% of the frame edge → "step back a bit". Clipped hands produce the wildest garbage landmarks.
- **Low light:** once per second, draw the video into a 32×18 offscreen canvas and average the luma from `getImageData` (576 pixels at 1Hz — cost is unmeasurable). Below threshold for 3 consecutive samples → "a bit more light helps ✨". Low light is the #1 real-world tracking killer and users never self-diagnose it.
- **Choppy detection** (rate < ~20Hz sustained): no toast — this one isn't the user's fault, so don't make it their problem. It feeds adaptive quality instead (§6).

All toasts are DOM + CSS; the quality monitor runs at 1Hz on data the signals layer already computes. Cost: ~zero. Effect on perceived robustness: enormous — the system visibly *understands its own conditions*, which reads as intelligence.

---

## 5. Hand-tracking hook: usePoseDetection → useHandTracking

The hook's architecture survives intact — same lazy WASM load, same GPU delegate, same rAF loop writing to a ref. Five concrete changes:

**1. Model swap.** `PoseLandmarker` → `HandLandmarker` from the same `@mediapipe/tasks-vision` package:

```ts
HandLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: "GPU" },
  runningMode: "VIDEO",
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});
```

Same `detectForVideo(video, timestampMs)` call pattern in the loop. Per §4.1, model loading is kicked off from the pre-permission screen so it overlaps with the permission decision.

**2. Result shape.** Pose gave one person × 33 landmarks. Hands gives `result.landmarks` (array of 0–2 hands × 21 landmarks) **plus** `result.handedness` ("Left"/"Right" with confidence). Critical gotcha: **array order is not stable** — hand 0 this frame may be hand 1 next frame. If you key smoothing state on array index, your EMAs and pinch hysteresis flip between physical hands and everything glitches. Fix: maintain two persistent slots keyed by handedness label, falling back to nearest-palm-position matching when both hands report the same label (happens briefly during occlusion). Each slot owns its smoothing state and its TRACKING/COASTING/LOST sub-state from §4.4.

**3. The derived-signals layer (new, the important addition).** Don't hand effects raw landmarks. The hook computes, once per frame, per hand slot, a `HandSignals` object — and this is where *all* smoothing, mirroring, pixel-space conversion, and dropout handling happens, exactly once:

```ts
interface HandSignals {
  track: "tracking" | "coasting" | "lost";  // §4.4 sub-state
  confidence: number;        // model's handedness/detection confidence, EMA'd
  framesSinceSeen: number;   // 0 when fresh; drives coasting → lost
  palm: {x, y};              // avg(0,5,9,13,17), EMA'd, mirrored, pixels
  indexTip: {x, y};          // landmark 8, EMA'd
  indexVel: {x, y};          // per-second velocity of smoothed tip, EMA'd
  pinch: number;             // dist(4,8)/dist(0,9) — normalized, depth-invariant
  pinching: boolean;         // hysteresis state (0.28 enter / 0.40 exit)
  pinchJustStarted: boolean; pinchJustEnded: boolean;  // edge events for grab/throw
  openness: number;          // 0 fist … 1 splayed
  scale: number;             // dist(0,9) in px — hand size proxy; feeds §4.5 hints
  edgeClipped: boolean;      // ≥4 landmarks hugging the frame edge; feeds §4.5
}
```

Effects become pure consumers of clean signals; the state machine (§4) and quality monitor (§4.5) consume the same object. This mirrors what `evaluators.ts` did for poses (raw landmarks → normalized 0–1 score), generalized into a reusable layer.

**4. Storage stays a ref.** `signalsRef.current = { hands: [slot0, slot1], detectionHz, t }` — same no-re-render discipline as before. React state only changes on the rare session-state transitions of §4.

**5. Performance note.** Hand model is lighter than full pose; two-hand tracking runs 30–60fps on the GPU delegate on mid-range laptops. Detection can run slower than render: the engine's 60fps draw loop just reads the latest signals — interpolation via the EMAs covers the gap, so a 30fps detector still yields buttery 60fps visuals. The actual detection rate is measured and displayed by §6.

---

## 6. Performance instrumentation — prove it, don't claim it

A toggleable debug overlay (`?debug=1` in the URL, or the `d` key / a triple-tap on mobile) showing live: **render FPS · detection Hz · active particles/tiles · hands tracked · dropped frames**. Its purpose is rhetorical as much as technical: during a demo you flip it on and the 60 sits there in the corner while you tear the video apart with both hands. The claim becomes a measurement.

**How it's built without perturbing what it measures.** Two halves:

- *Collection* happens in the hot loops, but is only arithmetic on a plain object in a ref: the rAF loop increments a frame counter and folds frame time into an EMA (`ft += 0.05·(dt − ft)`), counts frames over 25ms as "dropped"; the detection loop increments a detection counter; effects write their active-entity count (an integer they already know). Cost per frame: a handful of additions — unmeasurable.
- *Display* is a fixed-position DOM `<div>` of `<span>`s, updated by a `setInterval` at **4Hz** via direct `textContent` writes. Not every frame (60Hz DOM text mutation causes layout/paint work that would show up in the very numbers being displayed — a literal observer effect), and not React state (no reason to reconcile a component tree for a counter). 4Hz is fast enough to read as "live," slow enough to cost nothing. The div has `pointer-events: none` and a fixed width (monospace font) so updates never cause reflow of anything else.

**The overlay's second job: adaptive quality.** The same EMA frame time drives a degradation rule: if frame time stays above 20ms for 60 consecutive frames, step the effect's internal quality tier down one notch (particle pool −30%; tile grid one density step coarser; ribbon glow passes reduced) — and **never step back up within the session**. One-way stepping avoids the classic oscillation failure (quality up → frame drops → quality down → headroom → quality up …) that looks like pulsing stutter. Similarly, sustained detection Hz < 20 (from §4.5) triggers the same step-down. This turns the instrumentation from a demo prop into the robustness mechanism that keeps weak laptops smooth — and the overlay lets you *watch* it work.

---

## 7. The AI compile route: system prompt design (the "taste" layer)

`/api/generate` keeps its exact shape: POST prompt → Azure OpenAI, temperature 0.2, `response_format: json_object` → zod-validate → on failure, **one retry with the validation error appended to the conversation** → on second failure, return a sensible default config (never a 500 — the user should always land in *an* effect).

The router stays maximally constrained — 3 effects, enums only, JSON only. What gets richer is the *judgment* inside the choice. For this product the prompt IS the interface, and the magic moment is when an abstract prompt ("make me feel like a god") comes back as a choice that feels *understood*, not just valid. That judgment is encoded two ways: explicit mapping heuristics, and a wider few-shot set that demonstrates taste on abstract, emotional, and ambiguous prompts. New system prompt:

```
You are an effect compiler with taste. You convert a user's prompt into a
JSON config for a hand-controlled webcam visual effect. You may ONLY choose
from the menu below. You NEVER invent fields, effect names, or values.
Think silently; output ONLY a single JSON object — no markdown, no commentary.

EFFECTS:
- "glitch_tiles": the webcam image shatters into tiles the user's fingers
  pull, fling and grab. The user's own image is the material being broken.
  params: tileShape: "square"|"wide"|"shard";
          pullMode: "attract"|"repel"|"vortex";
          snapBack: "spring"|"drift"
- "particle_nebula": thousands of glowing particles orbit and chase the
  user's hands; a fist condenses them, an open hand releases or explodes
  them. The user commands a field of energy.
  params: motion: "orbit"|"stream"|"swarm";
          openHandAction: "explode"|"release";
          trail: "short"|"long"
- "light_ribbons": fingertips paint flowing ribbons of light in the air.
  The user leaves an expressive mark.
  params: brush: "ribbon"|"lightning"|"smoke";
          persistence: "fading"|"lasting";
          pinchAction: "penDown"|"widthControl"

HOW TO CHOOSE THE EFFECT — find the prompt's physical metaphor:
- Does it want to BREAK, DISTORT, FRAGMENT or DESTABILIZE the image
  (glitch, shatter, matrix, anxiety, falling apart, hacking, mirrors)?
  → glitch_tiles. Note: psychological instability maps here too — "anxiety"
  is an image that won't hold still (pullMode "repel").
- Does it want to HOLD, COMMAND or EMANATE power/energy/matter
  (magic, fire, stars, telekinesis, aura, gravity, feeling powerful)?
  → particle_nebula.
- Does it want to LEAVE A MARK, write, express or remember
  (drawing, neon signs, signatures, memory, longing, messages)?
  → light_ribbons.
For abstract or emotional prompts, first translate the feeling into one of
those three verbs (break / command / mark), then choose.

PALETTE — choose from MOOD and imagery, not just literal color words:
"neon" cyan/magenta — electric, cyber, nightlife, synthetic
"ember" orange/red — fire, heat, power, anger, sunset, heartbeat
"vapor" pink/purple — dreams, nostalgia, softness, retro, romance
"mono" white/grey — elegance, minimalism, ghosts, memory, solemnity
"acid" green/yellow — toxic, digital, hacking, unease, alien
"ocean" blue/teal — water, night, calm, depth, melancholy
Default "neon" only if the prompt gives no mood at all.

INTENSITY — read the EMOTIONAL ENERGY, not keywords:
3 = overwhelming, destructive, ecstatic, furious ("chaos", "god", "storm")
2 = active, alive, engaged (the default)
1 = serene, fragile, melancholic, minimal ("zen", "whisper", "i miss her")
A prompt can be dark AND quiet — grief is intensity 1, rage is intensity 3.

RULES:
1. Output schema exactly: { "v":1, "effect", "palette", "intensity",
   "prompt": <the user's prompt verbatim>, "params": {...} }
2. params must contain exactly the keys for the chosen effect.
3. If genuinely ambiguous: particle_nebula, intensity 2.
4. Never refuse, never apologize, never explain. Anything outside the menu
   maps to the closest physical metaphor.

EXAMPLES (thinking shown for guidance — your output is the JSON only):

"let me bend fire"
thinking: command energy → nebula; fire → ember; active → 2; chaotic flames → swarm.
{"v":1,"effect":"particle_nebula","palette":"ember","intensity":2,
"prompt":"let me bend fire","params":{"motion":"swarm","openHandAction":"explode","trail":"long"}}

"write my name in neon"
thinking: leave a mark → ribbons; literal neon; signature should stay → lasting.
{"v":1,"effect":"light_ribbons","palette":"neon","intensity":2,
"prompt":"write my name in neon","params":{"brush":"ribbon","persistence":"lasting","pinchAction":"penDown"}}

"shatter reality like the matrix"
thinking: break the image → glitch; digital green → acid; destructive → 3.
{"v":1,"effect":"glitch_tiles","palette":"acid","intensity":3,
"prompt":"shatter reality like the matrix","params":{"tileShape":"shard","pullMode":"vortex","snapBack":"spring"}}

"make me feel like a god"
thinking: hold power → nebula; divinity = radiant heat → ember; ecstatic → 3;
worlds orbit a god → orbit; an open divine hand detonates → explode.
{"v":1,"effect":"particle_nebula","palette":"ember","intensity":3,
"prompt":"make me feel like a god","params":{"motion":"orbit","openHandAction":"explode","trail":"long"}}

"ocean at night"
thinking: depth and calm → command a drifting field → nebula; ocean palette;
serene → 1; currents → stream; nothing explodes at night → release.
{"v":1,"effect":"particle_nebula","palette":"ocean","intensity":1,
"prompt":"ocean at night","params":{"motion":"stream","openHandAction":"release","trail":"long"}}

"calm before a storm"
thinking: the point is restrained tension, not the storm → intensity 1;
held energy → nebula; heavy sky → ocean; uneasy motion → swarm; the storm
waiting inside the calm → explode on open hand.
{"v":1,"effect":"particle_nebula","palette":"ocean","intensity":1,
"prompt":"calm before a storm","params":{"motion":"swarm","openHandAction":"explode","trail":"short"}}

"chaos"
thinking: destabilize everything, including the user's own image → glitch;
maximal → 3; unnatural → acid; swirling disorder → vortex; never settles → drift.
{"v":1,"effect":"glitch_tiles","palette":"acid","intensity":3,
"prompt":"chaos","params":{"tileShape":"shard","pullMode":"vortex","snapBack":"drift"}}

"my heartbeat"
thinking: a pulsing thing I hold → nebula; blood-warm → ember; alive but
intimate → 2; particles circle like circulation → orbit; the beat = the
open-hand burst → explode; short trails read as pulses, not smears.
{"v":1,"effect":"particle_nebula","palette":"ember","intensity":2,
"prompt":"my heartbeat","params":{"motion":"orbit","openHandAction":"explode","trail":"short"}}

"i miss her"
thinking: longing leaves a trace → ribbons; grief is quiet → 1; faded and
soft → mono; smoke, not neon; the trace should dissolve — that IS the feeling.
{"v":1,"effect":"light_ribbons","palette":"mono","intensity":1,
"prompt":"i miss her","params":{"brush":"smoke","persistence":"fading","pinchAction":"penDown"}}

"anxiety"
thinking: the self-image that won't hold still → glitch; tiles flee the
touch → repel; queasy → acid; agitated but not apocalyptic → 2; never quite
settles → drift.
{"v":1,"effect":"glitch_tiles","palette":"acid","intensity":2,
"prompt":"anxiety","params":{"tileShape":"square","pullMode":"repel","snapBack":"drift"}}
```

**Why this works and stays cheap.** The heuristics give the model a *procedure* for abstract prompts (feeling → verb → effect; mood → palette; energy → intensity), and the nine examples demonstrate the procedure's taste across the hard cases — emotional ("i miss her"), abstract ("chaos"), tension-laden ("calm before a storm"), embodied ("my heartbeat"). At temperature 0.2 the model imitates demonstrated reasoning patterns closely, so nine well-chosen examples buy more judgment than any amount of additional rules. Note what *didn't* change: still 3 effects, still enums, still one zod schema, still one model call — the constraint surface is identical, so validation, caching (§9) and the fallback path are untouched. The richness lives entirely inside the choice, which is exactly where it belongs. The "thinking shown for guidance" lines are the one subtlety: they teach the mapping logic without ever appearing in output, because `response_format: json_object` structurally forbids anything but the JSON.

---

## 8. Build order (always have something working — unhappy paths built early)

1. **Tracking first, alone.** Fork `usePoseDetection` → `useHandTracking`. Page with webcam + 21 colored dots per hand drawn on an overlay canvas. Verify: 2 hands, stable handedness slots, fps counter. *Nothing else exists yet.*
2. **Derived-signals layer + signal debug HUD.** Add `HandSignals` including `track`/`confidence`/`scale`/`edgeClipped`, render pinch value, pinching boolean, openness, velocity as on-screen text. Tune EMA alphas, hysteresis thresholds, and the COASTING window length *here*, with numbers visible — tuning smoothing inside a finished effect is miserable; tuning it against a debug readout takes minutes.
3. **Engine shell + performance overlay, together.** `EffectEngine.tsx` with the rAF loop, dt clamping, a hardcoded config, a trivial "effect" (circle following indexTip) — and the §6 overlay (collection in refs, 4Hz DOM display). Building the instrument before the effects means every effect from here on is developed *while watching its own frame time*, and perf regressions are caught the frame they're introduced.
4. **Session state machine v1.** Permission flow (pre-permission screen with parallel model preload, granted/denied/no-camera states), `initializing`, the `awaitingHands` gate with the 500ms debounce and ramp envelope, `live ⇄ idle`, and COASTING→LOST wiring with a stub `gracefulRelease`. All of it exercised against the trivial dot effect. **This is deliberately before any real effect**: the states are interaction code against the signals layer, not against effect internals — and building effects *inside* the finished state shell means hand-loss behavior, the ramp, and idle modes are designed into each effect from its first day, not bolted on. The toast channel from §4.5 is built here too, with placeholder thresholds.
5. **Light Ribbons** (simplest effect — one chain, no pools, no video sampling), including its `gracefulRelease` (pen-up) and idle behavior. First real wow; first end-to-end feel test of signals + states together.
6. **Particle Nebula** (pools, forces, additive blending, sprite trick), including G-decay on loss and ambient idle drift.
7. **Glitch Tiles** (hardest: video slicing, grab state machine, throw impulses), including zero-impulse grab release on loss. By now the signals layer and state machine are battle-tested, so all difficulty is local to the effect.
8. **Schema + URL.** Write `schema.ts` + `EFFECT_META`, zod validators, wire `encode/decodeGameConfig` (reused), make `/play?config=` drive the engine. Test with hand-written configs.
9. **AI route.** Adapt `/api/generate` with the §7 system prompt + validation + retry + fallback. Smoke-test the taste layer with the nine example prompts *plus* ten fresh abstract ones; misfires get fixed by editing heuristics/examples, never by adding effects. The full pipeline now works: type → effect.
10. **Recording.** Wire the hidden composite canvas per effect (the `effectIncludesVideo` flag), reuse `useClipRecorder` unchanged, add the prompt watermark. End screen: download / share link / again — reused.
11. **Quality-monitor tuning + adaptive quality.** The mechanisms exist since steps 3–4; now tune the real thresholds (scale cutoffs, luma threshold, the 20ms degradation trigger) against the three finished effects on a deliberately bad setup — dim room, mid-range laptop, hand at arm's length. Tuned late because the thresholds only mean something against real workloads; *built* early because they're required, not optional.
12. **Polish pass.** Intensity scaling tables, palettes, choreography timing of the first 10 seconds, perf audit (overlay on, check for GC sawteeth in the memory timeline — any sawtooth means an allocation in the hot loop to hunt down).

Every step ends with a demoable artifact; steps 5–7 each end with a shippable single effect that already survives bad lighting, lost hands, and a cold first-time user.

---

## 9. How I'd scale this to production (note)

The expensive-looking part — real-time hand tracking and rendering — costs me nothing at scale, because it all runs on-device in the user's browser; a million concurrent users consume zero of my compute. The only per-use cost is the LLM compile call, and it's highly cacheable: prompts cluster heavily ("fire", "matrix", "draw with light"), so I'd add a semantic cache in front of `/api/generate` — normalize the prompt, check a KV store (Vercel KV) for an exact hit, then an embedding-similarity hit above ~0.92 cosine, and only call the LLM on a true miss. Most traffic becomes a sub-10ms KV read instead of a model call. (The richer taste layer of §7 changes nothing here — same single call, same schema, same cacheability.)

The base64-in-URL design is what makes the prototype databaseless, and I'd keep it as the fallback forever — but at scale I'd add short IDs (`/e/xK3f9a`) backed by the same KV store, for three reasons: prettier links on social, click analytics, and the ability to evolve the schema server-side without breaking old links (the `v` field plus a server-side migration on read).

Finally, clips: `MediaRecorder` produces WebM, which still plays unreliably in iOS Safari and most native share targets. I'd add an async transcode path — upload the WebM to blob storage, queue a serverless ffmpeg job to produce H.264 MP4, notify the client — so "share to phone" works universally. None of this changes the architecture; it wraps it.

---

## 10. Defending the tricky logic (plain language)

**Why refs and direct drawing instead of React state.** React re-renders reconcile a component tree — fine at interaction speed, ruinous at 60Hz. Landmarks and effect state change every 16ms; routing them through `useState` would trigger 60 reconciliations/second for data React never needs to *render* as components. Refs are mutable boxes invisible to React: the rAF loop reads and draws directly to canvas, and React only re-renders on real UI changes. The session state machine is the deliberate exception that proves the rule: its transitions happen seconds apart, so *those* go through React state and get free CSS-transition overlays — the dividing line is frequency, not dogma.

**Why EMA smoothing, and why those alphas.** The model's per-frame estimates wobble a few pixels even on a still hand. EMA (`s += α(raw − s)`) is a one-line low-pass filter: each frame moves the smoothed value a fixed fraction toward the raw value. Small α = smooth but laggy; large α = responsive but jittery. 0.35 at 60fps lands at ~100ms perceived latency — below the threshold where it feels laggy, above the threshold where jitter shows. It's a tuned compromise, and the debug HUD in build-step 2 is where it gets tuned.

**Why hysteresis for pinch.** Pinch is a binary decision over a noisy continuous signal. One threshold means the noise crosses it back and forth many times per second when your fingers hover near it — grab/release/grab/release flicker. Two thresholds (enter at 0.28, exit at 0.40) create a dead zone the noise can't cross: once pinching, you must *clearly* open to release. Same principle as a thermostat not toggling the furnace 40 times an hour. The onboarding gate's 500ms debounce is the same idea applied to "is a hand present" — a binary decision over a noisy signal gets a time buffer instead of a hair trigger.

**Why normalize pinch by hand scale.** Raw thumb-to-index distance in screen space shrinks as the hand backs away from the camera — the same physical pinch reads as different numbers at different depths. Dividing by wrist-to-knuckle distance (which shrinks identically with depth) cancels distance out entirely. Same trick as your torso-length normalization, same justification. Bonus: that same `scale` number doubles as the too-far/too-close detector for the quality hints — one measurement, two jobs.

**Why coast-then-release instead of instant reset on hand loss.** The tracker drops single frames constantly — motion blur, finger occlusion. Binary presence would make every one-frame miss release your grab or lift your pen: the experience would feel haunted by invisible failures. Freezing signals for ~200ms bridges nearly all real dropouts invisibly (the EMA already adds ~100ms of inertia, so a 200ms hold is below notice). And freezing beats extrapolating: the last landmarks before a loss are usually garbage, so projecting their velocity forward shoots the cursor across the screen. When loss is real, each effect exits *by design* — pen up, energy dissipating, tiles springing gently home — so even genuine tracking failure looks like a feature.

**Why a permission screen before the permission prompt.** A cold `getUserMedia` on page load is the highest-denial pattern there is: no context, no trust, and on Chrome a dismissal counts toward auto-block. A click-first screen converts better for three compounding reasons: the request is user-initiated, the prompt is explained one second before it appears, and the on-device privacy line disarms the actual fear behind most denials. It also buys ~2 free seconds to preload the WASM model in parallel — turning the slowest part of cold start into time the user spends reading anyway.

**Why the onboarding gate and the ramp.** Starting the effect at an empty wall the instant tracking initializes is the "dead demo" failure: something is running, nothing is happening, the user doesn't know they're the input device. Gating on "hand present for 500ms" plus a 600ms intensity bloom does two jobs with one mechanism: it guarantees the first thing the effect ever does is respond to the user's hand (cause and effect established in the first second), and it makes the user feel like *they* ignited it.

**Why bounded falloff instead of "real" inverse-square forces.** `1/d²` is physically correct and practically broken: as a tile approaches the fingertip, force →∞, integration overshoots, tile launches off-screen. `(1 − d/R)²` is maximal-but-finite at the center, exactly zero at radius R (no visible cliff where influence ends), and unconditionally stable. Effects are interaction design wearing a physics costume — stability and feel outrank physical accuracy.

**Why follow-the-leader chains for the ribbon.** Drawing the raw fingertip path reproduces every tremor of your hand. Cascading 28 lerps means each node low-pass-filters the one before it: noise dies within a few nodes, while large deliberate motions propagate down the chain with increasing delay — which is precisely what a real ribbon does in air. Maximum organic quality from minimum math.

**Why dt clamping.** Physics integrates `v · dt`. Switch tabs for two seconds and the next frame's dt is 2000ms — every particle teleports two seconds of travel in one step, most of it off-screen. Clamping dt to 33ms means after a stall the simulation resumes *slowly* instead of *explosively*. One `Math.min`, saves the demo.

**Why pre-rendered sprites + additive blending for particles.** `ctx.arc()` rasterizes a path per particle per frame; `drawImage` of a tiny pre-rendered glow canvas is a texture blit — several times cheaper, which is the difference between 1,500 and 4,500 particles at 60fps. Additive blending (`"lighter"`) makes overlapping particles sum to white-hot cores, so visual richness emerges from density instead of from more drawing work.

**Why the perf overlay updates at 4Hz via the DOM, not 60Hz via React.** The overlay must not appear in its own measurements. Per-frame DOM text mutation triggers layout and paint work every frame — a literal observer effect; React state would add reconciliation on top. So: collection is free arithmetic in a ref every frame, display is four cheap `textContent` writes per second on a fixed-width, pointer-events-none element. The instrument reads the system without touching it.

**Why adaptive quality only steps down.** Bidirectional adaptation oscillates: degrade → headroom appears → upgrade → frames drop → degrade — which the user perceives as rhythmic stutter, worse than steady lower quality. One-way stepping converges in one or two moves to the best tier the machine sustains, and stays there. Nobody notices 30% fewer particles; everybody notices pulsing.

**Why the LLM gets heuristics + examples instead of more effects or more parameters.** The temptation when prompts get abstract is to widen the schema. That's the wrong axis: every new field multiplies validation surface and physics tuning, while the actual gap is *judgment* inside the existing choices. Heuristics give the model a procedure (feeling → verb → effect; mood → palette; energy → intensity); examples demonstrate the procedure on the hard cases. At temperature 0.2 the model imitates demonstrated reasoning faithfully — so the system gets dramatically smarter-feeling while the contract the rest of the codebase depends on doesn't move by one field.
