# Session 1 — Understanding Motions, the Tech, and Your Project (Three Levels)

> Read this slowly. Reread it. By the end you should be able to explain, in your own words: (1) what Motions actually is and why they exist, (2) what computer vision and MediaPipe actually are, from zero, (3) what YOU built, and (4) how the *real* Motions solves the "hundreds of thousands of people making games" problem. The last part is the conversation Sharoz actually wants to have.

---

## PART 0 — The Single Most Important Thing to Internalize

Motions describes itself, in the founders' own words, as **"the fastest way for consumers to build with computer vision."**

Read that sentence again. It is the whole company. Not "a fitness app." Not "a game." A *platform* where a normal person — no coding, no game-design skill — can create a real, working computer-vision experience in seconds, and instantly share it.

Your project, PROMPT.arcade, is *literally a working prototype of that exact thesis*: type a sentence in plain English → get a playable camera game → share it with a link. You didn't build something adjacent to their vision. You built a small version of their core product. That is why Sharoz tested it himself, complimented it, and pulled you into a call. Hold onto that — it's your strongest card and it's real.

---

## PART 1 — Who Motions Is (Know This Cold)

**The company:** Motions. A pre-seed startup. Backed by **Afore Capital** and accepted into Afore's **Founders-in-Residence** program (they cite a sub-1% acceptance rate). They also interviewed at **Y Combinator** and moved to **San Francisco** to go full-time. Launching **v1 on June 20**.

**The three founders:**

- **Avron Pasag — CEO.** ~20 years old. This is the key fact: *before Motions, he built "67speed" (a.k.a. 67 Speed) to 15M+ users.* That product is the entire DNA of this company, so you must understand it (Part 1b below).
- **Sharoz Javaid — Co-Founder & CTO.** This is the person you're talking to. His background is **UX design and product** (B.S. in Human-Computer Interaction, UC San Diego), and before Motions he worked at **EyePop.ai, a computer-vision company**, where he literally ran workshops on AI vision — including tracking body movements for workouts. So: he is a **product/design/CV person**, deeply user-first, who already knows MediaPipe and the real-world pain of pose detection in a browser. He is NOT going to grill you on obscure systems-engineering trivia. He WILL care about: does the product *feel* good, does the CV actually work smoothly, is the sharing loop frictionless, and do you *understand* what you built.
- **Zakaria Drebi — Co-Founder.** Third member of the founding team building/launching v1.

**Their backer's philosophy (Afore Capital) — why this matters for you:** Afore is a San Francisco pre-seed fund that backs *product-oriented founders at the earliest, pre-traction stage*. Their single most-repeated belief is **"momentum is the only moat"** — they bet on speed of execution, shipping, and people over polish. 

Translate that into what Motions is hiring for right now, weeks before launch: **someone who ships fast, unblocks the team, and matches their velocity.** Not a perfectionist. Not someone who needs a spec. This is *exactly* the posture you already showed — built the whole thing in a weekend, kept shipping updates (clip recording, share links) without being asked. When you talk to Sharoz, be that person. It's on-thesis for the company AND its investor.

### Part 1b — 67speed: the product that explains everything

67 Speed (67speed.com) is the viral game Avron built before Motions. You need to understand it because Motions is "67speed, generalized into a platform."

What it is: you open a website, it asks for camera access, and for **20 seconds you pump your arms up and down as fast as you can.** Your webcam watches you, counts every "rep," and gives you a score. There's a **global leaderboard** and a **world record** people chase. It went massively viral (millions of players) riding the "67" meme.

The important technical and product facts about 67speed (these are public and you can reference them):

