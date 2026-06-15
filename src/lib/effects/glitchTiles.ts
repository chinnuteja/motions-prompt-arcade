import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, GlitchTilesConfig, PALETTES } from '../vfx-schema';
import {
  springStep,
  expDamp,
  easeOutBack,
  clamp,
  lerpColor,
  roundRectPath,
  makeGlowSprite,
  makeSheenSprite,
  EmberPool,
} from './fxUtils';
import { OneEuroFilter } from './oneEuro';

/**
 * GLASS CARDS  (config.effect === 'glitch_tiles')
 *
 * Reinterpretation of the old grid-slicer: instead of shattering the whole frame
 * into a grid, a handful of distinct glass "cards" spawn and float around the
 * user's hands. Each card is a live magic-mirror slice of the webcam with a glassy
 * sheen + glow border. Grab with a pinch, fling to ignite a fire trail.
 *
 * Schema params are REINTERPRETED (no schema change):
 *   tileShape : 'square' | 'wide' | 'shard'   → card silhouette
 *   pullMode  : 'attract' | 'repel' | 'vortex' → how free cards behave near a hand
 *   snapBack  : 'spring'  | 'drift'            → idle behavior when no hand is near
 */

interface Card {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  angVel: number;
  w: number;
  h: number;

  // Live video sample region (canvas-space rect; mirrored at draw time)
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;

  // Home constellation slot (for snapBack === 'spring')
  homeX: number;
  homeY: number;

  // Orbit assignment (attract/vortex): which hand + angular slot on its ring
  orbitAngle: number;
  bobPhase: number;
  shardRot: number; // permanent baked-in tilt for 'shard' shape

  held: number;     // -1 free, else hand index
  grabDX: number;
  grabDY: number;

  spawnT: number;   // 0→1 pop-in
  fire: number;     // 0→1 fire energy
  seed: number;
  accent: string;

  bridgeSlot: number; // slot index in the index↔index tether bridge, -1 if not in formation
  formationSlot: number;
  formDepth: number;  // stack ordering/scale for fist shields; 1 for flat circle/line
  formScale: number;
  formAlpha: number;
}

type FormationMode = 'none' | 'line' | 'circle' | 'fists';

interface FingerProfile {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
  extendedCount: number;
}

interface FormationIntent {
  mode: FormationMode;
  handIndex: number;
}

interface FormationTarget {
  x: number;
  y: number;
  rot: number;
  stiffness: number;
  damping: number;
}

interface LineGeometry {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ux: number;
  uy: number;
  len: number;
}

const RING_R = 185;          // orbit ring radius around palm (px)
const GRAB_R = 150;          // how close indexTip must be to grab a free card
const FIRE_SPEED = 900;      // px/s throw speed that fully ignites a card
const WALL_RESTITUTION = 0.55;

export class GlitchTilesEffect implements VfxEffect {
  readonly effectIncludesVideo = true;

  private config!: GlitchTilesConfig;
  private w = 0;
  private h = 0;
  private cards: Card[] = [];
  private targetCount = 18;   // denser formations, less empty space

  private latestHands: [HandSignals | null, HandSignals | null] = [null, null];

  // Offscreen additive trail canvas for fire streaks
  private trailCanvas!: HTMLCanvasElement;
  private trailCtx!: CanvasRenderingContext2D;

  // Pre-rendered sprites (no per-frame gradient allocation)
  private sheen!: HTMLCanvasElement;
  private emberSprite!: HTMLCanvasElement;
  private palmGlow!: HTMLCanvasElement;
  private fingerSpark!: HTMLCanvasElement;
  private embers!: EmberPool;

  private primary = '#ffffff';
  private glow = '#ffffff';
  private emberColor = '#ff7a18';
  private accentColors: string[] = ['#ffffff'];

  // Readable gesture formations: two-index line, open-palm circle, two-fist 3x3 grid.
  private formationMode: FormationMode = 'none';
  private formationAlpha = 0;
  private formationHand = 0;
  private formationTime = 0;
  private formationN = 0;
  private lastRamp = 0;
  private _slottedMode: FormationMode = 'none';
  private circleSnapT = 0;

  // Quality tiers (one-way)
  private useShadow = true;
  private useSheen = true;

  // Clap-to-fade: hands together → cards converge & vanish
  private clapT = 0;

