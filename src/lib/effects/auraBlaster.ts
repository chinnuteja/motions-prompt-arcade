import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, AuraBlasterConfig, PALETTES } from '../vfx-schema';
import { expDamp, PingPongCanvas, makeGlowSprite, clamp } from './fxUtils';

const PARTICLE_COUNTS = [260, 440, 620];
const BOLT_SEGMENTS = 16;
const ULTIMATE_ARM_SECONDS = 0.35;
const ULTIMATE_DURATION = 1.2;
const MAX_PARTICLE_SPEED = 2800;
const FIST_CHARGE_OPENNESS = 0.52;
const OPEN_FIRE_OPENNESS = 0.56;
const DUAL_FIST_OPENNESS = 0.48;
const DUAL_OPEN_OPENNESS = 0.62;
const FIRE_START_CHARGE = 0.045;
const FIRE_HOLD_CHARGE = 0.015;

interface HandBasis {
  palmX: number;
  palmY: number;
  forwardX: number;
  forwardY: number;
  sideX: number;
  sideY: number;
  scale: number;
}

export class AuraBlasterEffect implements VfxEffect {
  readonly effectIncludesVideo = true;

  private config!: AuraBlasterConfig;
  private ppc!: PingPongCanvas;
  private w = 0;
  private h = 0;

  // Per-hand state.
  private charge = [0, 0];
  private firing = [false, false];
  private wasFiring = [false, false];
  private muzzle = [0, 0];
  private beamProgress = [0, 0];
  private recoil = [0, 0];
  private emitterCarry = [0, 0];

  // Two-hand ultimate state.
  private ultimateCharge = 0;
  private ultimateArmed = false;
  private dualFistTime = 0;
  private ultimateFiring = false;
  private ultimateProgress = 0;
  private ultimateTime = 0;
  private ultimateMuzzle = 0;
  private ultimateBasis: HandBasis | null = null;
  private ultimateCarry = 0;

  private shake = 0;
  private intensityMul = 1;
  private lastDt = 1 / 60;

  // Particles: 0 = ambient/suck, 1 = beam spark.
  private cap = 400;
  private px!: Float32Array;
  private py!: Float32Array;
  private pvx!: Float32Array;
  private pvy!: Float32Array;
  private life!: Float32Array;
  private pType!: Uint8Array;
  private particleCursor = 0;

  private boltOffset = new Float32Array(BOLT_SEGMENTS);
  private boltTimer = 0;

  private spriteCore!: HTMLCanvasElement;
  private spriteGlow!: HTMLCanvasElement;
  private spriteParticle!: HTMLCanvasElement;
  private beamStrip!: HTMLCanvasElement;
  private bgTreatment = 'rgba(0,0,0,0)';

