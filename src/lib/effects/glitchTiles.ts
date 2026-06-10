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

  bridgeSlot: number; // slot index in the index↔index tether bridge, -1 if not in formation
  formationSlot: number;
}

type FormationMode = 'none' | 'line' | 'circle' | 'square' | 'pack';

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

const RING_R = 185;          // orbit ring radius around palm (px)
const GRAB_R = 150;          // how close indexTip must be to grab a free card
const FIRE_SPEED = 900;      // px/s throw speed that fully ignites a card
const WALL_RESTITUTION = 0.55;
const FORMATION_SHATTER_SPEED = 480;

export class GlitchTilesEffect implements VfxEffect {
  readonly effectIncludesVideo = true;

  private config!: GlitchTilesConfig;
  private w = 0;
  private h = 0;
  private cards: Card[] = [];
  private targetCount = 12;

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

  // Readable gesture formations: index line, two-index circle, thumb/index square, fist pack/drop.
  private formationMode: FormationMode = 'none';
  private formationAlpha = 0;
  private formationHand = 0;
  private formationTime = 0;
  private formationN = 0;
  private shatterCooldown = 0;
  private lastRamp = 0;
  private circleSpinAngle = 0;

  // Quality tiers (one-way)
  private useShadow = true;
  private useSheen = true;

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'glitch_tiles') throw new Error('Wrong config');
    this.config = config as GlitchTilesConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    const palette = PALETTES[config.palette];
    this.primary = palette.primary;
    this.glow = palette.glow;

    this.targetCount = config.intensity === 1 ? 8 : config.intensity === 2 ? 12 : 16;

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

    // Card silhouette per shape
    let baseW = 118;
    let baseH = 118;
    if (tileShape === 'wide') { baseW = 176; baseH = 104; }

    // Spread the live video sample regions across the frame so faces / motion
    // appear inside the cards (rather than every card showing the same spot).
    const cols = Math.ceil(Math.sqrt(this.targetCount * (this.w / this.h)));
    const rows = Math.ceil(this.targetCount / cols);
    const cellW = this.w / cols;
    const cellH = this.h / rows;

    for (let i = 0; i < this.targetCount; i++) {
      const gx = i % cols;
      const gy = Math.floor(i / cols);

      const srcW = baseW * 1.1;
      const srcH = baseH * 1.1;
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
        shardRot: tileShape === 'shard' ? (Math.random() - 0.5) * 0.5 : 0,
        held: -1,
        grabDX: 0,
        grabDY: 0,
        spawnT: 0,
        fire: 0,
        seed: Math.random() * 1000,
        bridgeSlot: -1,
        formationSlot: -1,
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
    if (this.shatterCooldown > 0) this.shatterCooldown = Math.max(0, this.shatterCooldown - dt);

    const profiles: [FingerProfile | null, FingerProfile | null] = [
      this.getFingerProfile(hands[0]),
      this.getFingerProfile(hands[1]),
    ];
    const intent = this.shatterCooldown > 0 ? { mode: 'none' as FormationMode, handIndex: 0 } : this.selectFormation(hands, profiles);
    if (intent.mode !== this.formationMode || intent.handIndex !== this.formationHand) {
      this.formationMode = intent.mode;
      this.formationHand = intent.handIndex;
      this.formationTime = 0;
    }
    this.formationTime += dt;
    if (this.formationMode === 'circle' && hands[0] && hands[1]) {
      const dx = hands[1].indexTip.x - hands[0].indexTip.x;
      const dy = hands[1].indexTip.y - hands[0].indexTip.y;
      const handDist = Math.hypot(dx, dy);
      const spinFactor = clamp((handDist - 80) / 250, 0, 1.5);
      const spinSpeed = spinFactor * 2.5;
      this.circleSpinAngle += spinSpeed * dt;
    } else if (this.formationMode !== 'circle') {
      this.circleSpinAngle *= expDamp(2, dt);
    }
    const targetFormationAlpha = intent.mode === 'none' ? 0 : ramp;
    this.formationAlpha += (targetFormationAlpha - this.formationAlpha) * (1 - expDamp(9, dt));

    // Reset and assign stable formation slots. Sorting by current screen-space
    // projection keeps cards from crossing through each other on mode changes.
    for (const c of this.cards) {
      c.bridgeSlot = -1;
      c.formationSlot = -1;
    }
    const forming = this.formationMode !== 'none' && this.formationAlpha > 0.03;
    if (forming) {
      const eligible = this.cards.filter((c) => c.held === -1 && c.fire < 0.08);
      const sortHand = hands[this.formationHand];
      if ((this.formationMode === 'line' || this.formationMode === 'circle') && hands[0] && hands[1]) {
        const ax = hands[0]!.indexTip.x;
        const ay = hands[0]!.indexTip.y;
        const dx = hands[1]!.indexTip.x - ax;
        const dy = hands[1]!.indexTip.y - ay;
        eligible.sort((a, b) => ((a.x - ax) * dx + (a.y - ay) * dy) - ((b.x - ax) * dx + (b.y - ay) * dy));
      } else if (sortHand) {
        eligible.sort((a, b) => Math.atan2(a.y - sortHand.palm.y, a.x - sortHand.palm.x) - Math.atan2(b.y - sortHand.palm.y, b.x - sortHand.palm.x));
      }
      for (let i = 0; i < eligible.length; i++) eligible[i].formationSlot = i;
      this.formationN = eligible.length;
    } else {
      this.formationN = 0;
    }

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
          if (speed > FIRE_SPEED) c.fire = Math.min(1, speed / (FIRE_SPEED * 1.6));
        }
      }

      if (hand.pinchJustEnded && this.formationMode !== 'none' && this.formationAlpha > 0.35) {
        this.shatterFormation(hi, hand);
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
    const thumb = ratio(4) > 0.78;
    const index = ratio(8) > 1.02;
    const middle = ratio(12) > 1.02;
    const ring = ratio(16) > 0.98;
    const pinky = ratio(20) > 0.92;
    const extendedCount = Number(thumb) + Number(index) + Number(middle) + Number(ring) + Number(pinky);
    return { thumb, index, middle, ring, pinky, extendedCount };
  }

  private selectFormation(
    hands: [HandSignals | null, HandSignals | null],
    profiles: [FingerProfile | null, FingerProfile | null],
  ): FormationIntent {
    const tracked0 = hands[0] && hands[0]!.track !== 'lost';
    const tracked1 = hands[1] && hands[1]!.track !== 'lost';

    if (tracked0 && tracked1 && hands[0] && hands[1]) {
      const p0 = profiles[0];
      const p1 = profiles[1];
      const indexDx = hands[1].indexTip.x - hands[0].indexTip.x;
      const indexDy = hands[1].indexTip.y - hands[0].indexTip.y;
      const indexDist = Math.hypot(indexDx, indexDy);
      const bothOpen = hands[0].openness > 0.7 && hands[1].openness > 0.7;
      const bothIndex = !!(p0?.index && p1?.index);
      const bothFist = hands[0].openness < 0.32 && hands[1].openness < 0.32;

      if (bothFist) return { mode: 'pack', handIndex: 0 };
      if (bothOpen && indexDist > 130) return { mode: 'line', handIndex: 0 };
      if (bothIndex && indexDist > 45) return { mode: 'circle', handIndex: 0 };
    }

    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      const profile = profiles[hi];
      if (!hand || hand.track === 'lost' || !profile) continue;

      if (hand.openness < 0.32 && profile.extendedCount <= 1) return { mode: 'pack', handIndex: hi };

      const foldedBackFingers = Number(!profile.middle) + Number(!profile.ring) + Number(!profile.pinky);
      const lShape = profile.thumb && profile.index && foldedBackFingers >= 2 && hand.pinch > 0.45;
      if (lShape) return { mode: 'square', handIndex: hi };

      const indexOnly = profile.index && !profile.middle && !profile.ring && !profile.pinky;
      if (indexOnly || (profile.index && profile.extendedCount <= 2)) return { mode: 'line', handIndex: hi };
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
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') return null;
      const cx = (h0.indexTip.x + h1.indexTip.x) * 0.5;
      const cy = (h0.indexTip.y + h1.indexTip.y) * 0.5;
      const dx = h1.indexTip.x - h0.indexTip.x;
      const dy = h1.indexTip.y - h0.indexTip.y;
      const handDist = Math.hypot(dx, dy) || 1;
      const angle = (slot / n) * Math.PI * 2 - Math.PI / 2 + this.circleSpinAngle;
      const r = clamp((handDist - 60) * 0.55, 15, 260);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      const tangentRot = angle + Math.PI / 2;
      return { x, y, rot: tangentRot + c.shardRot, stiffness: 230, damping: 30 };
    }

    const hand = hands[this.formationHand];
    if (!hand || hand.track === 'lost') return null;

    if (this.formationMode === 'line') {
      let ax: number;
      let ay: number;
      let bx: number;
      let by: number;

      const h0 = hands[0];
      const h1 = hands[1];
      if (h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost') {
        ax = h0.indexTip.x;
        ay = h0.indexTip.y;
        bx = h1.indexTip.x;
        by = h1.indexTip.y;
      } else {
        const wrist = hand.landmarks[0] ?? hand.palm;
        let ux = hand.indexTip.x - wrist.x;
        let uy = hand.indexTip.y - wrist.y;
        const len = Math.hypot(ux, uy) || 1;
        ux /= len; uy /= len;
        const lineLen = clamp(hand.scale * 4.0, 260, 520);
        const cx = hand.indexTip.x + ux * hand.scale * 0.55;
        const cy = hand.indexTip.y + uy * hand.scale * 0.55;
        ax = cx - ux * lineLen * 0.5;
        ay = cy - uy * lineLen * 0.5;
        bx = cx + ux * lineLen * 0.5;
        by = cy + uy * lineLen * 0.5;
      }

      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const px = -uy;
      const py = ux;
      const tt = n === 1 ? 0.5 : slot / (n - 1);
      const wave = Math.sin(tt * Math.PI * 2 + this.formationTime * 3) * 2.5;
      return {
        x: ax + dx * tt + px * wave,
        y: ay + dy * tt + py * wave,
        rot: Math.atan2(uy, ux) + c.shardRot,
        stiffness: 240,
        damping: 31,
      };
    }

    if (this.formationMode === 'square') {
      const thumb = hand.landmarks[4] ?? hand.palm;
      const index = hand.landmarks[8] ?? hand.indexTip;
      let ux = index.x - thumb.x;
      let uy = index.y - thumb.y;
      const uLen = Math.hypot(ux, uy) || 1;
      ux /= uLen; uy /= uLen;
      const vx = -uy;
      const vy = ux;
      const side = clamp(Math.max(uLen * 2.15, hand.scale * 2.3), 180, 360);
      const cx = (thumb.x + index.x) * 0.5 + ux * side * 0.18;
      const cy = (thumb.y + index.y) * 0.5 + uy * side * 0.18;
      const perSide = Math.max(1, Math.ceil(n / 4));
      const edge = Math.floor(slot / perSide) % 4;
      const local = ((slot % perSide) + 0.5) / perSide;
      let ox = 0;
      let oy = 0;
      if (edge === 0) { ox = -side * 0.5 + local * side; oy = -side * 0.5; }
      else if (edge === 1) { ox = side * 0.5; oy = -side * 0.5 + local * side; }
      else if (edge === 2) { ox = side * 0.5 - local * side; oy = side * 0.5; }
      else { ox = -side * 0.5; oy = side * 0.5 - local * side; }
      const x = cx + ux * ox + vx * oy;
      const y = cy + uy * ox + vy * oy;
      const rot = Math.atan2(uy, ux) + (edge % 2 === 0 ? 0 : Math.PI / 2) + c.shardRot;
      return { x, y, rot, stiffness: 245, damping: 32 };
    }

    if (this.formationMode === 'pack') {
      const cols = Math.ceil(Math.sqrt(n));
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const spacing = clamp(hand.scale * 0.28, 22, 42);
      const fall = Math.min(140, this.formationTime * 180);
      const jitter = Math.sin(c.seed + this.formationTime * 5) * 2;
      const cx = hand.palm.x;
      const cy = hand.palm.y + hand.scale * 0.55 + fall;
      const x = cx + (col - (cols - 1) * 0.5) * spacing + jitter;
      const y = cy + (row - (Math.ceil(n / cols) - 1) * 0.5) * spacing + jitter;
      return { x, y, rot: c.shardRot + (slot - n * 0.5) * 0.03, stiffness: 150, damping: 18 };
    }

    return null;
  }

  private shatterFormation(handIndex: number, hand: HandSignals): void {
    this.shatterCooldown = 0.38;
    this.formationAlpha = 0;
    this.formationMode = 'none';
    const speed = Math.hypot(hand.indexVel.x, hand.indexVel.y);
    const impulseX = hand.indexVel.x * 0.85;
    const impulseY = hand.indexVel.y * 0.85;

    for (const c of this.cards) {
      if (c.held !== -1) continue;
      const dx = c.x - hand.palm.x;
      const dy = c.y - hand.palm.y;
      const len = Math.hypot(dx, dy) || 1;
      const radial = FORMATION_SHATTER_SPEED + Math.random() * 360 + speed * 0.18;
      c.formationSlot = -1;
      c.bridgeSlot = -1;
      c.vx = impulseX + (dx / len) * radial + (Math.random() - 0.5) * 180;
      c.vy = impulseY + (dy / len) * radial + (Math.random() - 0.5) * 180;
      c.angVel = (Math.random() - 0.5) * 18 + (c.vx > 0 ? 1 : -1) * 3;
      c.fire = Math.max(c.fire, clamp(speed / (FIRE_SPEED * 1.4), 0.25, 1));
    }
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

    // 3. Fire-trail canvas (screen = black is transparent)
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.trailCanvas, 0, 0);
    this.embers.draw(ctx, this.emberSprite);
    ctx.globalCompositeOperation = 'source-over';

    // 3.5 Formation HUD (behind cards, so cards sit ON the geometry)
    this.drawFormationHud(ctx);

    // Video sample scale (canvas-space → true video pixels)
    const scaleX = video.videoWidth / this.w;
    const scaleY = video.videoHeight / this.h;
    const isShard = this.config.params.tileShape === 'shard';

    // 4. Cards
    for (const c of this.cards) {
      const pop = easeOutBack(c.spawnT);
      if (pop <= 0.01) continue;

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(pop, pop);

      const hw = c.w / 2;
      const hh = c.h / 2;

      // Clip to card silhouette
      if (isShard) {
        this.shardPath(ctx, c);
      } else {
        roundRectPath(ctx, -hw, -hh, c.w, c.h, 14);
      }
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

      // Glass sheen — slides with rotation
      if (this.useSheen) {
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.18;
        const off = Math.sin(c.rot * 1.5 + c.seed) * hw * 0.6;
        ctx.drawImage(this.sheen, -hw + off, -hh, c.w, c.h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore(); // undo clip

      // Border + glow (re-path; clip is gone)
      if (isShard) this.shardPath(ctx, c);
      else roundRectPath(ctx, -hw, -hh, c.w, c.h, 14);

      if (c.fire > 0.05) {
        ctx.strokeStyle = lerpColor(this.primary, this.emberColor, c.fire);
        ctx.lineWidth = 2 + c.fire * 2;
        if (this.useShadow) { ctx.shadowBlur = 14 + c.fire * 26; ctx.shadowColor = this.emberColor; }
      } else {
        ctx.strokeStyle = this.primary;
        ctx.lineWidth = 2;
        if (this.useShadow) { ctx.shadowBlur = 12; ctx.shadowColor = this.glow; }
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.restore();
    }

    // 5. Hand visualization — subtle palette glow + fingertip sparkles
    this.drawHands(ctx);
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
      const h0 = this.latestHands[0];
      const h1 = this.latestHands[1];
      let ax = 0, ay = 0, bx = 0, by = 0;
      if (h0 && h1 && h0.track !== 'lost' && h1.track !== 'lost') {
        ax = h0.indexTip.x; ay = h0.indexTip.y;
        bx = h1.indexTip.x; by = h1.indexTip.y;
      } else {
        const hand = this.latestHands[this.formationHand];
        if (!hand || hand.track === 'lost') { ctx.restore(); return; }
        const wrist = hand.landmarks[0] ?? hand.palm;
        let ux = hand.indexTip.x - wrist.x;
        let uy = hand.indexTip.y - wrist.y;
        const len = Math.hypot(ux, uy) || 1;
        ux /= len; uy /= len;
        const lineLen = clamp(hand.scale * 4.0, 260, 520);
        const cx = hand.indexTip.x + ux * hand.scale * 0.55;
        const cy = hand.indexTip.y + uy * hand.scale * 0.55;
        ax = cx - ux * lineLen * 0.5; ay = cy - uy * lineLen * 0.5;
        bx = cx + ux * lineLen * 0.5; by = cy + uy * lineLen * 0.5;
      }

      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const px = -dy / len;
      const py = dx / len;
      ctx.strokeStyle = `rgba(255,255,255,${0.68 * a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = this.glow;
      ctx.globalAlpha = 0.36 * a;
      for (let i = 0; i < this.formationN; i++) {
        const tt = this.formationN <= 1 ? 0.5 : i / (this.formationN - 1);
        const x = ax + dx * tt;
        const y = ay + dy * tt;
        ctx.beginPath();
        ctx.moveTo(x - px * 9, y - py * 9);
        ctx.lineTo(x + px * 9, y + py * 9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (this.formationMode === 'circle') {
      const h0 = this.latestHands[0];
      const h1 = this.latestHands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') { ctx.restore(); return; }
      const cx = (h0.indexTip.x + h1.indexTip.x) * 0.5;
      const cy = (h0.indexTip.y + h1.indexTip.y) * 0.5;
      const dist = Math.hypot(h1.indexTip.x - h0.indexTip.x, h1.indexTip.y - h0.indexTip.y);
      const r = clamp((dist - 60) * 0.55, 15, 260);
      ctx.strokeStyle = `rgba(255,255,255,${0.62 * a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.35 * a;
      ctx.strokeStyle = this.glow;
      for (let i = 0; i < this.formationN; i++) {
        const ang = (i / Math.max(1, this.formationN)) * Math.PI * 2 - Math.PI / 2 + this.circleSpinAngle;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * (r - 10), cy + Math.sin(ang) * (r - 10));
        ctx.lineTo(cx + Math.cos(ang) * (r + 10), cy + Math.sin(ang) * (r + 10));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else {
      const hand = this.latestHands[this.formationHand];
      if (!hand || hand.track === 'lost') { ctx.restore(); return; }

      if (this.formationMode === 'square') {
        const thumb = hand.landmarks[4] ?? hand.palm;
        const index = hand.landmarks[8] ?? hand.indexTip;
        let ux = index.x - thumb.x;
        let uy = index.y - thumb.y;
        const uLen = Math.hypot(ux, uy) || 1;
        ux /= uLen; uy /= uLen;
        const vx = -uy;
        const vy = ux;
        const side = clamp(Math.max(uLen * 2.15, hand.scale * 2.3), 180, 360);
        const cx = (thumb.x + index.x) * 0.5 + ux * side * 0.18;
        const cy = (thumb.y + index.y) * 0.5 + uy * side * 0.18;
        const corners = [
          { x: cx + ux * -side * 0.5 + vx * -side * 0.5, y: cy + uy * -side * 0.5 + vy * -side * 0.5 },
          { x: cx + ux * side * 0.5 + vx * -side * 0.5, y: cy + uy * side * 0.5 + vy * -side * 0.5 },
          { x: cx + ux * side * 0.5 + vx * side * 0.5, y: cy + uy * side * 0.5 + vy * side * 0.5 },
          { x: cx + ux * -side * 0.5 + vx * side * 0.5, y: cy + uy * -side * 0.5 + vy * side * 0.5 },
        ];
        ctx.strokeStyle = `rgba(255,255,255,${0.32 * a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.stroke();
        ctx.strokeStyle = this.glow;
        ctx.globalAlpha = 0.25 * a;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        ctx.lineTo(corners[2].x, corners[2].y);
        ctx.moveTo(corners[1].x, corners[1].y);
        ctx.lineTo(corners[3].x, corners[3].y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (this.formationMode === 'pack') {
        const cx = hand.palm.x;
        const cy = hand.palm.y + hand.scale * 0.55 + Math.min(140, this.formationTime * 180);
        const r = clamp(hand.scale * 0.75, 55, 105);
        ctx.strokeStyle = `rgba(255,255,255,${0.45 * a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.3 * a;
        ctx.beginPath();
        ctx.moveTo(cx, hand.palm.y);
        ctx.lineTo(cx, cy + r);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
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
    return this.cards.length + this.embers.getAliveCount();
  }

  stepDownQuality(): void {
    // Tier 1: kill all shadowBlur (the most expensive Canvas op)
    if (this.useShadow) { this.useShadow = false; return; }
    // Tier 2: drop the sheen pass + halve ember pool
    if (this.useSheen) { this.useSheen = false; this.embers.halve(); return; }
    // Tier 3: despawn the 4 cards farthest from any hand
    if (this.cards.length > 6) {
      const score = (c: Card) => {
        let d = Infinity;
        for (const hand of this.latestHands) {
          if (hand && hand.track !== 'lost') d = Math.min(d, Math.hypot(hand.palm.x - c.x, hand.palm.y - c.y));
        }
        return d;
      };
      this.cards.sort((a, b) => score(b) - score(a)); // farthest first
      this.cards.splice(0, Math.min(4, this.cards.length - 6));
    }
  }
}