  // Internal One-Euro smoothed twoHand metrics (computed from hand signals)
  private twoHandRawPalmDist = 0;
  private twoHandPalmDist = 0;
  private twoHandMidX = 0;
  private twoHandMidY = 0;
  private twoHandActive = false;
  private indexDistFilter = new OneEuroFilter(0.8, 0.01);
  private palmDistFilter = new OneEuroFilter(0.8, 0.01);

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'glitch_tiles') throw new Error('Wrong config');
    this.config = config as GlitchTilesConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    const palette = PALETTES[config.palette];
    this.primary = palette.primary;
    this.glow = palette.glow;

    this.accentColors = [
      palette.primary,
      palette.secondary,
      palette.glow,
      '#77ffd7',
      '#ffe66d',
      '#b8a7ff',
      '#ff9ed1',
      '#b9f2ff',
    ];
    this.targetCount = config.intensity === 1 ? 28 : config.intensity === 2 ? 40 : 54;

    // Offscreen trail
    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = canvasWidth;
    this.trailCanvas.height = canvasHeight;
    const tctx = this.trailCanvas.getContext('2d');
    if (tctx) {
      this.trailCtx = tctx;
      this.trailCtx.fillStyle = '#000';
      this.trailCtx.fillRect(0, 0, this.w, this.h);
    }

    // Sprites
    this.sheen = makeSheenSprite(64, 256);
    this.emberSprite = makeGlowSprite(40, this.emberColor);
    this.palmGlow = makeGlowSprite(256, palette.glow);
    this.fingerSpark = makeGlowSprite(48, '#ffffff');
    this.embers = new EmberPool(config.intensity === 3 ? 280 : 180);

    this.spawnCards();
  }

  private spawnCards(): void {
    const { tileShape } = this.config.params;
    this.cards = [];

    // Premium vertical glass-tile silhouette: larger than the tiny squares,
    // but still compact enough to keep formations crisp and layered.
    const baseW = tileShape === 'wide' ? 66 : tileShape === 'shard' ? 58 : 62;
    const baseH = tileShape === 'wide' ? 80 : tileShape === 'shard' ? 76 : 78;

    // Spread the live video sample regions across the frame so faces / motion
    // appear inside the cards (rather than every card showing the same spot).
    const cols = Math.ceil(Math.sqrt(this.targetCount * (this.w / this.h)));
    const rows = Math.ceil(this.targetCount / cols);
    const cellW = this.w / cols;
    const cellH = this.h / rows;

    for (let i = 0; i < this.targetCount; i++) {
      const gx = i % cols;
      const gy = Math.floor(i / cols);

      const srcW = baseW * 1.52;
      const srcH = baseH * 1.24;
      // Sample centered in this card's grid cell, clamped to frame
      const srcX = clamp(gx * cellW + cellW / 2 - srcW / 2, 0, this.w - srcW);
      const srcY = clamp(gy * cellH + cellH / 2 - srcH / 2, 0, this.h - srcH);

      // Loose home constellation (golden-angle scatter, inset from edges)
      const ga = i * 2.39996;
      const rad = 0.18 + 0.62 * (i / this.targetCount);
      const homeX = this.w * (0.5 + Math.cos(ga) * rad * 0.5);
      const homeY = this.h * (0.5 + Math.sin(ga) * rad * 0.5);

      this.cards.push({
        x: homeX,
        y: homeY,
        vx: 0,
        vy: 0,
        rot: 0,
        angVel: 0,
        w: baseW,
        h: baseH,
        srcX, srcY, srcW, srcH,
        homeX, homeY,
        orbitAngle: (i / this.targetCount) * Math.PI * 2,
        bobPhase: Math.random() * Math.PI * 2,
        shardRot: 0,
        held: -1,
        grabDX: 0,
        grabDY: 0,
        spawnT: 0,
        fire: 0,
        seed: Math.random() * 1000,
        accent: this.accentColors[i % this.accentColors.length],
        bridgeSlot: -1,
        formationSlot: -1,
        formDepth: 1,
        formScale: 1,
        formAlpha: 1,
      });
    }
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    void _video;
    this.latestHands = hands;
    this.lastRamp = ramp;
    const { pullMode, snapBack } = this.config.params;
    const t = performance.now() * 0.001;
    if (this.cards.length < this.targetCount) this.spawnCards();

    // ── Compute internal smoothed twoHand metrics ─────────────
    const h0 = hands[0];
    const h1 = hands[1];
    if (h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost') {
      const rawIndexDist = Math.hypot(
        h1.indexTip.x - h0.indexTip.x,
        h1.indexTip.y - h0.indexTip.y,
      );
      const rawPalmDist = Math.hypot(
        h1.palm.x - h0.palm.x,
        h1.palm.y - h0.palm.y,
      );
      this.indexDistFilter.filter(rawIndexDist, dt);
      this.twoHandRawPalmDist = rawPalmDist;
      this.twoHandPalmDist = this.palmDistFilter.filter(rawPalmDist, dt);
      this.twoHandMidX = (h0.palm.x + h1.palm.x) / 2;
      this.twoHandMidY = (h0.palm.y + h1.palm.y) / 2;
      this.twoHandActive = true;
    } else {
      this.indexDistFilter.reset();
      this.palmDistFilter.reset();
      this.twoHandActive = false;
    }

    const profiles: [FingerProfile | null, FingerProfile | null] = [
      this.getFingerProfile(hands[0]),
      this.getFingerProfile(hands[1]),
    ];

    const intent = this.selectFormation(hands, profiles);
    const formationIntentActive = intent.mode !== 'none' || this.formationMode !== 'none';

    // ── Clap-to-fade: hands close together → cards converge & vanish ──
    // Formations own the layout. Do not let the old clap collapse fight line
    // length changes, circle radius changes, or the two-fist grid.
    const CLAP_DIST = 80;
    if (!formationIntentActive && this.twoHandActive && this.twoHandPalmDist < CLAP_DIST) {
      this.clapT = Math.min(1, this.clapT + dt * 3);
    } else {
      this.clapT = Math.max(0, this.clapT - dt * 4);
    }

    if (intent.mode !== this.formationMode || intent.handIndex !== this.formationHand) {
      const previousMode = this.formationMode;
      this.formationMode = intent.mode;
      this.formationHand = intent.handIndex;
      this.formationTime = 0;

      if (intent.mode === 'circle') {
        this.circleSnapT = previousMode === 'line' ? 0.28 : 0.18;
        this.formationAlpha = Math.max(this.formationAlpha, ramp * 0.9);
        this.clapT = 0;
      } else if (intent.mode === 'fists') {
        for (const c of this.cards) {
          if (c.held === -1) {
            c.vx = 0;
            c.vy = 0;
            c.angVel = 0;
          }
        }
      }
    }
    this.formationTime += dt;
    const targetFormationAlpha = intent.mode === 'none' ? 0 : ramp;
    // Smoother engage normally; circle entry gets a short snap so open palms
    // feel immediate after a line pose instead of slowly melting into place.
    const engageRate = this.circleSnapT > 0 && this.formationMode === 'circle' ? 32 : 9;
    this.formationAlpha += (targetFormationAlpha - this.formationAlpha) * (1 - expDamp(engageRate, dt));

    // Reset transient per-frame fields only
    for (const c of this.cards) {
      c.bridgeSlot = -1;
      c.formDepth = 1;
      c.formScale = 1;
    }

    const forming = this.formationMode !== 'none' && this.formationAlpha > 0.03;

    if (forming) {
      const desiredN = this.getDesiredFormationCount(this.formationMode, hands);
      const modeChanged = this.formationMode !== this._slottedMode;
      // Only (re)assign slots when the formation just changed, OR when slots are unassigned.
      const needsAssign =
        modeChanged ||
        this.formationN !== desiredN ||
        this.cards.filter((c) => c.held === -1 && c.formationSlot >= 0 && c.formationSlot < desiredN).length < desiredN;

      if (needsAssign) {
        if (modeChanged) {
          for (const c of this.cards) c.formationSlot = -1;
        }

        const eligible = this.cards.filter((c) => c.held === -1);
        const sortHand = hands[this.formationHand];

        if (this.formationMode === 'line') {
          const line = this.getLineGeometry(hands);
          if (line) {
            const { ax, ay, ux, uy } = line;
            eligible.sort((a, b) =>
              ((a.x - ax) * ux + (a.y - ay) * uy) - ((b.x - ax) * ux + (b.y - ay) * uy));
          }
        } else if (this.formationMode === 'circle') {
          const ring = this.getCircleGeometry(hands);
          if (ring) {
            eligible.sort((a, b) =>
              Math.atan2(a.y - ring.cy, a.x - ring.cx) - Math.atan2(b.y - ring.cy, b.x - ring.cx));
          }
        } else if (hands[0] && hands[1]) {
          const ax = hands[0]!.palm.x, ay = hands[0]!.palm.y;
          const dx = hands[1]!.palm.x - ax, dy = hands[1]!.palm.y - ay;
          eligible.sort((a, b) =>
            ((a.x - ax) * dx + (a.y - ay) * dy) - ((b.x - ax) * dx + (b.y - ay) * dy));
        } else if (sortHand) {
          eligible.sort((a, b) =>
            Math.atan2(a.y - sortHand.palm.y, a.x - sortHand.palm.x) -
            Math.atan2(b.y - sortHand.palm.y, b.x - sortHand.palm.x));
        }

        const activeN = Math.min(
          this.formationMode === 'circle' || this.formationMode === 'line' ? eligible.length : desiredN,
          eligible.length,
        );
        this.formationN = activeN;

        const used = new Set<number>();
        for (const c of this.cards) {
          const slot = c.formationSlot;
          if (c.held !== -1) continue;
          if (slot >= 0 && slot < activeN && !used.has(slot)) {
            used.add(slot);
          } else if (slot !== -1) {
            c.formationSlot = -1;
          }
        }

        for (let slot = 0; slot < activeN; slot++) {
          if (used.has(slot)) continue;
          const next = eligible.find((c) => c.formationSlot === -1);
          if (!next) break;
          next.formationSlot = slot;
          next.formAlpha = this.formationMode === 'circle' && this.circleSnapT > 0 ? 1 : 0;
          this.seedCardNearFormation(next, slot, activeN, hands);
          used.add(slot);
        }

        this._slottedMode = this.formationMode;
      }
      // else: keep existing slots — cards stay put, no reshuffle churn
    } else {
      this.formationN = 0;
      this._slottedMode = 'none';
      for (const c of this.cards) c.formationSlot = -1;
    }

    for (const c of this.cards) {
      const targetAlpha = !forming || c.held !== -1 || c.formationSlot >= 0 ? 1 : 0;
      const alphaRate = this.circleSnapT > 0 && this.formationMode === 'circle' ? 36 : 12;
      c.formAlpha += (targetAlpha - c.formAlpha) * (1 - expDamp(alphaRate, dt));
    }

    if (this.circleSnapT > 0) this.circleSnapT = Math.max(0, this.circleSnapT - dt);

    // ── Grab / throw impulse events ──────────────────────────────
    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (!hand || hand.track === 'lost') continue;

      if (hand.pinchJustStarted) {
        // Grab the single nearest free card within range
        let best: Card | null = null;
        let bestD = GRAB_R * GRAB_R;
        for (const c of this.cards) {
          if (c.held !== -1) continue;
          const dx = hand.indexTip.x - c.x;
          const dy = hand.indexTip.y - c.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD) { bestD = d2; best = c; }
        }
        if (best) {
          best.held = hi;
          best.grabDX = best.x - hand.indexTip.x;
          best.grabDY = best.y - hand.indexTip.y;
        }
      } else if (hand.pinchJustEnded) {
        // Throw every card this hand holds
        for (const c of this.cards) {
          if (c.held !== hi) continue;
          c.held = -1;
          c.vx = hand.indexVel.x * 1.15;
          c.vy = hand.indexVel.y * 1.15;
          const speed = Math.hypot(c.vx, c.vy);
          c.angVel = (c.vx > 0 ? 1 : -1) * Math.min(speed * 0.004, 14);
          c.fire = 0;
        }
      }
    }

    // ── Per-card physics ─────────────────────────────────────────
    for (const c of this.cards) {
      // Pop-in
      if (c.spawnT < 1) c.spawnT = Math.min(1, c.spawnT + dt / 0.45);

      if (c.held !== -1) {
        const hand = hands[c.held];
        if (!hand || hand.track === 'lost') { c.held = -1; }
        else {
          // Heavy spring-follow toward fingertip (mass / lag feel)
          const tx = hand.indexTip.x + c.grabDX;
          const ty = hand.indexTip.y + c.grabDY;
          const sx = springStep(c.x, c.vx, tx, 120, 14, dt);
          const sy = springStep(c.y, c.vy, ty, 120, 14, dt);
          c.x = sx.pos; c.vx = sx.vel;
          c.y = sy.pos; c.vy = sy.vel;
          // Rotate toward travel direction
          const targetRot = clamp(c.vx * 0.0006, -0.5, 0.5) + c.shardRot;
          c.rot += (targetRot - c.rot) * (1 - expDamp(10, dt));
          c.fire = Math.max(0, c.fire - dt * 1.5);
          continue;
        }
      }

      // Find the nearest tracked hand for hover behavior
      let near: HandSignals | null = null;
      let nearD = Infinity;
      for (let hi = 0; hi < 2; hi++) {
        const hand = hands[hi];
        if (!hand || hand.track === 'lost') continue;
        const d = Math.hypot(hand.palm.x - c.x, hand.palm.y - c.y);
        if (d < nearD) { nearD = d; near = hand; }
      }

      let ax = 0;
      let ay = 0;

      // Clap convergence: pull cards toward the midpoint before formation target
      if (this.clapT > 0.01 && this.twoHandActive) {
        const k = this.clapT;
        // pull toward the midpoint
        c.x += (this.twoHandMidX - c.x) * k * 0.35;
        c.y += (this.twoHandMidY - c.y) * k * 0.35;
      }

      const formationTarget = forming && c.formationSlot >= 0
        ? this.getFormationTarget(c, c.formationSlot, this.formationN, hands)
        : null;

      if (formationTarget) {
        const sx = springStep(c.x, c.vx, formationTarget.x, formationTarget.stiffness, formationTarget.damping, dt);
        const sy = springStep(c.y, c.vy, formationTarget.y, formationTarget.stiffness, formationTarget.damping, dt);
        c.x = sx.pos; c.vx = sx.vel;
        c.y = sy.pos; c.vy = sy.vel;
        c.angVel *= expDamp(10, dt);
        c.rot += c.angVel * dt;
        c.rot += (formationTarget.rot - c.rot) * (1 - expDamp(11, dt));
        c.fire = Math.max(0, c.fire - dt * 2.2);
      } else if (near && ramp > 0.01) {
        const dx = c.x - near.palm.x;
        const dy = c.y - near.palm.y;
        const d = Math.max(1, Math.hypot(dx, dy));

        if (pullMode === 'attract') {
          // Spring toward an evenly-spaced, slowly-rotating orbit slot + bob
          const slot = c.orbitAngle + t * 0.35;
          const bob = Math.sin(t * 1.6 + c.bobPhase) * 14;
          const tx = near.palm.x + Math.cos(slot) * (RING_R + bob);
          const ty = near.palm.y + Math.sin(slot) * (RING_R + bob);
          ax += (tx - c.x) * 26 * ramp;
          ay += (ty - c.y) * 26 * ramp;
        } else if (pullMode === 'repel') {
          // Inverse-square push with a comfort radius
          const f = clamp(60000 / (d * d), 0, 4200) * ramp;
          ax += (dx / d) * f;
          ay += (dy / d) * f;
        } else {
          // vortex: tangential orbital velocity + weak radial spring to the ring
          const tang = 3.2 * ramp;        // rad/s sweep
          const radialErr = RING_R - d;
          ax += (-dy / d) * d * tang + (dx / d) * radialErr * 8 * ramp;
          ay += (dx / d) * d * tang + (dy / d) * radialErr * 8 * ramp;
        }
      } else {
        // No hand near → snapBack behavior
        if (snapBack === 'spring') {
          ax += (c.homeX - c.x) * 18;
          ay += (c.homeY - c.y) * 18;
        } else {
          // drift: gentle gravity + slow tumble
          ay += 80;
          c.angVel += (Math.sin(t * 0.4 + c.seed) * 0.3 - c.angVel) * (1 - expDamp(0.5, dt));
        }
      }

      if (!formationTarget) {
        // Integrate (semi-implicit) with continuous drag
        const drag = c.held === -1 && !near && snapBack === 'drift' ? 0.6 : 6;
        c.vx = (c.vx + ax * dt) * expDamp(drag, dt);
        c.vy = (c.vy + ay * dt) * expDamp(drag, dt);
        c.x += c.vx * dt;
        c.y += c.vy * dt;
      }

      // Rotation integrate
      if (!formationTarget) {
        c.rot += c.angVel * dt;
        c.angVel *= expDamp(2, dt);
        // Self-right toward shard tilt when slow
        if (Math.abs(c.angVel) < 0.5) {
          c.rot += (c.shardRot - c.rot) * (1 - expDamp(1.5, dt));
        }
      }

      // Soft walls with restitution + spin kick
      const hw = c.w / 2;
      const hh = c.h / 2;
      if (c.x < hw) { c.x = hw; c.vx = Math.abs(c.vx) * WALL_RESTITUTION; c.angVel += c.vy * 0.002; }
      if (c.x > this.w - hw) { c.x = this.w - hw; c.vx = -Math.abs(c.vx) * WALL_RESTITUTION; c.angVel -= c.vy * 0.002; }
      if (c.y < hh) { c.y = hh; c.vy = Math.abs(c.vy) * WALL_RESTITUTION; c.angVel -= c.vx * 0.002; }
      if (c.y > this.h - hh) { c.y = this.h - hh; c.vy = -Math.abs(c.vy) * WALL_RESTITUTION; c.angVel += c.vx * 0.002; }

      // Fire decays as the card slows
      if (c.fire > 0) {
        const speed = Math.hypot(c.vx, c.vy);
        c.fire = clamp(c.fire - dt * (speed > FIRE_SPEED * 0.5 ? 0.4 : 1.4), 0, 1);
        // Shed embers from the trailing edge
        if (c.fire > 0.05) {
          const n = c.fire > 0.5 ? 3 : 1;
          for (let k = 0; k < n; k++) {
            const jitter = (Math.random() - 0.5);
            this.embers.spawn(
              c.x - c.vx * dt * 2 + jitter * c.w * 0.4,
              c.y - c.vy * dt * 2 + jitter * c.h * 0.4,
              -c.vx * 0.15 + (Math.random() - 0.5) * 120,
              -c.vy * 0.15 + (Math.random() - 0.5) * 120 - 40,
              0.4 + Math.random() * 0.4,
              14 + Math.random() * 18,
            );
          }
        }
      }

    }

    // ── Fade the fire-trail canvas (dt-correct) + advance embers ──
    const fade = 1 - expDamp(3.5, dt);
    this.trailCtx.globalCompositeOperation = 'destination-out';
    this.trailCtx.fillStyle = `rgba(0,0,0,${fade})`;
    this.trailCtx.fillRect(0, 0, this.w, this.h);
    this.trailCtx.globalCompositeOperation = 'source-over';

    this.embers.step(dt, 220, 1.2);

    // Stamp burning-card glow streaks onto the trail canvas
    this.trailCtx.globalCompositeOperation = 'lighter';
    for (const c of this.cards) {
      if (c.fire > 0.05) {
        const r = Math.max(c.w, c.h) * (0.5 + c.fire);
        this.trailCtx.globalAlpha = c.fire * 0.6;
        this.trailCtx.drawImage(this.emberSprite, c.x - r, c.y - r, r * 2, r * 2);
      }
    }
    this.trailCtx.globalAlpha = 1;
    this.trailCtx.globalCompositeOperation = 'source-over';
  }

  private getFingerProfile(hand: HandSignals | null): FingerProfile | null {
    if (!hand || hand.track === 'lost' || hand.landmarks.length < 21 || hand.scale <= 1) return null;
    const palm = hand.palm;
    const ratio = (idx: number) => Math.hypot(hand.landmarks[idx].x - palm.x, hand.landmarks[idx].y - palm.y) / hand.scale;
    const segment = (tipIdx: number, baseIdx: number) =>
      Math.hypot(
        hand.landmarks[tipIdx].x - hand.landmarks[baseIdx].x,
        hand.landmarks[tipIdx].y - hand.landmarks[baseIdx].y,
      ) / hand.scale;

    const thumb = ratio(4) > 0.78;
    const index = ratio(8) > 0.9 || segment(8, 5) > 0.58;
    const middle = ratio(12) > 1.02 || segment(12, 9) > 0.66;
    const ring = ratio(16) > 0.98 || segment(16, 13) > 0.62;
    const pinky = ratio(20) > 0.92 || segment(20, 17) > 0.55;
    const extendedCount = Number(thumb) + Number(index) + Number(middle) + Number(ring) + Number(pinky);
    return { thumb, index, middle, ring, pinky, extendedCount };
  }

  private isFullyClosedFist(hand: HandSignals | null, profile: FingerProfile | null): boolean {
    if (!hand || hand.track === 'lost' || hand.landmarks.length < 21 || hand.scale <= 1) return false;
    const palm = hand.palm;
    const reach = (idx: number) =>
      Math.hypot(hand.landmarks[idx].x - palm.x, hand.landmarks[idx].y - palm.y) / hand.scale;
    const indexTucked = reach(8) < 0.82;
    const middleTucked = reach(12) < 0.9;
    const ringTucked = reach(16) < 0.88;
    const pinkyTucked = reach(20) < 0.84;
    const longFingersTucked = indexTucked && middleTucked && ringTucked && pinkyTucked;
    const trackerAgrees = hand.openness < 0.62 && (profile ? profile.extendedCount <= 2 : true);
    return trackerAgrees && longFingersTucked;
  }

  private isOpenPalm(hand: HandSignals | null, profile: FingerProfile | null): boolean {
    if (!hand || hand.track === 'lost') return false;
    return hand.openness > 0.56 || (profile?.extendedCount ?? 0) >= 3;
  }

  private isCirclePalm(hand: HandSignals | null, profile: FingerProfile | null): boolean {
    if (!hand || hand.track === 'lost') return false;
    const extended = profile?.extendedCount ?? 0;
    return hand.openness > 0.56 || extended >= 3;
  }

  private isPointingHand(hand: HandSignals | null, profile: FingerProfile | null): boolean {
    if (!hand || hand.track === 'lost' || !profile || hand.landmarks.length < 21 || hand.scale <= 1) {
      return false;
    }
    const palm = hand.palm;
    const reach = (idx: number) =>
      Math.hypot(hand.landmarks[idx].x - palm.x, hand.landmarks[idx].y - palm.y) / hand.scale;

    const indexReach = reach(8);
    const middleReach = reach(12);
    const ringReach = reach(16);
    const pinkyReach = reach(20);
    const segment = (tipIdx: number, baseIdx: number) =>
      Math.hypot(
        hand.landmarks[tipIdx].x - hand.landmarks[baseIdx].x,
        hand.landmarks[tipIdx].y - hand.landmarks[baseIdx].y,
      ) / hand.scale;
    const indexSegment = segment(8, 5);
    const nonIndexFolded = !profile.middle && !profile.ring && !profile.pinky;
    const profilePoint =
      profile.index &&
      nonIndexFolded &&
      profile.extendedCount <= (profile.thumb ? 2 : 1);
    const segmentPoint =
      indexSegment > 0.58 &&
      nonIndexFolded &&
      indexReach > Math.max(middleReach, ringReach, pinkyReach) - 0.02 &&
      profile.extendedCount <= (profile.thumb ? 2 : 1);
    const edgeLineBias =
      this.isDiagonalLineZone(hand) &&
      indexSegment > 0.48 &&
      nonIndexFolded &&
      indexReach > Math.max(middleReach, ringReach, pinkyReach) - 0.1 &&
      profile.extendedCount <= (profile.thumb ? 2 : 1);
    const indexClearlyLeads =
      indexReach > 0.62 &&
      indexReach > middleReach + 0.02 &&
      indexReach > ringReach + 0.06 &&
      indexReach > pinkyReach + 0.06;

    return profilePoint || segmentPoint || edgeLineBias || (indexClearlyLeads && hand.openness < 0.74 && nonIndexFolded);
  }

  private isDiagonalLineZone(hand: HandSignals): boolean {
    const tip = hand.indexTip;
    const nearCorner =
      (tip.x < this.w * 0.3 || tip.x > this.w * 0.7) &&
      (tip.y < this.h * 0.34 || tip.y > this.h * 0.78);
    const nearEdgeDiagonal =
      (tip.x < this.w * 0.14 || tip.x > this.w * 0.86) &&
      (tip.y < this.h * 0.42 || tip.y > this.h * 0.62);
    const fastDiagonalReach =
      Math.hypot(hand.indexVel.x, hand.indexVel.y) > 680 &&
      Math.abs(hand.indexVel.x) > 150 &&
      Math.abs(hand.indexVel.y) > 150;

    return nearCorner || nearEdgeDiagonal || (hand.edgeClipped && fastDiagonalReach);
  }

  private isDirectionalLineHand(hand: HandSignals | null, profile: FingerProfile | null): boolean {
    if (!hand || hand.track === 'lost' || hand.landmarks.length < 21 || hand.scale <= 1) return false;

    const pointIntent = this.isPointingHand(hand, profile);
    const tip = hand.indexTip;
    const nearTopDiagonal = tip.y < this.h * 0.36 && (tip.x < this.w * 0.36 || tip.x > this.w * 0.64);
    const nearScreenEdge = tip.y < this.h * 0.18 || tip.y > this.h * 0.86 || tip.x < this.w * 0.12 || tip.x > this.w * 0.88;
    const speed = Math.hypot(hand.indexVel.x, hand.indexVel.y);
    const fastDiagonalReach = speed > 760 && Math.abs(hand.indexVel.x) > 180 && Math.abs(hand.indexVel.y) > 180;

    return pointIntent && (nearTopDiagonal || fastDiagonalReach || nearScreenEdge || this.isDiagonalLineZone(hand));
  }

  private getDesiredFormationCount(
    mode: FormationMode,
    hands: [HandSignals | null, HandSignals | null],
  ): number {
    if (mode === 'circle') {
      const ring = this.getCircleGeometry(hands);
      if (!ring) return 0;
      return this.targetCount;
    }

    if (mode === 'line') {
      const line = this.getLineGeometry(hands);
      if (!line) return 0;
      return this.targetCount;
    }

    if (mode === 'fists') return Math.min(this.targetCount, 9);
    return 0;
  }

  private seedCardNearFormation(
    c: Card,
    slot: number,
    n: number,
    hands: [HandSignals | null, HandSignals | null],
  ): void {
    const target = this.getFormationTarget(c, slot, n, hands);
    if (!target) return;

    const line = this.formationMode === 'line' ? this.getLineGeometry(hands) : null;
    const dropX = line ? -line.uy * 10 : 0;
    const dropY = line ? line.ux * 10 : 0;
    c.x = target.x + dropX;
    c.y = target.y + dropY;
    c.vx = 0;
    c.vy = 0;
    c.rot = target.rot;
    c.angVel = 0;
  }

  private selectFormation(
    hands: [HandSignals | null, HandSignals | null],
    profiles: [FingerProfile | null, FingerProfile | null],
  ): FormationIntent {
    const h0 = hands[0];
    const h1 = hands[1];
    const tracked0 = h0 && h0.track !== 'lost';
    const tracked1 = h1 && h1.track !== 'lost';

    if (tracked0 && tracked1 && h0 && h1) {
      const p0 = profiles[0];
      const p1 = profiles[1];
      const anyPinch = h0.pinching || h1.pinching;
      const anyHeld = this.cards.some((c) => c.held !== -1);
      const fullFist0 = this.isFullyClosedFist(h0, p0);
      const fullFist1 = this.isFullyClosedFist(h1, p1);
      const idx0 = this.isPointingHand(h0, p0);
      const idx1 = this.isPointingHand(h1, p1);
      const direct0 = this.isDirectionalLineHand(h0, p0);
      const direct1 = this.isDirectionalLineHand(h1, p1);
      const clearLine = (idx0 && idx1) || (idx0 && direct1) || (direct0 && idx1) || (direct0 && direct1);
      const lineHint = idx0 || idx1 || direct0 || direct1;
      const gridFists = fullFist0 && fullFist1;
      const circle0 = this.isCirclePalm(h0, p0);
      const circle1 = this.isCirclePalm(h1, p1);
      const clearCircle = circle0 && circle1;

      if (clearCircle) return { mode: 'circle', handIndex: 0 };
      if (clearLine) return { mode: 'line', handIndex: direct0 ? 0 : 1 };
      if (this.formationMode === 'line' && lineHint) return { mode: 'line', handIndex: direct0 ? 0 : 1 };
      if (gridFists) return { mode: 'fists', handIndex: 0 };

      if (!anyPinch || !anyHeld) {
        // TWO INDEX FINGERS -> LINE. This must win before fist detection,
        // because index-only hands can have low openness while the other
        // fingers are closed.
        if (direct0 || direct1) return { mode: 'line', handIndex: direct0 ? 0 : 1 };

        if (this.formationMode === 'line' && !gridFists && lineHint) {
          return { mode: 'line', handIndex: 0 };
        }

        // Circle hysteresis: when palms rotate sideways or move closer, openness
        // can dip. Keep shrinking the existing circle unless the user clearly points.
        if (this.formationMode === 'circle' && !gridFists && !direct0 && !direct1) {
          return { mode: 'circle', handIndex: 0 };
        }

        return { mode: 'none', handIndex: 0 };
      }
    }

    if (tracked0 && h0 && !tracked1) {
      const p0 = profiles[0];
      if (this.isDirectionalLineHand(h0, p0)) return { mode: 'line', handIndex: 0 };
      if (this.formationMode === 'line' && this.isPointingHand(h0, p0)) return { mode: 'line', handIndex: 0 };
    }

    if (tracked1 && h1 && !tracked0) {
      const p1 = profiles[1];
      if (this.isDirectionalLineHand(h1, p1)) return { mode: 'line', handIndex: 1 };
      if (this.formationMode === 'line' && this.isPointingHand(h1, p1)) return { mode: 'line', handIndex: 1 };
    }

    return { mode: 'none', handIndex: 0 };
  }

  private getFormationTarget(
    c: Card,
    slot: number,
    n: number,
    hands: [HandSignals | null, HandSignals | null],
  ): FormationTarget | null {
    if (n <= 0) return null;

    if (this.formationMode === 'circle') {
      const ring = this.getCircleGeometry(hands);
      if (!ring) return null;

      // Continuous swirl: the whole ring rotates rigidly so cards visibly circle
      // each other. Each card keeps its stable base angle (orbitAngle) -> no slot
      // wrap-jumps, the entire ring just spins.
      const swirl = this.formationTime * 1.28;
      const angle = (slot / n) * Math.PI * 2 + swirl - Math.PI * 0.5;

      const x = ring.cx + Math.cos(angle) * ring.rx;
      const y = ring.cy + Math.sin(angle) * ring.ry;

      c.formDepth = 1;
      c.formScale = clamp(0.82 + ring.rx / 1500, 0.84, 1.04);
      const rot = Math.cos(angle) * 0.08 + c.shardRot;
      const snap = this.circleSnapT > 0;
      return { x, y, rot, stiffness: snap ? 820 : 680, damping: snap ? 64 : 58 };
    }

    if (this.formationMode === 'fists') {
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') return null;

      const cols = 3;
      const rows = 3;
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const avgScale = (h0.scale + h1.scale) * 0.5;
      const spacingX = clamp(c.w + avgScale * 0.06, 64, 82);
      const spacingY = clamp(c.h + avgScale * 0.04, 78, 96);
      const cx = (h0.palm.x + h1.palm.x) * 0.5;
      const cy = (h0.palm.y + h1.palm.y) * 0.5 - clamp(avgScale * 0.14, 12, 34);
      const x = cx + (col - 1) * spacingX;
      const y = cy + (row - 1) * spacingY;
      const layer = row / Math.max(1, rows - 1);
      c.formDepth = 0.98 + layer * 0.04;
      c.formScale = 1;
      return {
        x,
        y,
        rot: (col - 1) * 0.018 + (row - 1) * 0.012 + c.shardRot,
        stiffness: 680,
        damping: 58,
      };
    }

    if (this.formationMode === 'line') {
      const line = this.getLineGeometry(hands);
      if (!line) return null;
      const { ax, ay, bx, by, ux, uy } = line;
      const dx = bx - ax;
      const dy = by - ay;
      const px = -uy;
      const py = ux;
      const tt = n === 1 ? 0.5 : 0.06 + (slot / (n - 1)) * 0.88;  // small inset so ends aren't cramped
      // Keep line cards locked to the finger axis. Extra shimmer makes the
      // guide look detached during fast length changes.
      const along = 0;
      const wave = 0;
      c.formScale = 0.92;
      return {
        x: ax + dx * tt + ux * along + px * wave,
        y: ay + dy * tt + uy * along + py * wave,
        rot: Math.atan2(uy, ux) + c.shardRot,
        stiffness: 1180,
        damping: 78,
      };
    }

    return null;
  }

  private getLineGeometry(hands: [HandSignals | null, HandSignals | null]): LineGeometry | null {
    const h0 = hands[0];
    const h1 = hands[1];
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;

    if (h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost') {
      const dx = h1.indexTip.x - h0.indexTip.x;
      const dy = h1.indexTip.y - h0.indexTip.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const pad = clamp(len * 0.16, 32, 120);
      ax = h0.indexTip.x - ux * pad;
      ay = h0.indexTip.y - uy * pad;
      bx = h1.indexTip.x + ux * pad;
      by = h1.indexTip.y + uy * pad;
    } else {
      const hand = hands[this.formationHand];
      if (!hand || hand.track === 'lost') return null;
      const wrist = hand.landmarks[0] ?? hand.palm;
      let ux = hand.indexTip.x - wrist.x;
      let uy = hand.indexTip.y - wrist.y;
      let len = Math.hypot(ux, uy);
      if (len < hand.scale * 0.38) {
        ux = hand.indexTip.x - this.w * 0.5;
        uy = hand.indexTip.y - this.h * 0.5;
        len = Math.hypot(ux, uy);
      }
      len ||= 1;
      ux /= len;
      uy /= len;
      const lineLen = clamp(hand.scale * 5.8, 360, 740);
      const cx = hand.indexTip.x + ux * hand.scale * 0.38;
      const cy = hand.indexTip.y + uy * hand.scale * 0.38;
      ax = cx - ux * lineLen * 0.5;
      ay = cy - uy * lineLen * 0.5;
      bx = cx + ux * lineLen * 0.5;
      by = cy + uy * lineLen * 0.5;
    }

    const rawDx = bx - ax;
    const rawDy = by - ay;
    if (Math.abs(rawDx) > 180 && Math.abs(rawDy) < Math.abs(rawDx) * 0.22) {
      const y = (ay + by) * 0.5;
      ay = y;
      by = y;
    }

    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    return { ax, ay, bx, by, ux: dx / len, uy: dy / len, len };
  }

  private getCircleGeometry(hands: [HandSignals | null, HandSignals | null]): {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
  } | null {
    const h0 = hands[0];
    const h1 = hands[1];
    if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') return null;

    const rawDist = Math.hypot(
      h1.palm.x - h0.palm.x,
      h1.palm.y - h0.palm.y,
    );
    const smoothDist = this.twoHandActive
      ? (this.circleSnapT > 0 ? this.twoHandRawPalmDist : this.twoHandPalmDist)
      : rawDist;
    const avgScale = (h0.scale + h1.scale) * 0.5;
    const cx = this.twoHandActive ? this.twoHandMidX : (h0.palm.x + h1.palm.x) * 0.5;
    const cy = this.twoHandActive ? this.twoHandMidY : (h0.palm.y + h1.palm.y) * 0.5;
    const openR = clamp((smoothDist - clamp(avgScale * 0.2, 22, 48)) * 0.58, 118, 318);
    const collapse = this.formationMode === 'circle' ? 0 : this.clapT;
    const r = 6 + (openR - 6) * (1 - collapse * 0.96);
    const rx = r;
    const ry = r;

    return { cx, cy, rx, ry };
  }

  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
    const palette = PALETTES[this.config.palette];

    // 1. Full mirrored webcam background
    ctx.save();
    ctx.translate(this.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, this.w, this.h);
    ctx.restore();

    // 2. Palette dim treatment
    ctx.fillStyle = palette.bgTreatment;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, this.w, this.h);

    // 3. Fire-trail canvas (screen = black is transparent)
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.trailCanvas, 0, 0);
    this.embers.draw(ctx, this.emberSprite);
    ctx.globalCompositeOperation = 'source-over';

    // 3.5 Formation HUD (behind cards, so cards sit ON the geometry)
    this.drawFormationHud(ctx);

    // Video sample scale (canvas-space -> true video pixels)
    const scaleX = video.videoWidth / this.w;
    const scaleY = video.videoHeight / this.h;
    // 4. Cards. Fist grid keeps light depth sorting; circle stays flat on screen.
    const drawList = this.formationMode === 'fists' && this.formationAlpha > 0.05
      ? [...this.cards].sort((a, b) => a.formDepth - b.formDepth)
      : this.cards;
    for (const c of drawList) {
      const pop = easeOutBack(c.spawnT) * c.formDepth * c.formScale;
      const cardAlpha = (1 - this.clapT) * c.formAlpha;
      if (pop <= 0.01 || cardAlpha <= 0.01) continue;

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(pop, pop);
      ctx.globalAlpha = cardAlpha;

      const hw = c.w / 2;
      const hh = c.h / 2;
      const radius = Math.min(12, Math.max(9, c.w * 0.2));

      // Clip to card silhouette
      roundRectPath(ctx, -hw, -hh, c.w, c.h, radius);
      ctx.save();
      ctx.clip();

      // Live mirrored video slice
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(
        video,
        c.srcX * scaleX, c.srcY * scaleY, c.srcW * scaleX, c.srcH * scaleY,
        -hw, -hh, c.w, c.h,
      );
      ctx.restore();

      // Inner palette tint
      ctx.fillStyle = palette.bgTreatment;
      ctx.fillRect(-hw, -hh, c.w, c.h);
      ctx.fillStyle = 'rgba(3,7,12,0.13)';
      ctx.fillRect(-hw, -hh, c.w, c.h);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.12 * cardAlpha;
      ctx.fillStyle = c.accent;
      ctx.fillRect(-hw, -hh, c.w, c.h);
      const glassGlow = ctx.createLinearGradient(-hw, -hh, hw, hh);
      glassGlow.addColorStop(0, 'rgba(255,255,255,0.42)');
      glassGlow.addColorStop(0.2, 'rgba(255,255,255,0.14)');
      glassGlow.addColorStop(0.62, 'rgba(255,255,255,0.035)');
      glassGlow.addColorStop(1, 'rgba(255,255,255,0.2)');
      ctx.globalAlpha = cardAlpha;
      ctx.fillStyle = glassGlow;
      ctx.fillRect(-hw, -hh, c.w, c.h);
      ctx.globalAlpha = cardAlpha;
      ctx.globalCompositeOperation = 'source-over';

      // Glass sheen — slides with rotation
      if (this.useSheen) {
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.3 * cardAlpha;
        const off = Math.sin(c.rot * 1.5 + c.seed) * hw * 0.6;
        ctx.drawImage(this.sheen, -hw + off, -hh, c.w, c.h);
        ctx.globalAlpha = cardAlpha;
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.5 * cardAlpha;
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-hw + radius, -hh + 2);
      ctx.lineTo(hw - radius, -hh + 2);
      ctx.stroke();
      ctx.globalAlpha = 0.3 * cardAlpha;
      ctx.beginPath();
      ctx.moveTo(-hw + 2, -hh + radius);
      ctx.lineTo(-hw + 2, hh - radius);
      ctx.stroke();
      ctx.globalAlpha = 0.16 * cardAlpha;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(-hw + radius, hh - 2);
      ctx.lineTo(hw - radius, hh - 2);
      ctx.stroke();
      ctx.globalAlpha = cardAlpha;
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore(); // undo clip

      // Border + glow (re-path; clip is gone)
      roundRectPath(ctx, -hw, -hh, c.w, c.h, radius);

      if (c.fire > 0.05) {
        ctx.strokeStyle = lerpColor(this.primary, this.emberColor, c.fire);
        ctx.lineWidth = 2 + c.fire * 2;
        if (this.useShadow) { ctx.shadowBlur = 14 + c.fire * 26; ctx.shadowColor = this.emberColor; }
      } else {
        ctx.strokeStyle = lerpColor(c.accent, this.primary, 0.28);
        ctx.lineWidth = 1.25;
        if (this.useShadow) { ctx.shadowBlur = 18; ctx.shadowColor = c.accent; }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (c.fire <= 0.05) {
        roundRectPath(ctx, -hw + 1.5, -hh + 1.5, c.w - 3, c.h - 3, Math.max(6, radius - 2));
        ctx.globalAlpha = 0.54 * cardAlpha;
        ctx.strokeStyle = 'rgba(255,255,255,0.78)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.globalAlpha = cardAlpha;
      }

      ctx.restore();
    }

    // 5. Hand visualization — subtle palette glow + fingertip sparkles
    this.drawHands(ctx);

    // 6. Lightweight mode readout, matching the reference screenshots.
    this.drawModeHud(ctx);
  }
  private shardPath(ctx: CanvasRenderingContext2D, c: Card): void {
    const hw = c.w / 2;
    const hh = c.h / 2;
    // Slightly irregular quad (deterministic from seed)
    const j = (n: number) => (Math.sin(c.seed + n) * 0.18);
    ctx.beginPath();
    ctx.moveTo(-hw * (1 + j(1)), -hh * (1 - j(2)));
    ctx.lineTo(hw * (1 - j(3)), -hh * (1 + j(4)));
    ctx.lineTo(hw * (1 + j(5)), hh * (1 - j(6)));
    ctx.lineTo(-hw * (1 - j(7)), hh * (1 + j(8)));
    ctx.closePath();
  }

  private drawFormationHud(ctx: CanvasRenderingContext2D): void {
    const a = this.formationAlpha * this.lastRamp;
    if (a <= 0.01) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    if (this.useShadow) { ctx.shadowBlur = 12; ctx.shadowColor = this.glow; }

    if (this.formationMode === 'line') {
      const line = this.getLineGeometry(this.latestHands);
      if (!line) { ctx.restore(); return; }
      const { ax, ay, bx, by, len } = line;
      const dx = bx - ax;
      const dy = by - ay;
      const px = -dy / len;
      const py = dx / len;
      ctx.strokeStyle = `rgba(255,255,255,${0.22 * a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.08 * a})`;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(ax + px * 0.5, ay + py * 0.5);
      ctx.lineTo(bx + px * 0.5, by + py * 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (this.formationMode === 'circle') {
      const ring = this.getCircleGeometry(this.latestHands);
      if (!ring) { ctx.restore(); return; }
      const swirl = this.formationTime * 1.5;
      ctx.strokeStyle = `rgba(255,255,255,${0.24 * a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(ring.cx, ring.cy, ring.rx, ring.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Rotating tick marks ride the swirl so the ring reads as spinning.
      ctx.globalAlpha = 0.18 * a;
      ctx.strokeStyle = this.glow;
      const ticks = Math.max(1, this.formationN);
      for (let i = 0; i < ticks; i++) {
        const ang = (i / ticks) * Math.PI * 2 + swirl;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(ring.cx + ca * (ring.rx - 10), ring.cy + sa * (ring.ry - 6));
        ctx.lineTo(ring.cx + ca * (ring.rx + 10), ring.cy + sa * (ring.ry + 6));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  private drawHands(ctx: CanvasRenderingContext2D): void {
    ctx.globalCompositeOperation = 'screen';
    for (let hi = 0; hi < 2; hi++) {
      const hand = this.latestHands[hi];
      if (!hand || hand.track === 'lost' || hand.landmarks.length < 21) continue;

      // Palm glow scaled by hand size
      const r = Math.max(120, hand.scale * 2.2);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(this.palmGlow, hand.palm.x - r, hand.palm.y - r, r * 2, r * 2);

      // Fingertip sparkles (4,8,12,16,20)
      const tips = [4, 8, 12, 16, 20];
      for (const ti of tips) {
        const lm = hand.landmarks[ti];
        const bright = ti === 8 && hand.pinching ? 1 : 0.55;
        const s = ti === 8 && hand.pinching ? 40 : 26;
        ctx.globalAlpha = bright;
        ctx.drawImage(this.fingerSpark, lm.x - s / 2, lm.y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawModeHud(ctx: CanvasRenderingContext2D): void {
    const handsVisible = this.latestHands.reduce((n, hand) => n + (hand && hand.track !== 'lost' ? 1 : 0), 0);
    const energy = Math.round(clamp(this.formationAlpha, 0, 1) * 100);
    const palmDistance = this.twoHandActive ? Math.round(this.twoHandPalmDist / Math.max(1, this.w) * 100) / 100 : 0;
    const mode =
      this.formationMode === 'circle' ? 'CODEX GLITCH CIRCLE SWIRL' :
      this.formationMode === 'line' ? 'CODEX GLITCH CARD LINE' :
      this.formationMode === 'fists' ? 'CODEX GLITCH 3X3 GRID' :
      'CODEX GLITCH FIELD';

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '700 12px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.shadowColor = 'rgba(255,255,255,0.38)';
    ctx.shadowBlur = 8;
    ctx.fillText(mode, 12, 22);
    ctx.font = '700 11px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    ctx.fillText(`HANDS ${handsVisible}  ·  PALM DISTANCE ${palmDistance.toFixed(2)}  ·  ENERGY ${energy}%`, 12, 42);
    ctx.font = '700 10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('OPEN PALMS FOR CIRCLE · TWO INDEX-ONLY FINGERS FOR LINE · TWO FISTS FOR 3X3 GRID', 12, 62);
    ctx.restore();
  }

  gracefulRelease(handIndex: number): void {
    // Drop held cards DEAD — zero velocity so no phantom fling, and let fire die.
    for (const c of this.cards) {
      if (c.held === handIndex) {
        c.held = -1;
        c.vx = 0;
        c.vy = 0;
        c.angVel = 0;
      }
    }
  }

  getActiveCount(): number {
    return this.cards.length;
  }

  stepDownQuality(): void {
    // Tier 1: kill all shadowBlur (the most expensive Canvas op)
    if (this.useShadow) { this.useShadow = false; return; }
    // Tier 2: drop sheen only. Never delete cards; formations must stay dense.
    if (this.useSheen) { this.useSheen = false; return; }
  }
}
