# Session 4 — The Universal Movement Engine + FPS & Model Selection (Deep Dive)

> This is the most important conceptual document of your whole prep. The goal: by the end you can take **any** movement a user names — squat, one-hand pushup, high kick, butterfly pose, the escape-the-frame game, jumping jacks, a T-pose, a dab, anything — and explain *how the engine would detect it* using one consistent rule system. If you own this, you own the core of Motions, and as you said, UGC and the creator loop are byproducts. The FPS and model questions are answered in plain language at the end.

---

## PART 0 — The One Idea Everything Hangs On

You already said it: **prompts are infinite, but detectable body movements are finite.** Now we go one level deeper, to the thing that makes this actually buildable:

**Every human movement, no matter how exotic it sounds, is just a pattern in how the 33 body points move over time. And there are only a handful of *kinds* of patterns.** Once you see the handful of kinds, "hundreds of movements" stops being scary — because each of the hundreds is just one of a few *types* with different joints plugged in.

So the engine isn't "100 separate hand-coded games." It's a **small set of detection *templates*** (I'll call them "rule-types"), and any named movement is built by filling in a template with: *which joints, in what geometric relationship, crossing what threshold, over what time pattern.*

That's the whole secret. Let me build it up.

---

## PART 1 — The Raw Material (quick refresher, so the rest lands)

MediaPipe gives you, ~30–60 times a second, **33 body landmarks**, each as:
- **x, y** — normalized position (0 to 1) across the frame. (Resolution already divided out — see Session 1.)
- **z** — rough depth (toward/away from camera). Noisy; used sparingly.
- **visibility** — 0 to 1 confidence that this point is really there and correctly placed.

The 33 points are the ones you'd expect: nose, eyes, ears, shoulders (L/R), elbows (L/R), wrists (L/R), hips (L/R), knees (L/R), ankles (L/R), plus hands and feet detail points.

**Everything below is just math on these points.** No magic.

---

## PART 2 — The Two Foundations Every Movement Needs

Before *any* movement can be detected reliably, two problems must be solved — and they're solved the *same way for every movement*. This is why understanding them once unlocks all hundred movements.

### Foundation A — "Scale" (so it works at any distance / any body)

**The problem in plain terms:** If you stand close to the camera, your body fills the screen — the gap between your shoulders might be 0.4 of the frame width. Step back, and the same shoulders are now 0.15 of the frame. *Nothing about your body changed, but every raw number did.* So you can never say "a movement happened if a point moved 0.1" — because 0.1 means a huge motion when you're far and a tiny one when you're close.

**The fix — measure everything relative to the body's own size.** Pick a stable body distance that's *always* present and roughly constant for a given person — the standard choice is **torso length: the distance from the midpoint of the shoulders to the midpoint of the hips.** Call that number **`scale`.**

Now, instead of measuring movements in "frame units," you measure them in **"torsos."** 

> Real-world analogy: imagine measuring a room. "The couch moved 50 cm" is meaningless if you don't know the room size. But "the couch moved half a couch-length" is meaningful in any room. `scale` is your couch-length. The body becomes its own ruler.

So a squat isn't "shoulders dropped 0.1 of the frame." It's **"shoulders dropped by 30% of *this person's torso length*."** That sentence is true whether they're 2 feet or 10 feet from the camera, tall or short, on a phone or a laptop. **This single trick is what makes the whole engine distance-proof and body-proof.** Mention it and you sound like you deeply get CV.

(Why torso and not, say, height? Because height needs your feet and head both visible, which often fails — feet leave the frame constantly. Shoulders and hips are almost always visible and stay a stable distance apart. Reliable reference > perfect reference.)

### Foundation B — "Baseline" (so it knows your *resting* state)

**The problem:** To detect "you dropped into a squat," the engine must know where your shoulders are when you're *standing normally*. But that "normal" is different for everyone, and you drift around (step forward, lean, the camera shifts).

**The fix — an adaptive baseline.** The engine keeps a running estimate of your "resting" value (e.g., standing shoulder height) and **slowly updates it over time** using a running average that leans mostly on the old value and nudges slightly toward each new frame. (The technical name is *exponential smoothing*; you don't need the name, just the idea: "a memory that mostly remembers the past and drifts slowly toward the present.")

Crucially it updates **asymmetrically** — it re-learns your standing height quickly when you're *up*, but holds steady when you *drop*, so it doesn't "chase" the squat and erase the very thing it's measuring.

> Analogy: it's like your eyes adjusting to a dark room. The baseline slowly adapts to "normal" so that a sudden change (the squat) stands out against it.

**Foundation A + Foundation B together** = the engine always knows (1) how big you are on screen, so it can measure in "torsos," and (2) what your resting position is, so it can measure *change* from rest. With those two, you can detect essentially any movement. Now let's see the templates.

---

## PART 3 — THE RULE-TYPES (the templates that cover everything)

Here is the core claim: **almost every movement a user can name falls into one of a small number of detection templates.** Learn these ~6 and you can describe how to detect *anything*.

For each, I give: the idea, the recipe, and worked examples — including the exotic ones you asked about.

### RULE-TYPE 1 — POSITION CHANGE (something moved relative to baseline)

**Idea:** A key joint (or joints) moves away from its resting position by more than a threshold, measured in torsos.

**Recipe:** pick the joint(s) → compare current position to baseline → if the change exceeds X% of `scale`, the move is happening.

**Examples:**
- **Squat:** shoulders (and hips) drop ≥ ~25–30% of torso below standing baseline → squat detected. Rise back above a reset line → ready for next rep. *(Reset line = hysteresis, see Part 4.)*
- **Jump:** hips (and the whole skeleton) rise ≥ ~15–20% of torso above baseline, *briefly* → jump. (Brief + upward distinguishes it from just standing taller.)
- **Both-hands raise:** both wrists go above shoulder/head level (compare wrist.y to shoulder.y — remember y increases downward, so "above" means smaller y).
- **Lateral dodge / lean:** the shoulder-hip centerline shifts left or right by X% of `scale` from center. Lean left = dodge left.

### RULE-TYPE 2 — JOINT ANGLE (a limb bent or straightened past a threshold)

**Idea:** Many movements are really about an **angle at a joint** — how bent your elbow or knee is. You compute the angle from three points (e.g., shoulder–elbow–wrist gives the elbow angle).

**Why angles are powerful:** an angle is *naturally* scale-invariant — it doesn't care how far you are from the camera; a 90° elbow is 90° at any distance. This is the workhorse for pushups, squats-by-knee, kicks, etc.

**How you get an angle:** take three joints A–B–C (B is the middle/pivot). The angle at B is computed from the two vectors B→A and B→C. (The engine uses basic trig — `atan2` / dot product. You don't need the formula; you need to know "three points give you the angle at the middle one.")

**Examples — and here's where your "hundreds of movements" get covered:**
- **Two-hand pushup:** track the **elbow angle** (shoulder–elbow–wrist). Down = elbow angle goes small (deeply bent, ~90° or less). Up = elbow angle goes large (arms straight, ~160–180°). One rep = down then up. *Plus* a check that the body is roughly horizontal (shoulders and hips at similar height) so a standing arm-bend doesn't count as a pushup.
- **One-hand pushup:** *same elbow-angle rule, but on one arm only*, plus a check that the other hand isn't planted the same way (e.g., one wrist near torso/behind back, or only one arm shows the bend cycle). This is the key insight: **one-hand vs two-hand pushup is the SAME template (elbow angle down/up) with a different "which arms count" condition.** You don't invent a new detector — you parameterize the existing one.
- **High kick:** track the **hip angle** (shoulder–hip–ankle) or simply the **ankle height relative to hip**. A high kick = one ankle rises sharply toward or above hip/waist level. Left kick vs right kick = which ankle. The *height threshold* (in torsos) decides "high" kick vs a small kick.
- **Squat (angle version):** knee angle (hip–knee–ankle) goes from straight (~170°) to bent (~90°) and back. Often combined with the position-change version for robustness.
- **Bicep curl, lunge, etc.:** all just "angle at joint X crosses threshold and returns." Same template, different joint.

> **This is the big unlock to say out loud:** "Most strength/calisthenics movements — pushups one or two handed, squats, lunges, curls, kicks — are all the *same* rule-type: an angle at a joint cycling between a bent and a straight threshold. We're not coding hundreds of detectors; we're parameterizing a few templates with different joints and thresholds."

### RULE-TYPE 3 — POSE MATCH (hold a static shape)

**Idea:** Some "movements" are actually *static poses* — you must arrange your body into a target shape and hold it. Detection = compare your current joint geometry to a target geometry; if close enough for long enough, success.

**How:** define the target as a set of *relationships* (again scale-invariant): "wrists far apart and level with shoulders" (T-pose), "wrists together above head" (steeple), etc. Score how closely the current pose matches; if the match score stays above a threshold for, say, 0.5–1 second, it counts.

**Examples:**
- **T-pose:** arms straight out → both wrists roughly level with shoulders (similar y), far apart in x, elbows straight (angle ~180°).
- **Butterfly pose (the one you mentioned):** depends which "butterfly" — seated butterfly stretch = knees out wide, ankles together near the body, torso upright. Detection = ankles close together near the hip line, knees spread wide (large x-distance between knees relative to `scale`), hips low. You define the *relationships* and check them. The point: **even a weird-sounding pose is just "these joints in these relative positions, held briefly."**
- **Star jump hold, warrior pose, hands-on-head, etc.:** all "target geometry, held."

### RULE-TYPE 4 — VELOCITY / EXPLOSIVENESS (fast motion, not position)

**Idea:** Some moves are defined by *speed*, not where you end up. A punch isn't "wrist is here" — it's "wrist moved *fast* away from the body and came back." 

**How:** track how far a joint moved **since the last frame** (that's velocity), measured in torsos-per-frame so it's scale-invariant. Keep a short rolling history (say the last ~10 frames) and use the *peak* speed, which gives a clean "detected!" spike instead of flicker.

**Examples:**
- **Punch:** wrist velocity spikes + arm extends (wrist far from shoulder). Left/right by which wrist.
- **Clap:** both wrists move fast *toward each other* and meet (x-distance collapses quickly).
- **Wave, fast jab, slap:** all "this joint's speed crossed a threshold in this direction."

### RULE-TYPE 5 — PRESENCE / ABSENCE & TIMING (the third-founder game!)

**Idea:** This is the one you specifically asked about — Zakaria's "escape the frame" game. The movement isn't about joint angles at all; it's about **whether the body (or enough of it) is detected in the frame, and the *timing* of appearing/disappearing.**

**How:** use the **visibility** values. If enough key landmarks have high visibility → body is "present." If they drop below threshold → body is "absent / left the frame." Then layer **time windows** on top: "a cue fires; you must go from present → absent within a 1-second window."

**The escape game, decoded:**
1. Game expects you **present** in frame (key landmarks visible).
2. A cue says "GET OUT."
3. The engine starts a ~1-second timer and watches the visibility of your torso/upper-body landmarks.
4. **Clean escape** = those landmarks drop below the visibility threshold (you physically left the frame) *within* the window.
5. **Fail** = you were too slow, or only partially left (some landmarks still visible = you ducked or only half-exited).

**The hard, interesting part (and the thing to ask Sharoz about):** the *messy middle.* What if you're half in frame? What if you ducked below instead of stepping out? You need a rule for "how much absence counts as gone" — e.g., "fewer than N of the torso landmarks visible = escaped." That ambiguity is the real engineering, and naming it shows you think like a builder, not a demo-maker.

> Say this: "The escape game is a presence/absence-plus-timing rule-type — it's reading landmark *visibility* over a time window, not joint geometry. The genuinely hard part is defining 'gone' when someone's half in frame or ducks instead of exits."

### RULE-TYPE 6 — COUNTING / RHYTHM / SEQUENCE (movements over time)

**Idea:** Many games aren't a single detection — they're *counting repetitions* or *matching a rhythm/sequence* of the above.

**How:** wrap any rule-type above in a counter with hysteresis (Part 4), or require a *sequence* ("squat, then jump, then punch" — a combo).

**Examples:**
- **Jumping jacks:** a *combination* — legs spread apart (ankle x-distance grows) AND arms raise, both together, cycling. It's Rule-Type 1 (position change) on two joint-groups *in sync*, counted.
- **Rep counting** for any exercise = the underlying rule-type + "count each completed down-up cycle."
- **Dance/combo games:** a *sequence* of detections in order, on a timer.

---

## PART 4 — THE SHARED RULES THAT MAKE ALL OF IT RELIABLE

Every rule-type above needs these same guardrails. These are the "rules" you kept asking about. They apply universally:

1. **Scale-invariance (Foundation A):** measure in torsos, never in raw frame units. *Handles distance & body size.*

2. **Adaptive baseline (Foundation B):** continuously re-learn "resting" so you measure *change*, not absolute position. *Handles drift & different people.*

3. **Hysteresis (the anti-double-count rule — important, learn this word):** use **two thresholds, not one.** To count a squat: you must drop *below* the "down" line, THEN rise back *above* a separate, higher "up" line before the next rep counts. The gap between the two lines stops jitter near a single threshold from counting one squat as five. 
   > Analogy: a thermostat doesn't flip the AC on and off every time the temp wobbles by 0.1°. It waits for a real gap. Same idea — it prevents flickering.

4. **Smoothing (anti-jitter):** raw CV data is noisy frame-to-frame (points jump around slightly). Average over the last few frames so one bad frame doesn't trigger a false detection.

5. **Confidence / visibility gating:** only trust a landmark if its visibility is high enough. If the joints a movement needs aren't clearly visible (bad light, out of frame, occluded), don't score — optionally prompt "step back / more light."

6. **Plausibility limits (also your anti-cheat):** cap impossible rates (no human does 30 squats in 3 seconds) and require the *full expected geometry*, not just "something moved." This is what defeats camera-shake and fake-motion cheating, because measuring joints *relative to each other* means shaking the whole frame doesn't change their relationships.

**These six are the universal rulebook.** Any movement = pick a rule-type (Part 3) + apply these six guardrails (Part 4) + plug in the specific joints and thresholds. That's the entire engine.

---

## PART 5 — HOW A NAMED MOVEMENT BECOMES A WORKING GAME (end to end)

Putting it together, here's what happens when a user types *"one-handed pushup challenge"* or *"high kick game"* — the thing you want to be able to narrate:

1. **AI router reads the prompt** and maps it to: a **rule-type + joints + thresholds + a mechanic (win condition) + theming.** E.g. "one-handed pushup" → Rule-Type 2 (joint angle), joints = one-arm shoulder-elbow-wrist, thresholds = bent <100° / straight >160°, body-horizontal check on, mechanic = count-reps, theme = whatever fits.
2. That config is **validated** (is it a known rule-type with sane thresholds?) — never trust raw AI output blindly.
3. The engine **runs the chosen rule-type** in the 60fps loop with all six guardrails.
4. Score/feedback/skeleton/clip recording happen on top.

**The key architectural point for the interview:** the AI is *not* writing detection code per movement. The detection templates are **pre-built and trusted**. The AI just *selects and parameterizes* one. That's why it's reliable, instant, and safe — and why "hundreds of movements" is actually "6 rule-types × many joint/threshold combinations." 

> The sentence that wins this part: *"We don't build a hundred detectors. We build maybe six rule-types — position-change, joint-angle, pose-match, velocity, presence-timing, and counting/sequence — each hardened with the same guardrails (scale-invariance, adaptive baseline, hysteresis, smoothing, confidence-gating, plausibility limits). Any movement a user names is just one of those templates with different joints and thresholds plugged in. Get that engine right and the UGC and creator loop are byproducts — because now anyone can mint a reliable movement-game in seconds."*

### Why this directly serves the creator loop (your insight, confirmed)

You're right that 67speed is really built *for content creators to entertain their audience.* The movement engine is what makes that loop possible: a creator types an idea, gets a *reliable* game (reliable because of the rulebook above), records a clip of themselves (or their audience) flailing through it, and posts it. If the detection were flaky, the clip would be embarrassing and the loop would die. **So robust detection isn't separate from virality — robust detection is the *precondition* for virality.** That's the through-line to say.

---

## PART 6 — FPS, EXPLAINED FROM SCRATCH (you said you're weak here — let's fix it completely)

### What FPS actually is

**FPS = frames per second = how many still images are shown per second to create the illusion of motion.** Film is 24fps. Most phone/laptop screens refresh 60fps. Some gaming/flagship phones do 120fps.

There are actually **three different "per second" rates** in your app, and conflating them is what's confusing you. Keep them separate:

1. **Display refresh rate** — how many times the *screen* physically redraws per second (60Hz on most devices, 120Hz on flagships like iPhone Pro models with "ProMotion"). You can't show more frames than the screen redraws.

2. **Render/game-loop FPS** — how many times *your code* draws a new frame (moves emojis, redraws skeleton). Driven by `requestAnimationFrame`, which syncs to the display. On a 60Hz screen this naturally caps at ~60.

3. **Pose-detection FPS** — how many times per second *MediaPipe analyzes a camera frame* to produce new landmarks. This is often **lower** (e.g. ~30 on a phone) because analyzing an image is heavier than drawing shapes. Between detections, the game loop just reuses the latest landmarks.

> The key realization: **your game can render at 60fps while pose detection runs at 30fps.** The motion looks smooth (rendering) even though the body is only *analyzed* 30 times a second. "60fps" usually describes the *feel/render*, not the detection.

### Why 60, and your iPhone 17 Pro Max / 120fps question

You asked the smart version: *if a user has a great phone (120Hz ProMotion display), can we go to 120fps for more clarity?*

Let's be precise about what 120fps buys and costs:
- **It does NOT add "clarity"/resolution.** FPS is *smoothness over time*, not image sharpness. Sharpness is resolution (720p vs 1080p). So 120fps won't make the picture crisper — it makes motion smoother. (Worth getting right — you said "higher clarity," but FPS ≠ clarity.)
- **On a 60Hz screen, 120fps is pointless** — the screen can't show frames it doesn't redraw. Wasted work.
- **On a 120Hz screen (iPhone 17 Pro Max, etc.), 120fps render is possible and looks slightly smoother** — *but* it roughly **doubles the CPU/GPU work** of the render loop, on top of the already-heavy pose detection + clip recording. That heat/battery/throttling cost usually isn't worth it for this kind of game, where 60 already feels instant. And it does nothing for the *detection* accuracy (that's gated by the model speed, not the render rate).
- **The honest answer:** you *could* render at 120 on capable devices, but the smart product choice is usually "render at 60, keep detection as fast as the device allows, spend the device's spare power on a better/heavier *model* or higher recording quality rather than on extra frames nobody can perceive." Smoothness past 60 is a tiny gain; detection quality and not dropping frames matter far more.

> Interview-ready line: *"FPS is smoothness, not clarity — clarity is resolution. 60 matches most displays and feels instant for body-controlled motion; 120 only helps on a 120Hz screen and roughly doubles the render load for a gain most people can't perceive — and it does nothing for detection accuracy, which is gated by the model, not the frame rate. So I'd hold render at 60 and spend a powerful phone's headroom on a heavier pose model or better capture, not extra frames."*

### Should we drop FPS on weak phones?

Yes — that's the real lever. On a struggling device you protect *smoothness of the experience* by lowering load: drop the **detection** rate first (analyze 20–24×/sec instead of 30), or drop the **recording** framerate, before you let the game stutter. Adaptive frame-rate is a normal technique.

---

## PART 7 — MODEL SELECTION: Lite vs Full vs Heavy, and "is it dynamic?"

### The three sizes (recap + why)

MediaPipe Pose comes in **Lite, Full, Heavy** (sometimes phrased as model complexity 0/1/2):
- **Lite:** fastest, lightest, least precise. Great for fast games on weak devices.
- **Full:** middle ground.
- **Heavy:** most accurate, slowest, heaviest. For precision tasks (PT/form-correction) or strong devices.

For a *game*, Lite is usually right: you need to reliably know "did they squat / punch," not millimeter joint precision, and you must hold framerate on a cheap phone.

### Is model choice dynamic? — the answer you're looking for

It **can and should be**, and this is a great thing to raise as forward-thinking:

- **Static approach (simplest):** ship Lite for everyone. Safe, lowest common denominator. Probably what a v1/launch does.
- **Dynamic approach (smarter, likely roadmap):** **detect the device's capability and pick the model to match.** On launch, do a quick capability check (or measure the first second of real framerate) → if the device is powerful and holding 60fps comfortably, upgrade to Full/Heavy for better accuracy; if it's struggling, stay on Lite and maybe lower detection rate. 
- **Adaptive at runtime (smartest):** start on a safe model, *monitor actual framerate live*, and **downgrade or upgrade on the fly** if the device starts dropping frames or shows headroom. This is the same idea as adaptive video streaming (Netflix dropping resolution when your wifi dips).

> Interview-ready line: *"Model choice should be capability-aware. Static Lite-for-all is fine for launch, but the better version detects device power — or measures live framerate — and picks Lite/Full/Heavy to match, even adapting at runtime if frames start dropping. Same philosophy as adaptive bitrate streaming. That way a flagship gets accuracy and a budget phone still stays smooth — and crucially, *that's* where a powerful phone's spare power should go: a heavier, more accurate model, not 120fps nobody can see."*

This ties your FPS answer and model answer together into one coherent philosophy: **spend a strong device's headroom on detection quality (heavier model), not on perceptually-wasted extra frames.** Saying that shows real systems judgment.

---

## PART 8 — THE 60-SECOND VERSION (memorize the shape)

> The engine isn't hundreds of hand-coded movements — it's about six *rule-types*: position-change, joint-angle, pose-match, velocity, presence/timing, and counting/sequence. Any movement someone names — one-hand pushup, high kick, butterfly pose, the escape-the-frame game, jumping jacks — is just one of those templates with different joints and thresholds plugged in. Two foundations make them all work at any distance and on any body: measuring everything relative to torso length (scale-invariance) and an adaptive baseline that re-learns your resting position. Then six universal guardrails harden it: scale-invariance, adaptive baseline, hysteresis to stop double-counting, smoothing for noise, confidence-gating, and plausibility limits — which double as anti-cheat. The AI never writes detection code; it just selects and parameterizes a trusted template. On performance: FPS is smoothness not clarity — 60 matches most screens and feels instant; on a flagship I'd spend the spare power on a heavier, more accurate pose model rather than 120fps no one can perceive, and I'd make model choice capability-aware, even adapting at runtime like adaptive streaming. Nail that engine and UGC is a byproduct — robust detection is the precondition for a clip worth sharing, which is the whole creator loop.

---

That's the universal engine. Once this is solid in your head, there is no movement Sharoz can name that you can't reason about out loud — which is exactly the fluency you wanted.

When you're back, bring your next FPS/model questions if any remain — and then we really should run the live mock, because two days out, getting this *out of your mouth* under follow-up pressure is now the highest-value thing left.