- It uses **Google MediaPipe Pose** — the same computer-vision model your project uses — to detect **33 body landmarks ~30 times per second**, and it specifically tracks the **left and right wrists** to count arm pumps.
- Everything runs **on-device / locally in the browser**. *Camera frames never leave the device.* No video is uploaded or stored. Only your name + score go to the leaderboard. (Privacy is a selling point.)
- It has an **anti-cheat system** that tells real arm motion apart from someone just shaking the camera. (Remember this — it's a great thing to bring up, see Part 4.)
- **No signup, no app required, no paywall** to play on web. Zero friction.

Why this matters: it tells you *exactly* how this team thinks. The winning formula they already proved is: **real computer vision + zero friction + instantly shareable + a viral loop (leaderboard / clips).** Motions is the attempt to turn that one-hit formula into an engine that can spit out *thousands* of such experiences. Your PROMPT.arcade is a prototype of that engine.

There's also a revealing note from a founder studying Avron: his viral content worked because *"the product is never the headline — he leads with the result the viewer already wants, not the features."* Keep that in mind for how you talk on the call: don't lead with "I used a base64 encoding trick." Lead with "a person types a sentence and is playing a body-controlled game two seconds later, and can share it instantly." Outcome first, mechanism second.

---

## PART 2 — Computer Vision From Zero (So Nothing Is a Black Box)

You said you're not a CV person and don't know what models exist. Good — let's build it from the ground so you actually understand it, not memorize it.

### 2.1 What "computer vision" means here

Computer vision (CV) is just **getting a computer to extract meaning from images or video.** That's the umbrella. It ranges from "is there a cat in this photo" to "where exactly is this person's left elbow right now." The specific slice Motions and your project live in is called **pose estimation** (a.k.a. body tracking / pose detection).

### 2.2 What "pose estimation" is

Pose estimation answers one question, frame by frame: **"Where are this person's body joints in this image?"** The model looks at a video frame and returns the pixel positions of a fixed set of body points — shoulders, elbows, wrists, hips, knees, nose, etc.

The standard model both you and 67speed use is **Google MediaPipe** (specifically its "Pose Landmarker"). It detects **33 landmarks** — 33 predefined points on the human body. Each landmark comes back as a set of numbers:

- **x** — horizontal position, normalized 0 to 1 (0 = left edge of frame, 1 = right edge).
- **y** — vertical position, normalized 0 to 1 (0 = top, 1 = bottom). *Note: y increases going DOWN. This matters later.*
- **z** — rough depth (how far toward/away from camera). Less reliable; mostly ignored in your project.
- **visibility** — a 0-to-1 confidence that this point is actually visible / correctly placed.

"Normalized" is a key word. It means the coordinates aren't in pixels; they're fractions of the frame. So the math works the same whether the video is 480p or 1080p. (You still have to handle *distance from camera* separately — see the "scale" trick in Part 3.)

So 30–60 times per second, MediaPipe hands your code a list of 33 points, each with (x, y, z, visibility). **That stream of numbers is the raw material for everything.** A "game" is just: *rules written on top of how those 33 points move.*

### 2.3 Why MediaPipe specifically (and what the alternatives are)

You asked what models exist. Here's the honest landscape, enough to sound informed:

- **MediaPipe (Google).** Lightweight, runs *in the browser* on the user's own device using WebAssembly + the GPU. Fast enough for real-time (30–60fps). This is the right tool when you need zero-latency, no servers, runs-on-anyone's-laptop body tracking. **This is what 67speed and your project use, and almost certainly what Motions uses.**
- **MoveNet / BlazePose (also Google-adjacent / TensorFlow).** Similar niche, browser-capable pose models. Comparable idea.
- **YOLO-Pose, OpenPose, heavier custom models.** More accurate, but heavier — they typically want a **server with a GPU** to run. That means every video frame would have to travel to a server and back, which **adds latency and cost** and breaks the "instant, runs-on-your-phone, private" feeling.

The one-line reason MediaPipe wins for this use case: **the gameplay has to happen locally, in real time, with no server round-trip.** A game that lags because it's waiting on a server is not a game. MediaPipe runs *on the device*, so there's zero network delay, it works at scale for free (each user's own device does the work), and it's privacy-friendly (frames never leave the device). That last point is the same thing 67speed advertises.

MediaPipe also comes in three sizes — **Lite, Full, Heavy.** Lite is fastest/least precise; Heavy is slowest/most precise. For a *game*, you choose **Lite**, because a squat detector doesn't need millimeter precision — it just needs to reliably know "are the shoulders dropping?" — and speed (staying at 60fps) matters more than sub-pixel accuracy. (If you were doing medical/physical-therapy form correction, you'd want Heavy + maybe a server. Different tradeoff.)

### 2.4 The mental model to carry into the call

> "MediaPipe gives me 33 body points, 30–60 times a second, as normalized coordinates, running entirely on the user's device. Everything else — squats, punches, dodges, scoring — is just math I (well, the engine) wrote on top of how those points move over time."

If you understand only that paragraph, you understand 80% of the technical conversation.

---

## PART 3 — What YOU Built (PROMPT.arcade), Explained as One Story

Forget the 12 files. Here's the whole thing as a single narrative. This is the version you should be able to tell out loud.

**The idea:** A person types a plain-English description of a game — *"a zombie boxing game where I punch zombie heads"* — and within ~2 seconds they're playing that game using their body as the controller, via their webcam, at 60fps, entirely in the browser. When they finish, they can download a video clip of their gameplay or share a link that lets anyone else instantly play the *exact same* game.

**Now the flow, step by step:**

1. **Prompt in.** The user types a sentence on the homepage and hits generate.

2. **The AI "compiles" the sentence into a game spec.** The sentence is sent to an LLM (GPT, via Azure OpenAI). The LLM's only job is to translate the messy human sentence into a strict, predictable little config — a small JSON object. Think of it as a *menu order*: the AI reads "zombie boxing, punch the heads" and fills out a form:
   - `mechanic`: which *type* of game (one of 4 — see below)
   - `primitive`: which *body movement* the camera should watch for (one of 5)
   - `duration`, `instructions`, an emoji for the threat, a theme color.
   
   The AI is forced to output *only* valid JSON in this fixed shape (low "temperature" = low randomness, and a JSON-only mode). This is important: the AI is **not** writing game code. It's just *choosing from a fixed set of building blocks you already built.* That's what makes it reliable. The creativity is in the combination, not in inventing new mechanics on the fly.

3. **The 4 mechanics × 5 primitives — the "engine."** This is the real product insight, so understand it well. You didn't build infinite games. You built a small set of **reusable building blocks** that *combine* into many games:
   - **4 mechanics (the game *type* / win condition):** count-reps (do as many as possible), survival-dodge (avoid falling things), strike-targets (hit falling things), pose-match (hold a pose).
   - **5 primitives (the *body movement* the camera detects):** squat, jump, punch, lateral-dodge (lean left/right), both-hands-raise.
   - 4 × 5 = a grid of combinations. "Zombie boxing" = strike-targets mechanic + punch primitive. "Squat blitz" = count-reps + squat. The AI's job is just to pick the right cell in that grid (plus theming). **This is exactly the "platform, not one game" idea Motions is built on — at small scale.** Say that out loud in the interview; it shows you understand their thesis.

4. **The config becomes a URL.** Here's the clever, no-database part. That little JSON game-spec gets encoded (turned into a compact text string via Base64) and stuffed *directly into the URL* — e.g. `/play?config=eyJ0aXRsZSI6...`. The whole game definition *lives inside the link itself.* No database needed to store games. (Strengths and real limits of this are in Part 4 — Sharoz will probe it.)

5. **The browser opens the webcam and loads MediaPipe.** The user grants camera permission; MediaPipe's model loads (on-device, GPU-accelerated). A 3-2-1 countdown runs.

6. **The 60fps game loop — the heart of gameplay.** Sixty times per second, the code:
   - reads the latest 33 landmarks from MediaPipe,
   - runs the relevant **evaluator** (the math that turns joint positions into "is this a squat? how much of a punch?" — see 3.1),
   - draws the green skeleton over the webcam so you can see yourself being tracked,
   - spawns/moves the falling emojis (zombies, etc.),
   - checks collisions and updates the score,
   - and simultaneously draws *all of that* onto a hidden canvas that's being recorded (see step 7).

7. **Recording the clip.** Because you can't directly video-record a mix of webcam + HTML + animations, the engine draws everything (webcam frame + skeleton + emojis + score) onto one *hidden* canvas, and records *that* into a video file. When the game ends, you get a downloadable `.webm` clip — ready to post to social. This is the **viral loop** layer (it was your Iteration 2). It directly mirrors how 67speed gets shared.

8. **End screen → share / download / play again.** The user can download the clip, copy the shareable link (the same URL-with-config from step 4), or replay. Friend clicks link → same game loads instantly, no database hit → friend plays → friend shares. That's the loop.

### 3.1 The evaluators — your most impressive, most "real engineering" part

This is the part Sharoz (ex-EyePop CV person) will respect most, and it's the part that is *genuinely* clever rather than AI-boilerplate. An **evaluator** is a small function that turns raw joint positions into a meaningful game signal between 0.0 and 1.0 ("how much of a squat is happening right now?"). Understand these three ideas and you can speak credibly about CV:

**(a) Scale-invariant normalization (the "scale" trick).** Problem: if you stand close to the camera you look big; far away you look small. The raw numbers change even though a squat is a squat. Solution: before measuring anything, the code computes a **"scale" = the distance between shoulders and hips (your torso length on screen).** Then it measures everything *relative to your own torso.* A squat is "shoulders dropped by X% of your torso length," not "shoulders dropped by N pixels." So it works the same whether you're 2 feet or 8 feet from the camera. **This is the single best thing to mention — it shows you understand why naive pixel math fails.**

**(b) Dynamic adaptive baseline.** Problem: how does the code know your "standing" height to detect when you drop into a squat? People are different heights and move around. Solution: it keeps a *baseline* of your normal shoulder height and **slowly updates it over time** (using "exponential smoothing" — basically a running average that leans mostly on the old value and nudges slightly toward the new one each frame). It adapts at different speeds depending on direction so it doesn't "chase" your movement and cancel out the very thing it's trying to detect. (For squats: when you rise it re-learns your standing height fairly quickly; when you drop it holds steady so the drop registers.)

**(c) Velocity + smoothing for punches.** A punch isn't a position, it's a *fast motion.* So the punch evaluator tracks the **wrist's speed** (how far the wrist moved since last frame, relative to scale) plus **arm extension** (how far the wrist is from the shoulder). It keeps a short rolling history (≈10 frames) and uses the *peak* value, which creates a brief "punch detected!" window instead of flickering. The same rolling-average idea is used everywhere to kill jitter (raw CV data is noisy frame-to-frame).

If you can explain (a), (b), and (c) in your own words, you will sound like someone who understands the system — which you now will, because that's the actual logic, not jargon.

### 3.2 The two performance decisions worth knowing

Sharoz may ask "how do you keep it smooth at 60fps?" Two real answers:

- **Don't make React re-draw 60 times a second.** In React, normally when data changes the UI re-renders. If you stored the body landmarks in normal React state, React would try to re-render the whole screen 60 times per second and choke. Instead the landmarks are kept in a **ref** (a box that holds a value *without* triggering re-renders). The game loop reads from that box directly. Result: smooth.
- **Move things by touching the DOM directly, not via React state.** Same reasoning — for the fast-moving visual elements, the code sets their position/scale directly (`element.style.transform = ...`) instead of going through React's render cycle. This is a standard pro technique (animation libraries do the same).
- **Use `requestAnimationFrame`, not `setInterval`.** `requestAnimationFrame` is the browser's "call me right before you paint the next frame" hook — it stays in sync with the screen's refresh, so animation is smooth. `setInterval` fires on a dumb timer that can land at bad moments and cause stutter.

You don't need to write any of this. You need to be able to *say why* each choice was made. "We bypass React's render cycle for the game loop and keep pose data in a ref so we're not re-rendering 60 times a second" is a sentence that earns respect.

---

## PART 4 — The Real Question: How Would *Motions* Build This at Scale?

This is what you specifically asked, and it's the most important part for the interview, because it's the conversation a CTO actually wants: *not* "explain your code," but **"how do you think about turning this prototype into a real product that hundreds of thousands of people use to make games?"** If you can hold this conversation, you're in.

Below, for each piece, I give you: **what your prototype does**, **why it breaks at scale**, and **what the real Motions would do.** This "I know exactly where my prototype's limits are and what I'd do instead" framing is what separates someone senior from someone who got lucky with an AI tool. Use it.

### 4.1 Storing the games (the base64-in-URL question — he WILL ask this)

- **Your prototype:** the entire game config is Base64-encoded into the URL. No database. Genius for a demo: zero cost, zero latency, instantly shareable.
- **Why it breaks at scale:** URLs have practical length limits (~2,000 characters is safe; browsers/servers choke beyond a few thousand). The moment a game config gets richer — more parameters, custom assets, multiple levels — it won't fit in a URL. Also: **no analytics** (you can't see how many people played a game, or which games are popular, because nothing is stored). **No way to fix or moderate a game** once a link is out (you can't patch a broken or abusive game). **No leaderboards across players** (each link is an island). **Ugly, un-memorable links.**
- **What real Motions does:** store each game in a **database**, give it a **short ID**, and share a clean short link like `motions.app/g/x7k2`. When someone opens it, the app looks up the full config by that ID. You *keep the "feels instant and frictionless" property* (the thing that made 67speed work) but you *gain* persistence, analytics ("which games are going viral?"), leaderboards per game, moderation/safety, and the ability to update a game after sharing. The honest pitch: *"Base64 was the right call to kill all backend friction for a prototype and prove the loop. At real scale you'd move to short-IDs + a store, because you need analytics, moderation, and leaderboards — and those are exactly the things that power a UGC viral engine."* That answer shows you understand both why you did it AND why it's not the endgame.

### 4.2 The "hundreds of thousands of people, each making different games" problem

This is the core scaling question. Break it into the three things that actually scale differently:

**(a) Running the games — this already scales beautifully, and it's the whole point of MediaPipe.** Because pose detection runs **on each user's own device** (in their browser, on their phone/laptop GPU), there is **no central server doing the vision work.** If 500,000 people play at once, that's 500,000 devices each doing their own tracking. Motions pays ~nothing extra for that compute. *This is the deep reason the on-device MediaPipe choice matters — it's not just about latency, it's about scaling to millions for free.* Say this. It directly answers "how do they handle hundreds of thousands of players."

**(b) Generating the games (the AI compile step) — this costs money and needs managing.** Every time someone types a prompt, you call an LLM. That's a real per-request cost and a potential bottleneck/failure point. At scale, the real Motions would:
   - **Cache common prompts.** "Zombie boxing game" has been asked 10,000 times → don't re-call the LLM, return the known config. Cheap and instant.
   - **Constrain the output tightly** (which your prototype already does — the AI only picks from a fixed grid of mechanics/primitives). This keeps results valid, safe, and cheap, and means you can even *skip the LLM* for simple cases with keyword matching.
   - **Validate everything the AI returns** before trusting it (never let a raw LLM output drive the engine unchecked).
   - Possibly **move from "AI invents the combo" toward a richer fixed library + AI as the friendly front door.** The platform's real value isn't the LLM; it's the **library of well-built, reliable mechanics** the AI is choosing from. Motions' moat is in those polished building blocks, not in the prompt.

**(c) The content/UGC problem — the hard, interesting one.** When hundreds of thousands of people generate games, you get classic user-generated-content challenges that have nothing to do with CV:
   - **Discovery:** how does anyone find the good games among 500,000? (Leaderboards, trending, featured, categories — note 67speed already leaned on a *global leaderboard* as its discovery/virality engine. Motions will generalize that.)
   - **Quality & safety/moderation:** some prompts will be garbage, broken, or abusive. You need filtering — both at generation time (block bad prompts) and after (report/remove). This *requires* storing games (see 4.1), which is another reason base64-only doesn't survive.
   - **The viral loop:** the clip-recording + share-link layer (your Iteration 2) is the growth engine. Real Motions invests heavily here: make the shared clip look great, watermarked, one-tap to TikTok/Reels, so every player becomes a marketer. (Recall the founder note: *the product is never the headline — lead with the result.* The shareable clip IS the marketing.)

### 4.3 Anti-cheat (a sharp thing to raise yourself)

67speed publicly advertises an **anti-cheat system that distinguishes real arm motion from camera-shaking tricks.** This is a real CV product problem: when a score/leaderboard exists, people cheat by shaking the camera or faking motion. If you bring this up unprompted — *"once there's a leaderboard, you need anti-cheat in the pose layer — distinguishing genuine reps from camera-shake, which 67speed already does"* — you signal that you're thinking about the product the way they do, not just the demo. It's a genuinely impressive thing to surface.

### 4.4 Web vs. native app

Your prototype is web (Next.js, runs in a browser). 67speed started on web (zero friction: no install) and *then* shipped a native iOS app for the leaderboard/haptics/polish. Motions will likely think the same way: **web for frictionless virality and instant play, native app for retention, performance, haptics, and store presence.** Knowing this lets you ask Sharoz a smart question (see the question list in a later session).

---

## PART 5 — How to Hold Yourself on the Call (Posture)

A few principles, then we'll do mock Q&A in a later session.

1. **Lead with outcome, not mechanism.** "Type a sentence, play a body-controlled game in 2 seconds, share it instantly" — *then* the how, if asked. (This is literally Avron's stated content philosophy.)

2. **You understand the system; you used AI tools to build it fast. Both are true and both are strengths.** Don't claim to be a senior React engineer. Do own that you're a *product + AI-systems* person who can architect, reason about code, and ship fast with modern AI tooling. For an Afore "momentum is the moat" company, "I shipped a working prototype of your core thesis in a weekend using AI tooling, and I understand every decision in it" is a *better* story than "I hand-wrote every line." We'll script the exact one-liner for the React gap in Session 3.

3. **Know your prototype's limits before he points them out.** The base64 tradeoff (4.1) is the big one. Volunteering "here's where this breaks and here's what I'd do at real scale" is the single most senior-sounding move available to you.

4. **Speak their language:** "the loop," "frictionless / zero-friction," "UGC," "on-device," "the viral clip," "platform not a single game," "leaderboard as discovery." These are *their* words (from their own posts and 67speed's design). Using them naturally signals you get the company.

5. **Match the energy: fast, ambitious, builder.** They're 20-something founders weeks from launch who value momentum. Be the person who wants to ship with them, not the person auditing them.

---

## PART 6 — The 60-Second Summary (Memorize the Shape, Not the Words)

> Motions is "the fastest way for consumers to build with computer vision" — backed by Afore, founded by Avron (who built 67speed to 15M+ users), with Sharoz (ex-EyePop CV/product) as CTO, launching June 20. The proven formula is: real on-device computer vision + zero friction + instantly shareable + a viral loop. I built PROMPT.arcade, a working prototype of exactly that: you type a sentence, GPT compiles it into one of a fixed grid of camera-game building blocks (4 mechanics × 5 primitives), MediaPipe tracks 33 body landmarks on-device at 60fps, custom evaluators with scale-invariant normalization turn joints into squats/punches/dodges, and the whole game lives in a shareable link with a recorded clip for the viral loop. The clever prototype shortcut — base64-in-URL instead of a database — is perfect for proving the loop and terrible for scale, where you'd switch to short-IDs + a store to get analytics, moderation, and leaderboards. The reason this scales to millions cheaply is that the vision runs on each user's own device, so there's no central GPU cost. The hard problems at real scale aren't the CV — they're UGC discovery, quality/safety, and anti-cheat once leaderboards exist.

If you can deliver the *shape* of that paragraph conversationally, you have already won the technical-fit conversation. Everything else in later sessions is sharpening.

---

## What's Next (Sessions 2 & 3)

- **Session 2:** Go deeper on the architecture tradeoffs (so any follow-up is covered), and build out your *own* smart questions to ask Sharoz (asking good questions is half the interview).
- **Session 3:** The honesty layer + the React-gap one-liner, then a full mock interview where I play Sharoz and pressure-test you until the weak spots show, and we patch them.

Tell me when you've read this, and what felt shaky or unclear — we start Session 2 from wherever you're least confident.
