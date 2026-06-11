import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, ParticleNebulaConfig, PALETTES } from '../vfx-schema';
import { curlNoise, expDamp, makeGlowSprite, clamp } from './fxUtils';

/**
 * PARTICLE NEBULA  (config.effect === 'particle_nebula')  — AAA formation rewrite
 *
 * Particles are no longer a random dot cloud. They are organised into roles and
 * stream into structured holographic FORMATIONS that respond to the hands:
 *   • Open both palms → ATOM CORE (clean orbital rings between the hands)
 *   • Fists           → FIST ORBITS (compact gravity shells around each fist)
 * Deliberate gesture gates matter more than fallbacks here: a gorgeous particle system
 * only feels controllable when each shape has one obvious command.
 *
 * Schema params:
 *   motion         : 'orbit' | 'stream' | 'swarm'   (formation tightness / flow)
 *   openHandAction : 'explode' | 'release'
 *   trail          : 'short' | 'long'
 */

interface HandForce {
  x: number;
  y: number;
  G: number;
  swirl: number;
  explode: boolean;
}

interface Shockwave {
  x: number;
  y: number;
  r: number;
  life: number;
}

type NebulaFormationMode = 'none' | 'blackHole' | 'galaxy';

interface NebulaIntent {
  mode: NebulaFormationMode;
  hands: number[];
}

interface NebulaTarget {
  x: number;
  y: number;
  depth: number;
  stiffness: number;
  damping: number;
}

const ROLE_AMBIENT = 0;
const ROLE_FORMATION = 1;
const ROLE_ANCHOR = 2;

