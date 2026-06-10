import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, ParticleNebulaConfig, PALETTES } from '../vfx-schema';
import { curlNoise, expDamp, makeGlowSprite, clamp } from './fxUtils';

/**
 * PARTICLE NEBULA  (config.effect === 'particle_nebula')  — AAA formation rewrite
 *
 * Particles are no longer a random dot cloud. They are organised into roles and
 * stream into structured holographic FORMATIONS that respond to the hands:
 *   • Pinch + drag    → BLACK HOLE (flat high-speed accretion disk around index/thumb)
 *   • Open splay      → CONSTELLATION (sharp fingertip polygon + solar flare rays)
 *   • Close palms     → GALACTIC CORE (three-arm spiral galaxy spanning both palms)
 * A subset of "anchor" particles are PLEXUS-linked with thin lines — the Tony Stark
 * hologram signature. Depth is faked on 2D canvas by modulating size + alpha from the
 * z-component of each formation point.
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

type NebulaFormationMode = 'none' | 'blackHole' | 'constellation' | 'galaxy';

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
  private anchorIdx: number[] = [];

  // Smoothed formation engagement 0→1 (eases in/out, drives gracefulRelease dissolve)
  private formEngage = 0;
  private formMode: NebulaFormationMode = 'none';
  private formHand = 0;
  private formTime = 0;
  private primaryColor = '#ffffff';

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

    // Role assignment: ~6% anchors (plexus), ~55% formation, rest ambient dust.
    const anchorCount = Math.min(130, Math.floor(this.count * 0.06));
    for (let i = 0; i < this.count; i++) {
      this.px[i] = Math.random() * this.w;
      this.py[i] = Math.random() * this.h;
      this.vx[i] = (Math.random() - 0.5) * 10;
      this.vy[i] = (Math.random() - 0.5) * 10;
      this.psize[i] = 4 + Math.random() * 6;
      this.slotPhase[i] = Math.random() * Math.PI * 2;

      if (i < anchorCount) {
        this.role[i] = ROLE_ANCHOR;
        this.anchorIdx.push(i);
      } else if ((i % 20) < 11) {
        this.role[i] = ROLE_FORMATION;
      } else {
        this.role[i] = ROLE_AMBIENT;
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
    this.spritePrimary = makeGlowSprite(32, palette.primary);
    this.spriteSecondary = makeGlowSprite(32, palette.secondary);
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
        if (openHandAction === 'explode' && openness > 0.7 && this.prevOpenness[hi] <= 0.7) {
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

    // ── Decide formation mode ──────────────────────────────────────
    const h0 = hands[0];
    const h1 = hands[1];
    const tracked0 = !!(h0 && h0.track !== 'lost');
    const tracked1 = !!(h1 && h1.track !== 'lost');

    let nextMode: NebulaFormationMode = 'none';
    let nextHand = 0;

    if (tracked0 && tracked1 && h0 && h1) {
      const palmDist = Math.hypot(h1.palm.x - h0.palm.x, h1.palm.y - h0.palm.y);
      if (palmDist < 430 && palmDist > 70) nextMode = 'galaxy';
    }

    if (nextMode === 'none') {
      for (let hi = 0; hi < 2; hi++) {
        const h = hands[hi];
        if (!h || h.track === 'lost') continue;
        if (h.pinching) {
          nextMode = 'blackHole';
          nextHand = hi;
          break;
        }
        if (h.openness > 0.72 && h.landmarks.length >= 21) {
          nextMode = 'constellation';
          nextHand = hi;
          break;
        }
      }
    }

    if (nextMode !== this.formMode || nextHand !== this.formHand) {
      this.formMode = nextMode;
      this.formHand = nextHand;
      this.formTime = 0;
    }
    this.formTime += dt;

    this.formEngage += ((this.formMode !== 'none' ? 1 : 0) - this.formEngage) * (1 - expDamp(7, dt));
    const engaged = this.formEngage > 0.02 && ramp > 0.01;

    // Motion modifiers
    const curlMult = motion === 'swarm' ? 2.2 : 1;
    const damp = expDamp(3.4, dt);
    const noiseAmt = (motion === 'swarm' ? 90 : 22) * curlMult;
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
      const curlScale = formActive ? 0.25 : 1;
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

          if (this.formMode === 'blackHole') {
            const hand = hands[this.formHand];
            if (hand) {
              const dx = this.px[i] - hand.indexTip.x;
              const dy = this.py[i] - hand.indexTip.y;
              const d = Math.hypot(dx, dy) || 1;
              const tangential = clamp(180000 / (d + 60), 450, 2100) * this.formEngage;
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
      if (dep >= 0) {
        // Formation particle: depth modulates size + alpha → volumetric look
        const base = this.psize[i] * this.spriteScale * (0.6 + dep * 0.8);
        this.trailCtx.globalAlpha = 0.35 + dep * 0.65;
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

    // ── Plexus links (anchors only) — the hologram signature ──
    if (this.usePlexus && engaged) {
      const linkDist = 90;
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
            this.trailCtx.globalAlpha = 0.14 * falloff * this.formEngage;
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

    if (engaged) this.drawFormationGuides(hands);

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

  private getFormationTarget(
    i: number,
    hands: [HandSignals | null, HandSignals | null],
  ): NebulaTarget | null {
    if (this.formMode === 'blackHole') {
      const hand = hands[this.formHand];
      if (!hand || hand.track === 'lost') return null;
      const speed = Math.hypot(hand.indexVel.x, hand.indexVel.y);
      let ux = hand.indexVel.x;
      let uy = hand.indexVel.y;
      if (speed < 80) {
        const wrist = hand.landmarks[0] ?? hand.palm;
        ux = hand.indexTip.x - wrist.x;
        uy = hand.indexTip.y - wrist.y;
      }
      const len = Math.hypot(ux, uy) || 1;
      ux /= len;
      uy /= len;
      const vx = -uy;
      const vy = ux;

      const q = ((i * 0.61803398875) % 1);
      const diskR = 26 + Math.sqrt(q) * clamp(hand.scale * 2.9, 190, 330);
      const ang = this.slotPhase[i] + this.formTime * (5.8 + 5.5 * (1 - q));
      const eccentric = 0.18 + 0.2 * Math.sin(this.slotPhase[i] * 3);
      const localX = Math.cos(ang) * diskR;
      const localY = Math.sin(ang) * diskR * eccentric;
      const depth = clamp((Math.sin(ang) * 0.5 + 0.5) * (1 - q * 0.35), 0, 1);
      return {
        x: hand.indexTip.x + ux * localX + vx * localY,
        y: hand.indexTip.y + uy * localX + vy * localY,
        depth,
        stiffness: 135 + (1 - q) * 75,
        damping: 5.8,
      };
    }

    if (this.formMode === 'constellation') {
      const hand = hands[this.formHand];
      if (!hand || hand.track === 'lost' || hand.landmarks.length < 21) return null;
      const tips = [4, 8, 12, 16, 20];
      const segmentCount = tips.length * 2;
      const segment = i % segmentCount;
      const local = ((i * 0.38196601125) % 1);

      if (segment < tips.length) {
        const a = hand.landmarks[tips[segment]];
        const b = hand.landmarks[tips[(segment + 1) % tips.length]];
        const flare = Math.sin(local * Math.PI) * 10;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return {
          x: a.x + dx * local + (-dy / len) * flare,
          y: a.y + dy * local + (dx / len) * flare,
          depth: 0.58 + Math.sin(local * Math.PI) * 0.35,
          stiffness: 160,
          damping: 8.5,
        };
      }

      const ray = segment - tips.length;
      const tip = hand.landmarks[tips[ray]];
      let dx = tip.x - hand.palm.x;
      let dy = tip.y - hand.palm.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const flareLen = clamp(hand.scale * (0.8 + local * 2.2), 70, 260);
      const pulse = Math.sin(this.formTime * 4.2 + i) * 12;
      return {
        x: tip.x + dx * (flareLen + pulse),
        y: tip.y + dy * (flareLen + pulse),
        depth: 0.35 + local * 0.65,
        stiffness: 145,
        damping: 7.5,
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
      const arm = i % 3;
      const maxR = clamp(dist * 0.78, 190, 420);
      const radius = 24 + Math.sqrt(q) * maxR;
      const ang = arm * (Math.PI * 2 / 3) + q * Math.PI * 5.2 + this.formTime * 0.72;
      const z = Math.sin(ang + q * 3.1);
      const corePull = 1 - Math.exp(-q * 4);
      const xLocal = Math.cos(ang) * radius * corePull;
      const yLocal = Math.sin(ang) * radius * 0.46 * corePull;
      const bridgeBias = (q - 0.5) * dist * 0.34;
      return {
        x: cx + ux * (xLocal + bridgeBias) + vx * yLocal,
        y: cy + uy * (xLocal + bridgeBias) + vy * yLocal,
        depth: clamp(0.5 + z * 0.5, 0, 1),
        stiffness: 92,
        damping: 6.5,
      };
    }

    return null;
  }

  private drawFormationGuides(hands: [HandSignals | null, HandSignals | null]): void {
    const a = this.formEngage;
    if (a <= 0.02) return;

    this.trailCtx.save();
    this.trailCtx.globalCompositeOperation = 'lighter';
    this.trailCtx.strokeStyle = this.primaryColor;
    this.trailCtx.lineCap = 'round';

    if (this.formMode === 'blackHole') {
      const hand = hands[this.formHand];
      if (!hand || hand.track === 'lost') { this.trailCtx.restore(); return; }
      this.trailCtx.globalAlpha = 0.5 * a;
      this.trailCtx.lineWidth = 2;
      for (let r = 48; r <= 220; r += 42) {
        this.trailCtx.beginPath();
        this.trailCtx.ellipse(
          hand.indexTip.x,
          hand.indexTip.y,
          r,
          r * 0.18,
          this.formTime * 1.8 + r * 0.01,
          0,
          Math.PI * 2,
        );
        this.trailCtx.stroke();
      }
      this.trailCtx.globalAlpha = 0.85 * a;
      this.trailCtx.beginPath();
      this.trailCtx.arc(hand.indexTip.x, hand.indexTip.y, 18 + Math.sin(this.formTime * 8) * 3, 0, Math.PI * 2);
      this.trailCtx.stroke();
    } else if (this.formMode === 'constellation') {
      const hand = hands[this.formHand];
      if (!hand || hand.track === 'lost' || hand.landmarks.length < 21) { this.trailCtx.restore(); return; }
      const tips = [4, 8, 12, 16, 20];
      this.trailCtx.globalAlpha = 0.42 * a;
      this.trailCtx.lineWidth = 1.6;
      this.trailCtx.beginPath();
      for (let i = 0; i < tips.length; i++) {
        const p = hand.landmarks[tips[i]];
        if (i === 0) this.trailCtx.moveTo(p.x, p.y);
        else this.trailCtx.lineTo(p.x, p.y);
      }
      const first = hand.landmarks[tips[0]];
      this.trailCtx.lineTo(first.x, first.y);
      this.trailCtx.stroke();

      this.trailCtx.globalAlpha = 0.32 * a;
      for (const ti of tips) {
        const tip = hand.landmarks[ti];
        let dx = tip.x - hand.palm.x;
        let dy = tip.y - hand.palm.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        this.trailCtx.beginPath();
        this.trailCtx.moveTo(tip.x, tip.y);
        this.trailCtx.lineTo(tip.x + dx * hand.scale * 2.2, tip.y + dy * hand.scale * 2.2);
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

      this.trailCtx.globalAlpha = 0.34 * a;
      this.trailCtx.lineWidth = 1.4;
      for (let arm = 0; arm < 3; arm++) {
        this.trailCtx.beginPath();
        for (let s = 0; s < 56; s++) {
          const q = s / 55;
          const radius = 28 + Math.sqrt(q) * clamp(dist * 0.78, 190, 420);
          const ang = arm * (Math.PI * 2 / 3) + q * Math.PI * 5.2 + this.formTime * 0.72;
          const x = cx + ux * (Math.cos(ang) * radius + (q - 0.5) * dist * 0.34) + vx * Math.sin(ang) * radius * 0.46;
          const y = cy + uy * (Math.cos(ang) * radius + (q - 0.5) * dist * 0.34) + vy * Math.sin(ang) * radius * 0.46;
          if (s === 0) this.trailCtx.moveTo(x, y);
          else this.trailCtx.lineTo(x, y);
        }
        this.trailCtx.stroke();
      }
      this.trailCtx.globalAlpha = 0.75 * a;
      this.trailCtx.lineWidth = 2.5;
      this.trailCtx.beginPath();
      this.trailCtx.arc(cx, cy, 24 + Math.sin(this.formTime * 3) * 4, 0, Math.PI * 2);
      this.trailCtx.stroke();
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