  private lastHands: [HandSignals | null, HandSignals | null] = [null, null];

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'aura_blaster') throw new Error('Wrong config type');
    this.config = config as AuraBlasterConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    this.ppc = new PingPongCanvas(Math.floor(canvasWidth / 2), Math.floor(canvasHeight / 2));

    const palette = PALETTES[config.palette];
    this.bgTreatment = palette.bgTreatment || 'rgba(0,0,0,0.6)';
    this.spriteCore = makeGlowSprite(72, '#ffffff', palette.primary);
    this.spriteGlow = makeGlowSprite(150, palette.primary, 'rgba(0,0,0,0)');
    this.spriteParticle = makeGlowSprite(10, palette.primary, 'rgba(0,0,0,0)');
    this.beamStrip = this.makeBeamStrip(palette.primary);

    const chargeMul = {
      compact: 0.82,
      normal: 1,
      massive: 1.22,
    }[this.config.params.chargeSize ?? 'normal'];
    this.intensityMul = ([0.9, 1.05, 1.22][config.intensity - 1] ?? 1.05) * chargeMul;
    this.cap = PARTICLE_COUNTS[config.intensity - 1] ?? 440;

    this.px = new Float32Array(this.cap);
    this.py = new Float32Array(this.cap);
    this.pvx = new Float32Array(this.cap);
    this.pvy = new Float32Array(this.cap);
    this.life = new Float32Array(this.cap);
    this.pType = new Uint8Array(this.cap);

    for (let i = 0; i < this.cap; i++) {
      this.resetParticle(i);
      this.px[i] = Math.random() * this.w;
      this.py[i] = Math.random() * this.h;
    }
  }

  private makeBeamStrip(primary: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 96);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.18, primary);
    grad.addColorStop(0.42, '#ffffff');
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(0.58, '#ffffff');
    grad.addColorStop(0.82, primary);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 96);
    return c;
  }

  private resetParticle(
    i: number,
    isBlast = false,
    originX = 0,
    originY = 0,
    dirX = 0,
    dirY = 0,
    speed = 0,
  ): void {
    if (isBlast) {
      this.px[i] = originX;
      this.py[i] = originY;
      this.pvx[i] = dirX * speed + (Math.random() - 0.5) * speed * 0.22;
      this.pvy[i] = dirY * speed + (Math.random() - 0.5) * speed * 0.22;
      this.life[i] = 0.45 + Math.random() * 0.65;
      this.pType[i] = 1;
      return;
    }

    this.px[i] = Math.random() * this.w;
    this.py[i] = Math.random() * this.h;
    this.pvx[i] = (Math.random() - 0.5) * 55;
    this.pvy[i] = (Math.random() - 0.5) * 55;
    this.life[i] = 0.4 + Math.random() * 1.2;
    this.pType[i] = 0;
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    void _video;
    this.lastHands = hands;
    this.lastDt = dt;

    const bases: [HandBasis | null, HandBasis | null] = [
      hands[0] && hands[0].track !== 'lost' ? this.getHandBasis(hands[0]) : null,
      hands[1] && hands[1].track !== 'lost' ? this.getHandBasis(hands[1]) : null,
    ];

    const bothTracked = !!bases[0] && !!bases[1];
    const bothFists = bothTracked && hands[0]!.openness < DUAL_FIST_OPENNESS && hands[1]!.openness < DUAL_FIST_OPENNESS;
    const bothOpen = bothTracked && hands[0]!.openness > DUAL_OPEN_OPENNESS && hands[1]!.openness > DUAL_OPEN_OPENNESS;

    this.stepUltimateState(bases, bothTracked, bothFists, bothOpen, dt, ramp);
    this.stepHands(hands, bases, dt, ramp);
    this.stepBoltJitter(dt);
    this.stepParticles(hands, bases, dt, ramp);
  }

  private stepUltimateState(
    bases: [HandBasis | null, HandBasis | null],
    bothTracked: boolean,
    bothFists: boolean,
    bothOpen: boolean,
    dt: number,
    ramp: number,
  ): void {
    if (this.ultimateFiring) {
      if (bases[0] && bases[1]) this.ultimateBasis = this.getMergedBasis(bases[0], bases[1]);
      this.ultimateProgress = Math.min(1, this.ultimateProgress + dt * 4.8);
      this.ultimateTime -= dt;
      this.ultimateMuzzle = Math.max(0, this.ultimateMuzzle - dt * 3.6);
      this.ultimateCharge = Math.max(0, this.ultimateCharge - dt / ULTIMATE_DURATION);
      this.shake = Math.max(this.shake, 5.5 * this.intensityMul * ramp);

      if (this.ultimateBasis) {
        this.emitUltimateSparks(this.ultimateBasis, dt, ramp);
      }

      if (this.ultimateTime <= 0) {
        this.ultimateFiring = false;
        this.ultimateProgress = 0;
        this.ultimateArmed = false;
        this.ultimateCharge = 0;
        this.ultimateBasis = null;
        this.ultimateCarry = 0;
      }
      return;
    }

    if (!bothTracked) {
      this.dualFistTime = 0;
      this.ultimateArmed = false;
      this.ultimateCharge = Math.max(0, this.ultimateCharge - dt * 1.8);
      return;
    }

    if (bothFists) {
      this.dualFistTime += dt;
      this.ultimateCharge = Math.min(1, this.ultimateCharge + dt * 0.9);
      if (this.dualFistTime >= ULTIMATE_ARM_SECONDS && this.ultimateCharge > 0.25) {
        this.ultimateArmed = true;
      }
    } else if (!this.ultimateArmed) {
      this.dualFistTime = Math.max(0, this.dualFistTime - dt * 2);
      this.ultimateCharge = Math.max(0, this.ultimateCharge - dt * 0.75);
    }

    if (this.ultimateArmed && bothOpen && bases[0] && bases[1]) {
      this.ultimateFiring = true;
      this.ultimateProgress = 0;
      this.ultimateTime = ULTIMATE_DURATION * (0.85 + this.ultimateCharge * 0.3);
      this.ultimateMuzzle = 1;
      this.ultimateBasis = this.getMergedBasis(bases[0], bases[1]);
      this.shake = Math.max(this.shake, 28 * this.intensityMul * ramp);
      for (let hi = 0; hi < 2; hi++) {
        this.firing[hi] = false;
        this.wasFiring[hi] = false;
        this.beamProgress[hi] = 0;
        this.recoil[hi] = 0;
      }
    }
  }

  private stepHands(
    hands: [HandSignals | null, HandSignals | null],
    bases: [HandBasis | null, HandBasis | null],
    dt: number,
    ramp: number,
  ): void {
    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      const basis = bases[hi];

      if (!hand || !basis || hand.track === 'lost') {
        this.charge[hi] = Math.max(0, this.charge[hi] - dt * 1.4);
        this.firing[hi] = false;
        this.emitterCarry[hi] = 0;
      } else if (this.ultimateFiring) {
        this.firing[hi] = false;
        this.charge[hi] = Math.max(0, this.charge[hi] - dt * 0.45);
      } else {
        const openness = hand.openness;
        const isFist = openness < FIST_CHARGE_OPENNESS;
        const isOpen = openness > OPEN_FIRE_OPENNESS;
        const closedness = clamp((FIST_CHARGE_OPENNESS - openness) / FIST_CHARGE_OPENNESS, 0, 1);

        if (isFist) {
          this.charge[hi] = Math.min(1.5, this.charge[hi] + dt * (0.55 + closedness * 0.85));
          this.firing[hi] = false;
        } else if (isOpen && (this.charge[hi] > FIRE_START_CHARGE || (this.wasFiring[hi] && this.charge[hi] > FIRE_HOLD_CHARGE))) {
          this.firing[hi] = true;
          this.charge[hi] = Math.max(0, this.charge[hi] - dt * 0.32);
          this.emitBeamSparks(basis, hi, dt, ramp);
        } else {
          this.firing[hi] = false;
          this.charge[hi] = Math.max(0, this.charge[hi] - dt * 0.22);
        }
      }

      if (this.firing[hi] && !this.wasFiring[hi]) {
        this.muzzle[hi] = 1;
        this.recoil[hi] = 1;
        this.beamProgress[hi] = 0;
        this.shake = Math.max(this.shake, 14 * this.intensityMul * ramp);
      }

      this.muzzle[hi] = Math.max(0, this.muzzle[hi] - dt * 5.4);
      this.recoil[hi] = Math.max(0, this.recoil[hi] - dt * 3.8);
      this.beamProgress[hi] = this.firing[hi]
        ? Math.min(1, this.beamProgress[hi] + dt * 12.5)
        : Math.max(0, this.beamProgress[hi] - dt * 12);
      this.wasFiring[hi] = this.firing[hi];
    }

    this.shake *= expDamp(8, dt);
  }

  private stepBoltJitter(dt: number): void {
    this.boltTimer -= dt;
    if (this.boltTimer > 0) return;

    this.boltTimer = 0.035;
    for (let s = 0; s < BOLT_SEGMENTS; s++) {
      const taper = Math.sin((s / (BOLT_SEGMENTS - 1)) * Math.PI);
      this.boltOffset[s] = (Math.random() - 0.5) * taper;
    }
  }

  private stepParticles(
    hands: [HandSignals | null, HandSignals | null],
    bases: [HandBasis | null, HandBasis | null],
    dt: number,
    ramp: number,
  ): void {
    const isVortex = this.config.params.chargeEffect === 'vortex';
    const ambientDamp = expDamp(1.7, dt);
    const sparkDamp = expDamp(0.95, dt);

    for (let i = 0; i < this.cap; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.resetParticle(i);
        continue;
      }

      if (this.pType[i] === 0) {
        let affected = false;

        if (this.ultimateFiring && this.ultimateBasis) {
          affected = this.affectParticleByBeam(i, this.ultimateBasis, 1.4, 220, dt);
        }

        for (let hi = 0; hi < 2; hi++) {
          const hand = hands[hi];
          const basis = bases[hi];
          if (!hand || !basis) continue;

          if (!affected && this.firing[hi]) {
            affected = this.affectParticleByBeam(i, basis, this.charge[hi], 110, dt);
          } else if (!affected && this.charge[hi] > 0.02) {
            affected = this.affectParticleByCharge(i, basis, this.charge[hi], isVortex, dt, ramp);
          }
        }

        if (!affected) {
          this.pvx[i] += (Math.random() - 0.5) * 80 * dt;
          this.pvy[i] += (Math.random() - 0.5) * 80 * dt;
        }
      }

      const damp = this.pType[i] === 0 ? ambientDamp : sparkDamp;
      this.pvx[i] *= damp;
      this.pvy[i] *= damp;
      this.clampParticleVelocity(i);
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;

      if (this.px[i] < -160 || this.px[i] > this.w + 160 || this.py[i] < -160 || this.py[i] > this.h + 160) {
        this.resetParticle(i);
      }
    }
  }

  private affectParticleByCharge(
    i: number,
    basis: HandBasis,
    charge: number,
    isVortex: boolean,
    dt: number,
    ramp: number,
  ): boolean {
    const dx = basis.palmX - this.px[i];
    const dy = basis.palmY - this.py[i];
    const dist = Math.hypot(dx, dy) || 1;
    const radius = 290 + charge * 95;
    if (dist > radius) return false;

    const n = 1 - dist / radius;
    const pull = (5200 / Math.max(28, dist)) * charge * (0.45 + n) * ramp;
    this.pvx[i] += (dx / dist) * pull * dt;
    this.pvy[i] += (dy / dist) * pull * dt;

    if (isVortex) {
      const swirl = (3600 / Math.max(35, dist)) * charge * (0.45 + n) * ramp;
      this.pvx[i] += (-dy / dist) * swirl * dt;
      this.pvy[i] += (dx / dist) * swirl * dt;
    }

    if (dist < 26 + charge * 8) this.life[i] = 0;
    return true;
  }

  private affectParticleByBeam(
    i: number,
    basis: HandBasis,
    power: number,
    corridorBase: number,
    dt: number,
  ): boolean {
    const dx = this.px[i] - basis.palmX;
    const dy = this.py[i] - basis.palmY;
    const axial = dx * basis.forwardX + dy * basis.forwardY;
    const lateral = dx * basis.sideX + dy * basis.sideY;
    const corridor = corridorBase + power * 70;
    if (axial < -basis.scale * 0.7 || Math.abs(lateral) > corridor) return false;

    const center = 1 - Math.abs(lateral) / corridor;
    const push = (1200 + power * 1050) * center;
    this.pvx[i] += (basis.forwardX * push + basis.sideX * lateral * 2.2) * dt;
    this.pvy[i] += (basis.forwardY * push + basis.sideY * lateral * 2.2) * dt;
    this.life[i] = Math.max(this.life[i], 0.75);
    this.pType[i] = 1;
    return true;
  }

  private emitBeamSparks(basis: HandBasis, handIndex: number, dt: number, ramp: number): void {
    if (ramp <= 0.02) return;

    const rate = (90 + this.charge[handIndex] * 70) * this.intensityMul * ramp;
    this.emitterCarry[handIndex] += rate * dt;
    const count = Math.min(8, Math.floor(this.emitterCarry[handIndex]));
    this.emitterCarry[handIndex] -= count;

    for (let i = 0; i < count; i++) {
      const side = (Math.random() - 0.5) * basis.scale * 0.8;
      const forward = basis.scale * (0.1 + Math.random() * 0.35);
      const speed = 1100 + Math.random() * 1200 + this.charge[handIndex] * 500;
      this.spawnSpark(
        basis.palmX + basis.forwardX * forward + basis.sideX * side,
        basis.palmY + basis.forwardY * forward + basis.sideY * side,
        basis.forwardX + basis.sideX * (Math.random() - 0.5) * 0.38,
        basis.forwardY + basis.sideY * (Math.random() - 0.5) * 0.38,
        speed,
      );
    }
  }

  private emitUltimateSparks(basis: HandBasis, dt: number, ramp: number): void {
    if (ramp <= 0.02) return;

    this.ultimateCarry += 210 * this.intensityMul * ramp * dt;
    const count = Math.min(14, Math.floor(this.ultimateCarry));
    this.ultimateCarry -= count;

    for (let i = 0; i < count; i++) {
      const side = (Math.random() - 0.5) * basis.scale * 2.2;
      const forward = basis.scale * (0.05 + Math.random() * 0.7);
      const speed = 1800 + Math.random() * 1300;
      this.spawnSpark(
        basis.palmX + basis.forwardX * forward + basis.sideX * side,
        basis.palmY + basis.forwardY * forward + basis.sideY * side,
        basis.forwardX + basis.sideX * (Math.random() - 0.5) * 0.45,
        basis.forwardY + basis.sideY * (Math.random() - 0.5) * 0.45,
        speed,
      );
    }
  }

  private nextParticleSlot(): number {
    for (let n = 0; n < this.cap; n++) {
      const idx = (this.particleCursor + n) % this.cap;
      if (this.life[idx] <= 0 || this.pType[idx] === 0) {
        this.particleCursor = (idx + 1) % this.cap;
        return idx;
      }
    }

    const idx = this.particleCursor;
    this.particleCursor = (this.particleCursor + 1) % this.cap;
    return idx;
  }

  private spawnSpark(x: number, y: number, dirX: number, dirY: number, speed: number): void {
    const len = Math.hypot(dirX, dirY) || 1;
    const idx = this.nextParticleSlot();
    this.resetParticle(idx, true, x, y, dirX / len, dirY / len, speed);
  }

  private clampParticleVelocity(i: number): void {
    const speed = Math.hypot(this.pvx[i], this.pvy[i]);
    if (speed <= MAX_PARTICLE_SPEED) return;
    const m = MAX_PARTICLE_SPEED / speed;
    this.pvx[i] *= m;
    this.pvy[i] *= m;
  }

  private getHandBasis(hand: HandSignals): HandBasis {
    const wrist = hand.landmarks[0] || hand.palm;
    const indexMcp = hand.landmarks[5] || hand.palm;
    const middleMcp = hand.landmarks[9] || hand.palm;
    const pinkyMcp = hand.landmarks[17] || hand.palm;

    let forwardX = middleMcp.x - wrist.x;
    let forwardY = middleMcp.y - wrist.y;
    const fLen = Math.hypot(forwardX, forwardY) || 1;
    forwardX /= fLen;
    forwardY /= fLen;

    let sideX = pinkyMcp.x - indexMcp.x;
    let sideY = pinkyMcp.y - indexMcp.y;
    const sLen = Math.hypot(sideX, sideY) || 1;
    sideX /= sLen;
    sideY /= sLen;

    return {
      palmX: hand.palm.x,
      palmY: hand.palm.y,
      forwardX,
      forwardY,
      sideX,
      sideY,
      scale: Math.max(32, hand.scale),
    };
  }

  private getMergedBasis(a: HandBasis, b: HandBasis): HandBasis {
    let forwardX = a.forwardX + b.forwardX;
    let forwardY = a.forwardY + b.forwardY;
    let fLen = Math.hypot(forwardX, forwardY);
    if (fLen < 0.2) {
      forwardX = 0;
      forwardY = -1;
      fLen = 1;
    }
    forwardX /= fLen;
    forwardY /= fLen;

    let sideX = -forwardY;
    let sideY = forwardX;
    const handDx = b.palmX - a.palmX;
    const handDy = b.palmY - a.palmY;
    if (Math.hypot(handDx, handDy) > 10) {
      const hLen = Math.hypot(handDx, handDy);
      sideX = handDx / hLen;
      sideY = handDy / hLen;
    }

    return {
      palmX: (a.palmX + b.palmX) * 0.5,
      palmY: (a.palmY + b.palmY) * 0.5,
      forwardX,
      forwardY,
      sideX,
      sideY,
      scale: Math.max(64, (a.scale + b.scale) * 0.7),
    };
  }

  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
    const t = performance.now() * 0.001;
    const palette = PALETTES[this.config.palette];
    const isImplosion = this.config.params.chargeEffect === 'implosion';

    let maxCharge = this.ultimateCharge;
    let isAnyFiring = this.ultimateFiring;
    for (let hi = 0; hi < 2; hi++) {
      maxCharge = Math.max(maxCharge, this.charge[hi]);
      isAnyFiring = isAnyFiring || this.firing[hi];
    }

    let shakeMag = this.shake;
    if (this.ultimateFiring) shakeMag += 8 * this.intensityMul;
    else if (isAnyFiring) shakeMag += 4.2 * this.intensityMul;
    else if (maxCharge > 0.9) shakeMag += 2.4;
    shakeMag = clamp(shakeMag, 0, 32);
    const shakeX = shakeMag > 0.1 ? (Math.random() - 0.5) * shakeMag : 0;
    const shakeY = shakeMag > 0.1 ? (Math.random() - 0.5) * shakeMag : 0;

    ctx.save();
    ctx.translate(shakeX, shakeY);

    ctx.save();
    ctx.scale(-1, 1);
    ctx.translate(-this.w, 0);
    ctx.drawImage(video, 0, 0, this.w, this.h);
    ctx.restore();

    ctx.fillStyle = this.bgTreatment;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawFeedbackField(ctx, isImplosion);

    ctx.globalCompositeOperation = 'screen';
    for (let hi = 0; hi < 2; hi++) {
      const hand = this.lastHands[hi];
      if (!hand || hand.track === 'lost') continue;
      const basis = this.getHandBasis(hand);
      this.drawChargeAura(ctx, basis, this.charge[hi], hi, isImplosion, palette.primary, t);
    }

    if (this.ultimateFiring && this.ultimateBasis) {
      this.drawUltimate(ctx, palette.primary, t);
    } else {
      for (let hi = 0; hi < 2; hi++) {
        const hand = this.lastHands[hi];
        if (!hand || hand.track === 'lost') continue;
        const basis = this.getHandBasis(hand);
        if (this.muzzle[hi] > 0.01) this.drawMuzzle(ctx, basis, this.charge[hi], this.muzzle[hi]);
        if (this.firing[hi]) this.drawNormalBeam(ctx, basis, hi, t);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  private drawFeedbackField(ctx: CanvasRenderingContext2D, isImplosion: boolean): void {
    const pw = this.ppc.width;
    const ph = this.ppc.height;
    const writeCtx = this.ppc.writeCtx;
    const hw = pw / this.w;
    const hh = ph / this.h;

    writeCtx.clearRect(0, 0, pw, ph);
    writeCtx.save();
    writeCtx.translate(pw / 2, ph / 2);
    writeCtx.scale(1.012, 1.012);
    writeCtx.translate(-pw / 2, -ph / 2);
    writeCtx.globalAlpha = expDamp(8.8, this.lastDt);
    writeCtx.globalCompositeOperation = 'source-over';
    writeCtx.drawImage(this.ppc.read, 0, 0);
    writeCtx.restore();

    writeCtx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      const x = this.px[i] * hw;
      const y = this.py[i] * hh;
      const blast = this.pType[i] === 1;
      const s = blast ? 9 : 4.8;
      const alpha = Math.min(1, this.life[i] * (blast ? 2.0 : 1.35));

      if (isImplosion && !blast) {
        const tailX = (this.px[i] - this.pvx[i] * 0.04) * hw;
        const tailY = (this.py[i] - this.pvy[i] * 0.04) * hh;
        for (let k = 0; k <= 3; k++) {
          const f = k / 3;
          writeCtx.globalAlpha = alpha * (0.22 + 0.78 * f);
          writeCtx.drawImage(
            this.spriteParticle,
            x + (tailX - x) * (1 - f) - s / 2,
            y + (tailY - y) * (1 - f) - s / 2,
            s,
            s,
          );
        }
      } else {
        writeCtx.globalAlpha = alpha;
        writeCtx.drawImage(this.spriteParticle, x - s / 2, y - s / 2, s, s);
      }
    }

    writeCtx.globalAlpha = 1;
    this.ppc.swap();

    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.ppc.read, 0, 0, this.w, this.h);
  }

  private drawChargeAura(
    ctx: CanvasRenderingContext2D,
    basis: HandBasis,
    charge: number,
    handIndex: number,
    isImplosion: boolean,
    color: string,
    t: number,
  ): void {
    const ultimateFeed = this.ultimateArmed && !this.ultimateFiring ? this.ultimateCharge * 0.45 : 0;
    const intensity = clamp(charge + ultimateFeed, 0, 1.5);
    if (intensity <= 0.04 || this.firing[handIndex]) return;

    const pulse = 1 + 0.08 * Math.sin(t * (9 + 10 * Math.min(1, intensity)) + handIndex);
    const condense = isImplosion ? 1 - 0.2 * Math.min(1, intensity) : 1;
    const radius = (24 + intensity * 58) * condense * pulse;

    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, intensity * 1.25);
    ctx.drawImage(this.spriteGlow, basis.palmX - radius * 2.2, basis.palmY - radius * 2.2, radius * 4.4, radius * 4.4);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.spriteCore, basis.palmX - radius * 0.72, basis.palmY - radius * 0.72, radius * 1.44, radius * 1.44);

    ctx.save();
    ctx.translate(basis.palmX, basis.palmY);
    ctx.rotate(Math.atan2(basis.forwardY, basis.forwardX));
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let ring = 0; ring < 3; ring++) {
      const phase = (t * (isImplosion ? -0.9 : 0.9) + ring / 3) % 1;
      const travel = isImplosion ? 1 - phase : phase;
      const r = radius * (0.7 + travel * 1.55);
      ctx.globalAlpha = intensity * (1 - travel) * 0.35;
      ctx.lineWidth = Math.max(1, 4 - ring);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.28, r * 0.48, ring * 0.7 + t * (isImplosion ? -1.8 : 2.4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawNormalBeam(ctx: CanvasRenderingContext2D, basis: HandBasis, handIndex: number, t: number): void {
    const intensity = this.charge[handIndex];
    const fizzle = intensity < 0.16 ? intensity / 0.16 : 1;
    if (fizzle <= 0.01) return;

    const flicker = fizzle < 1 ? 0.72 + 0.28 * Math.random() : 0.94 + Math.random() * 0.06;
    const end = this.rayToBounds(basis.palmX, basis.palmY, basis.forwardX, basis.forwardY);
    const beamLength = end * this.beamProgress[handIndex];
    const beamWidth = clamp((54 + intensity * 92) * this.intensityMul * this.beamWidthMul() * fizzle, 18, 240);
    const recoilOffset = this.recoil[handIndex] * 16 * this.intensityMul;

    ctx.save();
    ctx.translate(basis.palmX - basis.forwardX * recoilOffset, basis.palmY - basis.forwardY * recoilOffset);
    ctx.rotate(Math.atan2(basis.forwardY, basis.forwardX));
    this.drawPromptBeamPattern(ctx, beamLength, beamWidth, intensity * flicker, t, false);
    ctx.restore();
  }

  private drawUltimate(ctx: CanvasRenderingContext2D, color: string, t: number): void {
    const basis = this.ultimateBasis;
    if (!basis) return;

    const power = clamp(0.8 + this.ultimateCharge * 0.95 + this.ultimateMuzzle * 0.35, 0.65, 1.7);
    const end = this.rayToBounds(basis.palmX, basis.palmY, basis.forwardX, basis.forwardY);
    const beamLength = end * this.ultimateProgress;
    const beamWidth = clamp((138 + power * 118) * this.intensityMul * this.beamWidthMul(), 90, 390);

    for (let hi = 0; hi < 2; hi++) {
      const hand = this.lastHands[hi];
      if (!hand || hand.track === 'lost') continue;
      const hb = this.getHandBasis(hand);
      this.drawFeedLine(ctx, hb.palmX, hb.palmY, basis.palmX, basis.palmY, color, power, t + hi);
    }

    this.drawMuzzle(ctx, basis, power, Math.max(0.35, this.ultimateMuzzle));
    ctx.save();
    ctx.translate(basis.palmX, basis.palmY);
    ctx.rotate(Math.atan2(basis.forwardY, basis.forwardX));
    this.drawPromptBeamPattern(ctx, beamLength, beamWidth, power, t, true);
    ctx.restore();
  }

  private beamWidthMul(): number {
    switch (this.config.params.beamWidth ?? 'normal') {
      case 'narrow': return 0.62;
      case 'wide': return 1.34;
      default: return 1;
    }
  }

  private drawPromptBeamPattern(
    ctx: CanvasRenderingContext2D,
    beamLength: number,
    beamWidth: number,
    power: number,
    t: number,
    ultimate: boolean,
  ): void {
    const count = this.config.params.beamCount ?? 'single';

    if (count === 'split') {
      for (const angle of [-0.12, 0, 0.12]) {
        ctx.save();
        ctx.rotate(angle);
        this.drawBeam(ctx, beamLength * (angle === 0 ? 1 : 0.92), beamWidth * (angle === 0 ? 0.72 : 0.48), power, t + angle * 10, ultimate);
        this.drawImpact(ctx, beamLength * (angle === 0 ? 1 : 0.92), beamWidth * 0.55, power, t, ultimate);
        ctx.restore();
      }
      return;
    }

    if (count === 'dual') {
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(0, side * beamWidth * 0.32);
        ctx.rotate(side * 0.035);
        this.drawBeam(ctx, beamLength, beamWidth * 0.58, power, t + side, ultimate);
        this.drawImpact(ctx, beamLength, beamWidth * 0.58, power, t, ultimate);
        ctx.restore();
      }
      return;
    }

    this.drawBeam(ctx, beamLength, beamWidth, power, t, ultimate);
    this.drawImpact(ctx, beamLength, beamWidth, power, t, ultimate);
  }

  private drawFeedLine(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    power: number,
    t: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const wobble = Math.sin(t * 16) * 18 * power;
    const cx = (x0 + x1) * 0.5 + nx * wobble;
    const cy = (y0 + y1) * 0.5 + ny * wobble;

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.45 * power;
    ctx.lineWidth = 18 * power;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 4 * power;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
  }

  private drawMuzzle(ctx: CanvasRenderingContext2D, basis: HandBasis, intensity: number, amount: number): void {
    const radius = (54 + intensity * 70) * amount * this.intensityMul;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(amount, 0, 1);
    ctx.drawImage(this.spriteCore, basis.palmX - radius, basis.palmY - radius, radius * 2, radius * 2);
    ctx.globalAlpha = clamp(amount * 0.55, 0, 0.75);
    ctx.drawImage(this.spriteGlow, basis.palmX - radius * 1.75, basis.palmY - radius * 1.75, radius * 3.5, radius * 3.5);
  }

  private drawBeam(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    intensity: number,
    t: number,
    ultimate: boolean,
  ): void {
    if (len < 1) return;

    const style = this.config.params.beamStyle;
    const a = clamp(intensity, 0, ultimate ? 1.35 : 1);
    const glow = width * (ultimate ? 1.35 : 1.05);

    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, a * 0.58);
    ctx.drawImage(this.beamStrip, 0, -glow, len, glow * 2);

    if (style === 'electric') {
      this.drawElectricBeam(ctx, len, width, a, ultimate);
      return;
    }

    if (style === 'laser') {
      this.drawLaserBeam(ctx, len, width, a, ultimate);
      return;
    }

    this.drawPlasmaBeam(ctx, len, width, a, t, ultimate);
  }

  private drawElectricBeam(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    alpha: number,
    ultimate: boolean,
  ): void {
    const drawBolt = (amp: number, a: number, lw: number, phase: number) => {
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let s = 1; s < BOLT_SEGMENTS; s++) {
        const f = s / (BOLT_SEGMENTS - 1);
        const branch = Math.sin(f * Math.PI * 5 + phase) * 0.22;
        ctx.lineTo(len * f, (this.boltOffset[s] + branch) * amp);
      }
      ctx.stroke();
    };

    drawBolt(width * (ultimate ? 2.1 : 1.55), alpha, Math.max(3, width * 0.15), 0);
    drawBolt(width * (ultimate ? 3.1 : 2.25), alpha * 0.36, Math.max(1, width * 0.08), 1.7);
    drawBolt(width * (ultimate ? 1.2 : 0.85), alpha * 0.9, Math.max(2, width * 0.08), 3.4);

    ctx.globalAlpha = alpha * 0.45;
    ctx.drawImage(this.beamStrip, 0, -width * 0.58, len, width * 1.16);
  }

  private drawLaserBeam(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    alpha: number,
    ultimate: boolean,
  ): void {
    const core = Math.max(8, width * (ultimate ? 0.24 : 0.18));
    ctx.globalAlpha = alpha * 0.72;
    ctx.drawImage(this.beamStrip, 0, -width * 0.52, len, width * 1.04);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, -core * 0.5, len, core);
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillRect(0, -core * 1.15, len, core * 0.35);
    ctx.fillRect(0, core * 0.8, len, core * 0.35);
  }

  private drawPlasmaBeam(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    alpha: number,
    t: number,
    ultimate: boolean,
  ): void {
    const segs = ultimate ? 18 : 12;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha * 0.95;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let s = 0; s <= segs; s++) {
      const f = s / segs;
      const taper = 1 - f * (ultimate ? 0.22 : 0.42);
      const wob = 1 + 0.16 * Math.sin(f * 8 - t * 10) + 0.06 * Math.sin(f * 23 + t * 17);
      const yEdge = -width * 0.26 * taper * wob;
      if (s === 0) ctx.moveTo(len * f, yEdge);
      else ctx.lineTo(len * f, yEdge);
    }
    for (let s = segs; s >= 0; s--) {
      const f = s / segs;
      const taper = 1 - f * (ultimate ? 0.22 : 0.42);
      const wob = 1 + 0.16 * Math.sin(f * 8 - t * 10 + Math.PI) + 0.06 * Math.sin(f * 21 - t * 15);
      ctx.lineTo(len * f, width * 0.26 * taper * wob);
    }
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = alpha * 0.52;
    ctx.drawImage(this.beamStrip, 0, -width * 0.86, len, width * 1.72);

    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let r = -1; r <= 1; r += 2) {
      ctx.globalAlpha = alpha * 0.34;
      ctx.lineWidth = Math.max(1, width * 0.035);
      ctx.beginPath();
      ctx.moveTo(0, r * width * 0.38);
      for (let s = 1; s <= segs; s++) {
        const f = s / segs;
        const y = r * width * (0.38 + 0.08 * Math.sin(f * 10 + t * 12 + r));
        ctx.lineTo(len * f, y);
      }
      ctx.stroke();
    }
  }

  private drawImpact(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    intensity: number,
    t: number,
    ultimate: boolean,
  ): void {
    if (len < 80) return;
    const a = clamp(intensity, 0, ultimate ? 1.2 : 1);
    const pulse = 1 + 0.08 * Math.sin(t * 20);
    const r = width * (ultimate ? 1.35 : 0.95) * pulse;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a * (ultimate ? 0.72 : 0.46);
    ctx.drawImage(this.spriteGlow, len - r * 1.6, -r * 1.6, r * 3.2, r * 3.2);
    ctx.globalAlpha = a * 0.8;
    ctx.drawImage(this.spriteCore, len - r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
  }

  private rayToBounds(x: number, y: number, dx: number, dy: number): number {
    let t = Infinity;
    if (dx > 0.001) t = Math.min(t, (this.w - x) / dx);
    else if (dx < -0.001) t = Math.min(t, -x / dx);
    if (dy > 0.001) t = Math.min(t, (this.h - y) / dy);
    else if (dy < -0.001) t = Math.min(t, -y / dy);
    if (!Number.isFinite(t)) return Math.max(this.w, this.h);
    return clamp(t, 120, Math.max(this.w, this.h) * 1.6);
  }

  gracefulRelease(handIndex: number): void {
    this.charge[handIndex] = 0;
    this.firing[handIndex] = false;
    this.wasFiring[handIndex] = false;
    this.muzzle[handIndex] = 0;
    this.beamProgress[handIndex] = 0;
    this.recoil[handIndex] = 0;
    this.emitterCarry[handIndex] = 0;
    this.dualFistTime = 0;
    this.ultimateArmed = false;
    if (!this.ultimateFiring) this.ultimateCharge = 0;
  }

  getActiveCount(): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] > 0) n++;
    }
    return n;
  }

  stepDownQuality(): void {
    this.cap = Math.max(120, Math.floor(this.cap * 0.75));
    this.particleCursor %= this.cap;
  }
}