export class ParticleNebulaEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private config!: ParticleNebulaConfig;
  private w = 0;
  private h = 0;

  private trailCanvas!: HTMLCanvasElement;
  private trailCtx!: CanvasRenderingContext2D;

  private spritePrimary!: HTMLCanvasElement;
  private spriteSecondary!: HTMLCanvasElement;
  private spriteCore!: HTMLCanvasElement;
  private spriteHalo!: HTMLCanvasElement;
  private spriteScale = 1;

  // Particle SoA
  private count = 0;
  private px!: Float32Array;
  private py!: Float32Array;
  private vx!: Float32Array;
  private vy!: Float32Array;
  private psize!: Float32Array;
  private role!: Uint8Array;
  private slotPhase!: Float32Array;   // stable base angle for disk/galaxy slots
  private twinklePhase!: Float32Array;
  private tone!: Float32Array;
  private anchorIdx: number[] = [];

  // Smoothed formation engagement 0→1 (eases in/out, drives gracefulRelease dissolve)
  private formEngage = 0;
  private formMode: NebulaFormationMode = 'none';
  private activeHands: number[] = [];
  private formTime = 0;
  private pendingIntent: NebulaIntent = { mode: 'none', hands: [] };
  private pendingIntentT = 0;
  private primaryColor = '#ffffff';
  private secondaryColor = '#ffffff';
  private glowColor = '#ffffff';
  private formationPulse = 0;
  private formationPulseX = 0;
  private formationPulseY = 0;

  // Explosion hysteresis + graceful-release cache (per hand)
  private prevOpenness: [number, number] = [1, 1];
  private handGMultiplier: [number, number] = [1, 1];
  private lastPalmX: [number, number] = [0, 0];
  private lastPalmY: [number, number] = [0, 0];
  private hadHand: [boolean, boolean] = [false, false];

  private shockwaves: Shockwave[] = [];

  // Quality
  private useStretch = true;
  private usePlexus = true;

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'particle_nebula') throw new Error('Wrong config');
    this.config = config as ParticleNebulaConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    this.count = config.intensity === 1 ? 1500 : config.intensity === 2 ? 2800 : 4500;
    this.px = new Float32Array(this.count);
    this.py = new Float32Array(this.count);
    this.vx = new Float32Array(this.count);
    this.vy = new Float32Array(this.count);
    this.psize = new Float32Array(this.count);
    this.role = new Uint8Array(this.count);
    this.slotPhase = new Float32Array(this.count);
    this.twinklePhase = new Float32Array(this.count);
    this.tone = new Float32Array(this.count);

    // Role assignment: ~6% anchors (plexus), the rest formation. No ambient dust to keep the art neat.
    const anchorCount = Math.min(130, Math.floor(this.count * 0.06));
    for (let i = 0; i < this.count; i++) {
      this.px[i] = Math.random() * this.w;
      this.py[i] = Math.random() * this.h;
      this.vx[i] = (Math.random() - 0.5) * 10;
      this.vy[i] = (Math.random() - 0.5) * 10;
      this.psize[i] = 4 + Math.random() * 6;
      this.slotPhase[i] = Math.random() * Math.PI * 2;
      this.twinklePhase[i] = Math.random() * Math.PI * 2;
      this.tone[i] = Math.random();

      if (i < anchorCount) {
        this.role[i] = ROLE_ANCHOR;
        this.anchorIdx.push(i);
      } else {
        this.role[i] = ROLE_FORMATION;
      }
    }

    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = canvasWidth;
    this.trailCanvas.height = canvasHeight;
    const ctx = this.trailCanvas.getContext('2d');
    if (ctx) {
      this.trailCtx = ctx;
      this.trailCtx.fillStyle = '#000';
      this.trailCtx.fillRect(0, 0, this.w, this.h);
    }

    const palette = PALETTES[config.palette];
    this.primaryColor = palette.primary;
    this.secondaryColor = palette.secondary;
    this.glowColor = palette.glow;
    this.spritePrimary = makeGlowSprite(32, palette.primary);
    this.spriteSecondary = makeGlowSprite(32, palette.secondary);
    this.spriteCore = makeGlowSprite(96, palette.glow);
    this.spriteHalo = makeGlowSprite(192, palette.primary);
    for (const spr of [this.spritePrimary, this.spriteSecondary]) {
      const c = spr.getContext('2d');
      if (c) {
        c.globalCompositeOperation = 'lighter';
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.beginPath();
        c.arc(16, 16, 5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    void _video;
    if (!this.trailCtx) return;

    const { motion, openHandAction, trail } = this.config.params;

    // Trail fade (dt-correct)
    const fadeK = trail === 'short' ? 14 : 4.5;
    const fadeAlpha = 1 - expDamp(fadeK, dt);
    this.trailCtx.globalCompositeOperation = 'source-over';
    this.trailCtx.fillStyle = `rgba(0,0,0,${fadeAlpha})`;
    this.trailCtx.fillRect(0, 0, this.w, this.h);
    this.trailCtx.globalCompositeOperation = 'lighter';

    const t = performance.now() * 0.001;

    // ── Hand forces (with graceful-release decay from cached pos) ──
    const forces: HandForce[] = [];
    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (hand && hand.track !== 'lost') {
        this.handGMultiplier[hi] = Math.min(1, this.handGMultiplier[hi] + dt * 5);
        const openness = hand.openness;
        if (!this.hadHand[hi]) this.prevOpenness[hi] = openness;

        let explode = false;
        if (openHandAction === 'explode' && openness > 0.74 && this.prevOpenness[hi] <= 0.38) {
          explode = true;
          this.shockwaves.push({ x: hand.palm.x, y: hand.palm.y, r: 10, life: 1 });
        }
        this.prevOpenness[hi] = openness;

        let baseG: number;
        if (openHandAction === 'release' && openness > 0.6) baseG = 0;
        else baseG = (0.5 - openness) * 2000;

        forces.push({
          x: hand.palm.x,
          y: hand.palm.y,
          G: baseG * ramp * this.handGMultiplier[hi],
          swirl: motion === 'orbit' ? 900 * ramp * this.handGMultiplier[hi] : 0,
          explode,
        });

        this.lastPalmX[hi] = hand.palm.x;
        this.lastPalmY[hi] = hand.palm.y;
        this.hadHand[hi] = true;
      } else {
        this.handGMultiplier[hi] *= expDamp(12, dt);
        if (this.hadHand[hi] && this.handGMultiplier[hi] > 0.02) {
          forces.push({
            x: this.lastPalmX[hi],
            y: this.lastPalmY[hi],
            G: 1000 * this.handGMultiplier[hi],
            swirl: motion === 'orbit' ? 900 * this.handGMultiplier[hi] : 0,
            explode: false,
          });
        } else {
          this.hadHand[hi] = false;
        }
        this.prevOpenness[hi] = 1;
      }
    }

    // ── Decide formation mode: explicit gestures only, no automatic fallback shapes.
    const intent = this.selectFormationIntent(hands);
    if (this.sameIntent(intent, this.pendingIntent)) {
      this.pendingIntentT += dt;
    } else {
      this.pendingIntent = intent;
      this.pendingIntentT = 0;
    }

    const currentIntent = { mode: this.formMode, hands: this.activeHands };
    const intentChanged = !this.sameIntent(intent, currentIntent);
    const enterDelay = this.formMode === 'none' ? 0.05 : 0.07;
    const exitDelay = intent.mode === 'none' ? 0.16 : enterDelay;
    if (intentChanged && this.pendingIntentT >= exitDelay) {
      const previousMode = this.formMode;
      this.formMode = intent.mode;
      this.activeHands = intent.hands;
      this.formTime = 0;
      if (this.formMode !== 'none' && this.formMode !== previousMode) {
        const pulse = this.getFormationCenter(hands);
        if (pulse) {
          this.formationPulse = 1;
          this.formationPulseX = pulse.x;
          this.formationPulseY = pulse.y;
        }
      }
    }
    this.formTime += dt;
    this.formationPulse *= expDamp(2.7, dt);
    if (this.formationPulse < 0.01) this.formationPulse = 0;

    this.formEngage += ((this.formMode !== 'none' ? 1 : 0) - this.formEngage) * (1 - expDamp(7, dt));
    const engaged = this.formEngage > 0.02 && ramp > 0.01;

    // Motion modifiers
    const curlMult = motion === 'swarm' ? 2.2 : 1;
    const damp = expDamp(3.4, dt);
    const noiseAmt = (motion === 'swarm' ? 68 : 16) * curlMult;
    const streamOn = motion === 'stream';
    const streamSpeed = 140;

    for (let i = 0; i < this.count; i++) {
      let fx = 0;
      let fy = 0;
      let dep = -1; // -1 = not in formation (use velocity-stretch draw path)

      // Ambient curl noise (lighter for in-formation particles)
      const curl = curlNoise(this.px[i], this.py[i], t + i * 0.01);
      const isFormationRole = this.role[i] !== ROLE_AMBIENT;
      const formActive = engaged && isFormationRole && this.formMode !== 'none';
      const curlScale = formActive ? 0.08 : 1;
      fx += curl.x * noiseAmt * curlScale;
      fy += curl.y * noiseAmt * curlScale;

      if (formActive) {
        // ── Compute formation target + depth ──
        const target = this.getFormationTarget(i, hands);
        if (target) {
          dep = target.depth;
          const k = target.stiffness * this.formEngage;
          fx += (target.x - this.px[i]) * k;
          fy += (target.y - this.py[i]) * k;
          this.vx[i] *= expDamp(target.damping, dt);
          this.vy[i] *= expDamp(target.damping, dt);

          if (this.formMode === 'blackHole' && this.activeHands.length > 0) {
            const handIndex = this.activeHands[i % this.activeHands.length];
            const hand = hands[handIndex];
            if (hand) {
              const dx = this.px[i] - hand.palm.x;
              const dy = this.py[i] - hand.palm.y;
              const d = Math.hypot(dx, dy) || 1;
              const tangential = clamp(115000 / (d + 70), 280, 1350) * this.formEngage;
              fx += (-dy / d) * tangential;
              fy += (dx / d) * tangential;
            }
          }
        }
      } else {
        // Not in formation → respond to hand gravity/swirl + stream flow (dust)
        if (streamOn) {
          fx += streamSpeed;
          fy += Math.sin(this.px[i] * 0.01 + t) * 60;
        }
        for (const force of forces) {
          const dx = force.x - this.px[i];
          const dy = force.y - this.py[i];
          const dSq = dx * dx + dy * dy + 400;
          const d = Math.sqrt(dSq);
          if (force.explode && d < 320) {
            const falloff = 1 - d / 320;
            this.vx[i] -= (dx / d) * 1800 * falloff;
            this.vy[i] -= (dy / d) * 1800 * falloff;
            continue;
          }
          const radial = force.G / (dSq * 0.001);
          fx += (dx / d) * radial;
          fy += (dy / d) * radial;
          if (force.swirl !== 0) {
            const sw = force.swirl / d;
            fx += (-dy / d) * sw;
            fy += (dx / d) * sw;
          }
          if (streamOn && d < 260) {
            const def = (1 - d / 260) * 600;
            fx += (-dy / d) * def * Math.sign(dy || 1);
            fy += (dx / d) * def * Math.sign(dy || 1);
          }
        }
      }

      // Even formation particles still feel an explode impulse (so they scatter)
      if (formActive) {
        for (const force of forces) {
          if (!force.explode) continue;
          const dx = force.x - this.px[i];
          const dy = force.y - this.py[i];
          const d = Math.sqrt(dx * dx + dy * dy + 400);
          if (d < 320) {
            const falloff = 1 - d / 320;
            this.vx[i] -= (dx / d) * 1800 * falloff;
            this.vy[i] -= (dy / d) * 1800 * falloff;
          }
        }
      }

      // Integrate (semi-implicit Euler, dt-correct damping)
      this.vx[i] = (this.vx[i] + fx * dt) * damp;
      this.vy[i] = (this.vy[i] + fy * dt) * damp;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;

      // Walls
      if (streamOn && !formActive) {
        if (this.px[i] > this.w + 20) this.px[i] = -20;
        if (this.px[i] < -20) this.px[i] = this.w + 20;
      } else {
        if (this.px[i] < 0) { this.px[i] = 0; this.vx[i] *= -0.5; }
        if (this.px[i] > this.w) { this.px[i] = this.w; this.vx[i] *= -0.5; }
      }
      if (this.py[i] < 0) { this.py[i] = 0; this.vy[i] *= -0.5; }
      if (this.py[i] > this.h) { this.py[i] = this.h; this.vy[i] *= -0.5; }

      // ── Draw ──
      const sprite = i % 3 === 0 ? this.spriteSecondary : this.spritePrimary;
      const shimmer = 0.78 + 0.22 * Math.sin(t * (1.4 + this.tone[i] * 1.8) + this.twinklePhase[i]);
      if (dep >= 0) {
        // Formation particle: depth modulates size + alpha → volumetric look
        const breath = 0.94 + 0.06 * Math.sin(this.formTime * 2.4 + this.twinklePhase[i]);
        const base = this.psize[i] * this.spriteScale * (0.6 + dep * 0.8) * breath;
        this.trailCtx.globalAlpha = (0.34 + dep * 0.66) * shimmer;
        this.trailCtx.drawImage(sprite, this.px[i] - base / 2, this.py[i] - base / 2, base, base);
        this.trailCtx.globalAlpha = 1;
      } else {
        const base = this.psize[i] * this.spriteScale;
        const speedSq = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
        if (this.useStretch && speedSq > 90000) {
          const speed = Math.sqrt(speedSq);
          const stretch = clamp(speed / 600, 1, 2.5);
          const ang = Math.atan2(this.vy[i], this.vx[i]);
          this.trailCtx.save();
          this.trailCtx.translate(this.px[i], this.py[i]);
          this.trailCtx.rotate(ang);
          this.trailCtx.drawImage(sprite, -(base * stretch) / 2, -base / 2, base * stretch, base);
          this.trailCtx.restore();
        } else {
          this.trailCtx.drawImage(sprite, this.px[i] - base / 2, this.py[i] - base / 2, base, base);
        }
      }
    }

    if (engaged) this.drawFormationGlow(hands, t);

    // ── Plexus links (anchors only) — the hologram signature ──
    if (this.usePlexus && engaged) {
      const linkDist = 72;
      const linkDistSq = linkDist * linkDist;
      const idx = this.anchorIdx;
      this.trailCtx.lineWidth = 1;
      this.trailCtx.strokeStyle = this.primaryColor;
      for (let a = 0; a < idx.length; a++) {
        const ia = idx[a];
        let links = 0;
        for (let b = a + 1; b < idx.length && links < 3; b++) {
          const ib = idx[b];
          const dx = this.px[ia] - this.px[ib];
          const dy = this.py[ia] - this.py[ib];
          const d2 = dx * dx + dy * dy;
          if (d2 < linkDistSq) {
            const falloff = 1 - Math.sqrt(d2) / linkDist;
            this.trailCtx.globalAlpha = 0.08 * falloff * this.formEngage;
            this.trailCtx.beginPath();
            this.trailCtx.moveTo(this.px[ia], this.py[ia]);
            this.trailCtx.lineTo(this.px[ib], this.py[ib]);
            this.trailCtx.stroke();
            links++;
          }
        }
      }
      this.trailCtx.globalAlpha = 1;
    }

    if (engaged) this.drawFormationGuides(hands, t);

    // ── Shockwave rings ──
    if (this.shockwaves.length) {
      this.trailCtx.lineWidth = 3;
      for (let i = this.shockwaves.length - 1; i >= 0; i--) {
        const s = this.shockwaves[i];
        s.r += 900 * dt;
        s.life -= dt / 0.4;
        if (s.life <= 0) { this.shockwaves.splice(i, 1); continue; }
        this.trailCtx.globalAlpha = s.life * 0.6;
        this.trailCtx.strokeStyle = '#ffffff';
        this.trailCtx.beginPath();
        this.trailCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        this.trailCtx.stroke();
      }
      this.trailCtx.globalAlpha = 1;
    }
  }

  private selectFormationIntent(hands: [HandSignals | null, HandSignals | null]): NebulaIntent {
    const tracked: number[] = [];
    const fistHands: number[] = [];
    const openHands: number[] = [];

    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (!hand || hand.track === 'lost') continue;

      tracked.push(hi);
      const extendedCount = this.getExtendedFingerCount(hand);
      const isFist = hand.openness < 0.34 || (hand.openness < 0.48 && extendedCount <= 1);
      const isOpenPalm = hand.openness > 0.68 || (hand.openness > 0.56 && extendedCount >= 4);

      if (isFist) fistHands.push(hi);
      if (isOpenPalm) openHands.push(hi);
    }

    if (fistHands.length > 0) {
      return { mode: 'blackHole', hands: fistHands };
    }

    if (tracked.length === 2 && openHands.length === 2) {
      return { mode: 'galaxy', hands: [0, 1] };
    }

    return { mode: 'none', hands: [] };
  }

  private sameIntent(a: NebulaIntent, b: NebulaIntent): boolean {
    if (a.mode !== b.mode || a.hands.length !== b.hands.length) return false;
    for (let i = 0; i < a.hands.length; i++) {
      if (a.hands[i] !== b.hands[i]) return false;
    }
    return true;
  }

  private getExtendedFingerCount(hand: HandSignals): number {
    if (hand.landmarks.length < 21 || hand.scale <= 0) return hand.openness > 0.7 ? 5 : hand.openness < 0.35 ? 0 : 2;

    const palm = hand.palm;
    const ratio = (idx: number) => {
      const p = hand.landmarks[idx];
      return Math.hypot(p.x - palm.x, p.y - palm.y) / Math.max(1, hand.scale);
    };

    let count = 0;
    if (ratio(4) > 0.55) count++;
    if (ratio(8) > 0.82) count++;
    if (ratio(12) > 0.82) count++;
    if (ratio(16) > 0.78) count++;
    if (ratio(20) > 0.74) count++;
    return count;
  }

  private getFormationTarget(
    i: number,
    hands: [HandSignals | null, HandSignals | null],
  ): NebulaTarget | null {
    if (this.activeHands.length === 0) return null;

    if (this.formMode === 'blackHole') {
      const handIndex = this.activeHands[i % this.activeHands.length];
      const hand = hands[handIndex];
      if (!hand || hand.track === 'lost') return null;

      const wrist = hand.landmarks[0] ?? hand.palm;
      const knuckle = hand.landmarks[9] ?? hand.indexTip;
      let ux = knuckle.x - wrist.x;
      let uy = knuckle.y - wrist.y;
      const len = Math.hypot(ux, uy) || 1;
      ux /= len;
      uy /= len;
      const vx = -uy;
      const vy = ux;

      const q = ((i * 0.61803398875) % 1);
      const shell = i % 3;
      const diskR = 18 + Math.sqrt(q) * clamp(hand.scale * (1.15 + shell * 0.22), 88, 185);
      const ang = this.slotPhase[i] + this.formTime * (3.2 + shell * 0.45 + 1.6 * (1 - q));
      const eccentric = 0.42 + shell * 0.08;
      const localX = Math.cos(ang) * diskR;
      const localY = Math.sin(ang) * diskR * eccentric;
      const depth = clamp((Math.sin(ang) * 0.5 + 0.5) * (1 - q * 0.35), 0, 1);
      return {
        x: hand.palm.x + ux * localX + vx * localY,
        y: hand.palm.y + uy * localX + vy * localY,
        depth,
        stiffness: 165 + (1 - q) * 70,
        damping: 8.8,
      };
    }

    if (this.formMode === 'galaxy') {
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') return null;
      const cx = (h0.palm.x + h1.palm.x) * 0.5;
      const cy = (h0.palm.y + h1.palm.y) * 0.5;
      const dx = h1.palm.x - h0.palm.x;
      const dy = h1.palm.y - h0.palm.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const vx = -uy;
      const vy = ux;

      const q = ((i * 0.754877666) % 1);
      const maxR = clamp(dist * 0.62, 135, 355);
      if (q < 0.18) {
        const coreQ = q / 0.18;
        const coreR = Math.sqrt(coreQ) * clamp(dist * 0.13, 24, 54);
        const coreAng = this.slotPhase[i] + this.formTime * 0.95;
        return {
          x: cx + Math.cos(coreAng) * coreR,
          y: cy + Math.sin(coreAng) * coreR,
          depth: 0.8,
          stiffness: 185,
          damping: 9.6,
        };
      }

      const ringQ = (q - 0.18) / 0.82;
      const ring = i % 3;
      const arm = i % 4;
      const ringTilt = (ring - 1) * 0.82 + Math.sin(this.formTime * 0.28) * 0.08;
      const ax = ux * Math.cos(ringTilt) + vx * Math.sin(ringTilt);
      const ay = uy * Math.cos(ringTilt) + vy * Math.sin(ringTilt);
      const bx = -ux * Math.sin(ringTilt) + vx * Math.cos(ringTilt);
      const by = -uy * Math.sin(ringTilt) + vy * Math.cos(ringTilt);
      const radius = maxR * (0.36 + Math.sqrt(ringQ) * 0.64);
      const armOffset = arm * Math.PI * 0.5;
      const spiral = ringQ * Math.PI * (2.45 + ring * 0.28);
      const ang = this.slotPhase[i] * 0.22 + armOffset + spiral + this.formTime * (0.78 + ring * 0.14);
      const localX = Math.cos(ang) * radius;
      const localY = Math.sin(ang) * radius * (0.25 + ring * 0.09);
      const z = Math.sin(ang + ring * 1.7);
      return {
        x: cx + ax * localX + bx * localY,
        y: cy + ay * localX + by * localY,
        depth: clamp(0.5 + z * 0.5, 0, 1),
        stiffness: 142,
        damping: 8.2,
      };
    }

    return null;
  }

  private getFormationCenter(hands: [HandSignals | null, HandSignals | null]): { x: number; y: number } | null {
    if (this.formMode === 'blackHole') {
      let x = 0;
      let y = 0;
      let n = 0;
      for (const hi of this.activeHands) {
        const hand = hands[hi];
        if (!hand || hand.track === 'lost') continue;
        x += hand.palm.x;
        y += hand.palm.y;
        n++;
      }
      return n > 0 ? { x: x / n, y: y / n } : null;
    }

    if (this.formMode === 'galaxy') {
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') return null;
      return {
        x: (h0.palm.x + h1.palm.x) * 0.5,
        y: (h0.palm.y + h1.palm.y) * 0.5,
      };
    }

    return null;
  }

  private drawFormationGlow(hands: [HandSignals | null, HandSignals | null], t: number): void {
    const a = this.formEngage;
    if (a <= 0.02) return;

    this.trailCtx.save();
    this.trailCtx.globalCompositeOperation = 'lighter';

    if (this.formMode === 'blackHole') {
      for (const hi of this.activeHands) {
        const hand = hands[hi];
        if (!hand || hand.track === 'lost') continue;
        const pulse = 0.92 + Math.sin(t * 3.5 + hi) * 0.08;
        const halo = clamp(hand.scale * 2.6, 190, 360) * pulse;
        const core = clamp(hand.scale * 0.62, 52, 96) * (1 + Math.sin(t * 8) * 0.08);

        this.trailCtx.globalAlpha = 0.12 * a;
        this.trailCtx.drawImage(this.spriteHalo, hand.palm.x - halo / 2, hand.palm.y - halo / 2, halo, halo);
        this.trailCtx.globalAlpha = 0.52 * a;
        this.trailCtx.drawImage(this.spriteCore, hand.palm.x - core / 2, hand.palm.y - core / 2, core, core);
      }
    } else if (this.formMode === 'galaxy') {
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') {
        this.trailCtx.restore();
        return;
      }

      const cx = (h0.palm.x + h1.palm.x) * 0.5;
      const cy = (h0.palm.y + h1.palm.y) * 0.5;
      const dx = h1.palm.x - h0.palm.x;
      const dy = h1.palm.y - h0.palm.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist;
      const ny = dx / dist;
      const halo = clamp(dist * 1.1, 260, 620) * (0.96 + Math.sin(t * 2.2) * 0.04);
      const core = clamp(dist * 0.26, 72, 150) * (0.95 + Math.sin(t * 5.5) * 0.05);

      this.trailCtx.globalAlpha = 0.13 * a;
      this.trailCtx.drawImage(this.spriteHalo, cx - halo / 2, cy - halo / 2, halo, halo);
      this.trailCtx.globalAlpha = 0.56 * a;
      this.trailCtx.drawImage(this.spriteCore, cx - core / 2, cy - core / 2, core, core);

      this.trailCtx.lineCap = 'round';
      for (let k = 0; k < 7; k++) {
        const phase = t * (1.4 + k * 0.08) + k * 1.17;
        const side = k - 3;
        const bow = Math.sin(phase) * clamp(dist * 0.055, 10, 34) + side * clamp(dist * 0.018, 4, 12);
        const c1x = cx + nx * bow - dx * 0.13;
        const c1y = cy + ny * bow - dy * 0.13;
        const c2x = cx - nx * bow + dx * 0.13;
        const c2y = cy - ny * bow + dy * 0.13;
        this.trailCtx.globalAlpha = (0.1 + (3 - Math.abs(side)) * 0.028) * a;
        this.trailCtx.strokeStyle = k % 2 === 0 ? this.primaryColor : this.secondaryColor;
        this.trailCtx.lineWidth = k === 3 ? 2.2 : 1.1;
        this.trailCtx.beginPath();
        this.trailCtx.moveTo(h0.palm.x, h0.palm.y);
        this.trailCtx.bezierCurveTo(c1x, c1y, c2x, c2y, h1.palm.x, h1.palm.y);
        this.trailCtx.stroke();
      }
    }

    if (this.formationPulse > 0) {
      const radius = 24 + (1 - this.formationPulse) * 260;
      this.trailCtx.globalAlpha = this.formationPulse * 0.42;
      this.trailCtx.strokeStyle = this.glowColor;
      this.trailCtx.lineWidth = 2.2;
      this.trailCtx.beginPath();
      this.trailCtx.arc(this.formationPulseX, this.formationPulseY, radius, 0, Math.PI * 2);
      this.trailCtx.stroke();
    }

    this.trailCtx.globalAlpha = 1;
    this.trailCtx.restore();
  }

  private drawFormationGuides(hands: [HandSignals | null, HandSignals | null], t: number): void {
    const a = this.formEngage;
    if (a <= 0.02) return;

    this.trailCtx.save();
    this.trailCtx.globalCompositeOperation = 'lighter';
    this.trailCtx.strokeStyle = this.primaryColor;
    this.trailCtx.lineCap = 'round';

    if (this.formMode === 'blackHole') {
      for (const hi of this.activeHands) {
        const hand = hands[hi];
        if (!hand || hand.track === 'lost') continue;
        const wrist = hand.landmarks[0] ?? hand.palm;
        const knuckle = hand.landmarks[9] ?? hand.indexTip;
        const angle = Math.atan2(knuckle.y - wrist.y, knuckle.x - wrist.x);
        this.trailCtx.globalAlpha = 0.28 * a;
        this.trailCtx.lineWidth = 1.8;
        for (let r = 42; r <= 154; r += 38) {
          this.trailCtx.beginPath();
          this.trailCtx.ellipse(
            hand.palm.x,
            hand.palm.y,
            r,
            r * 0.46,
            angle + this.formTime * 0.5 + r * 0.006,
            0,
            Math.PI * 2,
          );
          this.trailCtx.stroke();
        }
        this.trailCtx.globalAlpha = 0.7 * a;
        this.trailCtx.beginPath();
        this.trailCtx.arc(hand.palm.x, hand.palm.y, 16 + Math.sin(this.formTime * 6) * 2, 0, Math.PI * 2);
        this.trailCtx.stroke();

        this.trailCtx.globalAlpha = 0.18 * a;
        this.trailCtx.lineWidth = 1;
        this.trailCtx.beginPath();
        this.trailCtx.arc(hand.palm.x, hand.palm.y, 28 + Math.sin(t * 4 + hi) * 4, 0, Math.PI * 2);
        this.trailCtx.stroke();
      }
    } else if (this.formMode === 'galaxy') {
      const h0 = hands[0];
      const h1 = hands[1];
      if (!h0 || !h1 || h0.track === 'lost' || h1.track === 'lost') { this.trailCtx.restore(); return; }
      const cx = (h0.palm.x + h1.palm.x) * 0.5;
      const cy = (h0.palm.y + h1.palm.y) * 0.5;
      const dx = h1.palm.x - h0.palm.x;
      const dy = h1.palm.y - h0.palm.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      const vx = -uy;
      const vy = ux;

      this.trailCtx.globalAlpha = 0.28 * a;
      this.trailCtx.lineWidth = 1.5;
      const maxR = clamp(dist * 0.62, 135, 355);
      for (let ring = 0; ring < 3; ring++) {
        const ringTilt = (ring - 1) * 0.82 + Math.sin(this.formTime * 0.28) * 0.08;
        const ax = ux * Math.cos(ringTilt) + vx * Math.sin(ringTilt);
        const ay = uy * Math.cos(ringTilt) + vy * Math.sin(ringTilt);
        const bx = -ux * Math.sin(ringTilt) + vx * Math.cos(ringTilt);
        const by = -uy * Math.sin(ringTilt) + vy * Math.cos(ringTilt);
        this.trailCtx.beginPath();
        for (let s = 0; s <= 96; s++) {
          const ang = (s / 96) * Math.PI * 2 + this.formTime * (0.78 + ring * 0.14);
          const x = cx + ax * Math.cos(ang) * maxR + bx * Math.sin(ang) * maxR * (0.25 + ring * 0.09);
          const y = cy + ay * Math.cos(ang) * maxR + by * Math.sin(ang) * maxR * (0.25 + ring * 0.09);
          if (s === 0) this.trailCtx.moveTo(x, y);
          else this.trailCtx.lineTo(x, y);
        }
        this.trailCtx.stroke();
      }
      this.trailCtx.globalAlpha = 0.72 * a;
      this.trailCtx.lineWidth = 2.5;
      this.trailCtx.beginPath();
      this.trailCtx.arc(cx, cy, clamp(dist * 0.08, 18, 42) + Math.sin(this.formTime * 3) * 3, 0, Math.PI * 2);
      this.trailCtx.stroke();

      this.trailCtx.globalAlpha = 0.18 * a;
      this.trailCtx.lineWidth = 1.2;
      this.trailCtx.strokeStyle = this.secondaryColor;
      for (const hand of [h0, h1]) {
        const palmPulse = clamp(dist * 0.055, 18, 34) + Math.sin(t * 4.2 + hand.palm.x * 0.01) * 3;
        this.trailCtx.beginPath();
        this.trailCtx.arc(hand.palm.x, hand.palm.y, palmPulse, 0, Math.PI * 2);
        this.trailCtx.stroke();
      }
    }

    this.trailCtx.globalAlpha = 1;
    this.trailCtx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, _video: HTMLVideoElement): void {
    void _video;
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.trailCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  gracefulRelease(handIndex: number): void {
    // Begin gather-force decay; the formation loses this hand next frame so formEngage
    // eases to 0 and the formation dissolves into ambient drift organically.
    this.handGMultiplier[handIndex] *= 0.6;
  }

  getActiveCount(): number {
    return this.count;
  }

  stepDownQuality(): void {
    // Tier 1: drop velocity-stretch path
    if (this.useStretch) { this.useStretch = false; return; }
    // Tier 2: drop plexus links + thin the cloud
    if (this.usePlexus) { this.usePlexus = false; this.count = Math.max(500, Math.floor(this.count * 0.7)); return; }
    // Tier 3: thin more + shrink sprites
    this.count = Math.max(500, Math.floor(this.count * 0.7));
    this.spriteScale = Math.max(0.6, this.spriteScale * 0.85);
  }
}
