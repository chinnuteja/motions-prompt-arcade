import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, AuraBlasterConfig, PALETTES } from '../vfx-schema';
import { expDamp, PingPongCanvas, makeGlowSprite } from './fxUtils';

const PARTICLE_COUNTS = [240, 400, 560];   // per intensity tier
const BOLT_SEGMENTS = 14;                    // electric-style polyline node count

export class AuraBlasterEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private config!: AuraBlasterConfig;
  private ppc!: PingPongCanvas;
  private w = 0;
  private h = 0;

  // State
  private charge = [0, 0];
  private firing = [false, false];
  private wasFiring = [false, false];          // for false→true onset detection
  private muzzle = [0, 0];                      // fire-onset flash, decays per hand
  private beamProgress = [0, 0];                // 0→1 eased beam extension on fire
  private shake = 0;                            // one-shot decaying shake impulse
  private intensityMul = 1;                     // beam/shake scale from intensity tier
  private lastDt = 1 / 60;

  // Particles (for charge suck-in and beam trailing)
  private cap = 400;
  private px!: Float32Array;
  private py!: Float32Array;
  private pvx!: Float32Array;
  private pvy!: Float32Array;
  private life!: Float32Array;
  private pType!: Uint8Array; // 0 = ambient/suck, 1 = blast spark

  // Electric bolt node offsets (regenerated on a timer, never per-frame allocated)
  private boltOffset = new Float32Array(BOLT_SEGMENTS);
  private boltTimer = 0;

  private spriteCore!: HTMLCanvasElement;
  private spriteGlow!: HTMLCanvasElement;
  private spriteParticle!: HTMLCanvasElement;
  private beamStrip!: HTMLCanvasElement;        // pre-rendered beam cross-section gradient
  private bgTreatment = 'rgba(0,0,0,0)';

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'aura_blaster') throw new Error('Wrong config type');
    this.config = config as AuraBlasterConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    // Ping pong canvas for glow feedback
    this.ppc = new PingPongCanvas(Math.floor(canvasWidth / 2), Math.floor(canvasHeight / 2));

    const palette = PALETTES[config.palette];
    this.bgTreatment = palette.bgTreatment || 'rgba(0,0,0,0.6)';

    this.spriteCore = makeGlowSprite(60, '#ffffff', palette.primary);
    this.spriteGlow = makeGlowSprite(120, palette.primary, 'rgba(0,0,0,0)');
    this.spriteParticle = makeGlowSprite(8, palette.primary, 'rgba(0,0,0,0)');
    this.beamStrip = this.makeBeamStrip(palette.primary);

    // Intensity drives particle density and the beam/shake scale.
    this.intensityMul = [0.85, 1.0, 1.15][config.intensity - 1] ?? 1.0;
    this.cap = PARTICLE_COUNTS[config.intensity - 1] ?? 400;

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

  /** Vertical cross-section of the beam (transparent → palette → white → palette → transparent). */
  private makeBeamStrip(primary: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.3, primary);
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(0.7, primary);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 64);
    return c;
  }

  private resetParticle(i: number, isBlast = false, originX = 0, originY = 0, dirX = 0, dirY = 0, speed = 0) {
    if (isBlast) {
      this.px[i] = originX;
      this.py[i] = originY;
      this.pvx[i] = dirX * speed + (Math.random() - 0.5) * speed * 0.2;
      this.pvy[i] = dirY * speed + (Math.random() - 0.5) * speed * 0.2;
      this.life[i] = 0.5 + Math.random() * 0.5;
      this.pType[i] = 1;
    } else {
      this.px[i] = Math.random() * this.w;
      this.py[i] = Math.random() * this.h;
      this.pvx[i] = (Math.random() - 0.5) * 50;
      this.pvy[i] = (Math.random() - 0.5) * 50;
      this.life[i] = Math.random();
      this.pType[i] = 0;
    }
  }

  // Need to store hands to draw them since step() is separated from draw()
  private lastHands: [HandSignals | null, HandSignals | null] = [null, null];
  
  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement
  ): void {
    void _video;
    this.lastHands = hands;
    this.lastDt = dt;
    const isVortex = this.config.params.chargeEffect === 'vortex';

    // 1. Process Hands
    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (!hand || hand.track === 'lost') {
        this.charge[hi] = Math.max(0, this.charge[hi] - dt);
        this.firing[hi] = false;
      } else {
        const isFist = hand.openness < 0.35;
        const isOpen = hand.openness > 0.7;

        if (isFist) {
          // Charging!
          this.charge[hi] = Math.min(1.5, this.charge[hi] + dt * 0.8);
          this.firing[hi] = false;
        } else if (isOpen && this.charge[hi] > 0.1) {
          // Firing!
          this.firing[hi] = true;
          this.charge[hi] = Math.max(0, this.charge[hi] - dt * 0.4); // Drains over ~3 seconds
        } else {
          // Idle
          this.firing[hi] = false;
          this.charge[hi] = Math.max(0, this.charge[hi] - dt * 0.5);
        }
      }

      // Fire onset: a single muzzle flash + shake kick, and the beam extends from 0.
      if (this.firing[hi] && !this.wasFiring[hi]) {
        this.muzzle[hi] = 1;
        this.beamProgress[hi] = 0;
        this.shake = Math.max(this.shake, 10 * this.intensityMul * ramp);
      }
      this.muzzle[hi] = Math.max(0, this.muzzle[hi] - dt * 5);
      this.beamProgress[hi] = this.firing[hi]
        ? Math.min(1, this.beamProgress[hi] + dt * 10)   // ~100ms ease-in to full length
        : 0;
      this.wasFiring[hi] = this.firing[hi];
    }

    // Shake decays toward zero; a small sustained rumble is added in draw() while firing.
    this.shake *= expDamp(8, dt);

    // Electric bolt jitter regenerates on a timer, not every frame.
    this.boltTimer -= dt;
    if (this.boltTimer <= 0) {
      this.boltTimer = 0.04;
      for (let s = 0; s < BOLT_SEGMENTS; s++) {
        // Taper offsets toward the ends so the bolt anchors at palm and tip.
        const taper = Math.sin((s / (BOLT_SEGMENTS - 1)) * Math.PI);
        this.boltOffset[s] = (Math.random() - 0.5) * taper;
      }
    }

    // 2. Process Particles
    const damp = expDamp(2.0, dt);
    for (let i = 0; i < this.cap; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Find if we should spawn a blast particle
        let spawned = false;
        for (let hi = 0; hi < 2; hi++) {
          if (this.firing[hi] && Math.random() < 0.2 * ramp) {
            const hand = hands[hi]!;
            const basis = this.getHandBasis(hand);
            this.resetParticle(i, true, basis.palmX, basis.palmY, basis.forwardX, basis.forwardY, 1500 + Math.random() * 1000);
            spawned = true;
            break;
          }
        }
        if (!spawned) {
          this.resetParticle(i, false);
        }
        continue;
      }

      if (this.pType[i] === 0) {
        // Ambient particle: gets sucked into charging hands
        let affected = false;
        for (let hi = 0; hi < 2; hi++) {
          const hand = hands[hi];
          if (!hand) continue;

          if (this.firing[hi]) {
            // Beam violently blows particles away and supercharges them!
            const basis = this.getHandBasis(hand);
            const dx = this.px[i] - basis.palmX;
            const dy = this.py[i] - basis.palmY;
            
            // If particle is in front of the hand
            const dotForward = dx * basis.forwardX + dy * basis.forwardY;
            if (dotForward > -100) {
              const dist = Math.hypot(dx, dy) || 1;
              const push = (150000 / (dist + 50)) * this.charge[hi];
              
              // Push strongly forward, and slightly outward from the beam core
              this.pvx[i] += basis.forwardX * push * dt + (dx / dist) * push * 0.3 * dt;
              this.pvy[i] += basis.forwardY * push * dt + (dy / dist) * push * 0.3 * dt;
              
              // Supercharge the particle
              this.life[i] = Math.max(this.life[i], 0.8);
              this.pType[i] = 1; // Convert to blast spark
              affected = true;
            }
          } else if (this.charge[hi] > 0) {
            // Ambient suck-in during charge
            const dx = hand.palm.x - this.px[i];
            const dy = hand.palm.y - this.py[i];
            const dist = Math.hypot(dx, dy) || 1;
            if (dist < 400) {
              const pull = (4000 / dist) * this.charge[hi] * ramp;
              this.pvx[i] += (dx / dist) * pull * dt;
              this.pvy[i] += (dy / dist) * pull * dt;
              // Vortex: tangential swirl so particles visibly orbit before collapsing in.
              if (isVortex) {
                const swirl = (2600 / dist) * this.charge[hi] * ramp;
                this.pvx[i] += (-dy / dist) * swirl * dt;
                this.pvy[i] += (dx / dist) * swirl * dt;
              }
              affected = true;
            }
            if (dist < 30) {
              this.life[i] = 0; // Consume into the sphere
            }
          }
        }
        if (!affected) {
          // Slow drift
          this.pvx[i] += (Math.random() - 0.5) * 100 * dt;
          this.pvy[i] += (Math.random() - 0.5) * 100 * dt;
        }
      }

      this.pvx[i] *= damp;
      this.pvy[i] *= damp;
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;
    }
  }

  private getHandBasis(hand: HandSignals) {
    const wrist = hand.landmarks[0] || hand.palm;
    const middleMcp = hand.landmarks[9] || hand.palm;

    let forwardX = middleMcp.x - wrist.x;
    let forwardY = middleMcp.y - wrist.y;
    const fLen = Math.hypot(forwardX, forwardY) || 1;
    forwardX /= fLen;
    forwardY /= fLen;

    return {
      palmX: hand.palm.x,
      palmY: hand.palm.y,
      forwardX,
      forwardY,
      scale: Math.max(32, hand.scale),
    };
  }

  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
    const t = performance.now() * 0.001;

    // Screen shake: a decaying fire-onset impulse, plus restrained context rumble.
    // Charging stays calm until nearly full (anticipation, not constant noise).
    let maxCharge = 0;
    let isAnyFiring = false;
    for (let hi = 0; hi < 2; hi++) {
      if (this.charge[hi] > maxCharge) maxCharge = this.charge[hi];
      if (this.firing[hi]) isAnyFiring = true;
    }

    let shakeMag = this.shake;                         // one-shot impulse (decays in step)
    if (isAnyFiring) shakeMag += 3 * this.intensityMul; // subtle sustained rumble
    else if (maxCharge > 0.9) shakeMag += 2;            // tiny "ready" tremble near full
    const shakeX = shakeMag > 0.1 ? (Math.random() - 0.5) * shakeMag : 0;
    const shakeY = shakeMag > 0.1 ? (Math.random() - 0.5) * shakeMag : 0;

    ctx.save();
    
    // Draw Video Background with optional shake
    ctx.translate(shakeX, shakeY);
    
    ctx.save();
    ctx.scale(-1, 1);
    ctx.translate(-this.w, 0);
    ctx.drawImage(video, 0, 0, this.w, this.h);
    ctx.restore();

    // Darken background to make the beam pop
    ctx.fillStyle = this.bgTreatment;
    ctx.fillRect(0, 0, this.w, this.h);

    // Update Ping Pong Canvas for Aura/Trails
    const pw = this.ppc.width;
    const ph = this.ppc.height;
    const writeCtx = this.ppc.writeCtx;

    writeCtx.clearRect(0, 0, pw, ph);
    writeCtx.save();
    writeCtx.translate(pw / 2, ph / 2);
    // Slight outward expansion for aura trails
    writeCtx.scale(1.01, 1.01);
    writeCtx.translate(-pw / 2, -ph / 2);
    // Frame-rate-independent persistence (was a hardcoded 0.85 per frame).
    writeCtx.globalAlpha = expDamp(9.7, this.lastDt);
    writeCtx.globalCompositeOperation = 'source-over';
    writeCtx.drawImage(this.ppc.read, 0, 0);
    writeCtx.restore();

    writeCtx.globalCompositeOperation = 'lighter';
    const hw = pw / this.w;
    const hh = ph / this.h;

    // Draw particles into ping-pong via a pre-rendered soft sprite (no per-particle path ops).
    // implosion → inward-collapsing streaks aligned to velocity; otherwise soft dots.
    const isImplosion = this.config.params.chargeEffect === 'implosion';
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      const x = this.px[i] * hw;
      const y = this.py[i] * hh;
      const blast = this.pType[i] === 1;
      const s = blast ? 7 : 4;
      writeCtx.globalAlpha = Math.min(1, this.life[i] * 2);
      if (isImplosion && !blast) {
        // Streak from the particle back along its velocity to read as collapsing inward.
        const tailX = (this.px[i] - this.pvx[i] * 0.03) * hw;
        const tailY = (this.py[i] - this.pvy[i] * 0.03) * hh;
        const steps = 3;
        for (let k = 0; k <= steps; k++) {
          const f = k / steps;
          writeCtx.globalAlpha = Math.min(1, this.life[i] * 2) * (0.3 + 0.7 * f);
          writeCtx.drawImage(this.spriteParticle, x + (tailX - x) * (1 - f) - s / 2, y + (tailY - y) * (1 - f) - s / 2, s, s);
        }
      } else {
        writeCtx.drawImage(this.spriteParticle, x - s / 2, y - s / 2, s, s);
      }
    }

    this.ppc.swap();

    // Composite Feedback onto main canvas
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.ppc.read, 0, 0, this.w, this.h);

    // Draw Beams and Charge Spheres directly onto main canvas for max resolution and brightness
    ctx.globalCompositeOperation = 'screen';
    const palette = PALETTES[this.config.palette];

    for (let hi = 0; hi < 2; hi++) {
      const hand = this.lastHands[hi];
      if (!hand) continue;

      const basis = this.getHandBasis(hand);
      const intensity = this.charge[hi];

      // Draw Charge Sphere (with chargeEffect flavor + heartbeat that quickens as it fills)
      if (intensity > 0.05 && !this.firing[hi]) {
        const pulse = 1 + 0.08 * Math.sin(t * (8 + 12 * Math.min(1, intensity)));
        // implosion condenses the core slightly as it fills; vortex keeps it steady.
        const condense = isImplosion ? 1 - 0.18 * Math.min(1, intensity) : 1;
        const radius = (20 + intensity * 60) * condense * pulse;
        ctx.globalAlpha = Math.min(1, intensity * 1.5);
        ctx.drawImage(this.spriteGlow, basis.palmX - radius * 2, basis.palmY - radius * 2, radius * 4, radius * 4);
        ctx.drawImage(this.spriteCore, basis.palmX - radius, basis.palmY - radius, radius * 2, radius * 2);

        // Vortex: a slim rotating elliptical ring around the sphere.
        if (!isImplosion) {
          ctx.save();
          ctx.translate(basis.palmX, basis.palmY);
          ctx.rotate(t * 3);
          ctx.globalAlpha = Math.min(1, intensity) * 0.5;
          ctx.strokeStyle = palette.primary;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(0, 0, radius * 1.7, radius * 0.6, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Muzzle flash on fire onset (bright core stamp at the palm).
      if (this.muzzle[hi] > 0.01) {
        const fr = (50 + intensity * 60) * this.muzzle[hi];
        ctx.globalAlpha = this.muzzle[hi];
        ctx.drawImage(this.spriteCore, basis.palmX - fr, basis.palmY - fr, fr * 2, fr * 2);
      }

      // Draw Beam!
      if (this.firing[hi]) {
        const angle = Math.atan2(basis.forwardY, basis.forwardX);
        // Fizzle: as charge runs out, the beam narrows and its alpha flickers.
        const fizzle = intensity < 0.25 ? intensity / 0.25 : 1;
        const flicker = fizzle < 1 ? 0.7 + 0.3 * Math.random() : 1;
        const fullLength = Math.max(this.w, this.h) * 1.5;
        const beamLength = fullLength * this.beamProgress[hi];   // ~100ms ease-in
        const beamWidth = (40 + intensity * 80) * this.intensityMul * fizzle;

        ctx.save();
        ctx.translate(basis.palmX, basis.palmY);
        ctx.rotate(angle);
        this.drawBeam(ctx, beamLength, beamWidth, intensity * flicker, t);
        // Beam origin sphere blast
        const blastRadius = beamWidth * 1.5;
        ctx.globalAlpha = flicker;
        ctx.drawImage(this.spriteCore, -blastRadius, -blastRadius, blastRadius * 2, blastRadius * 2);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /** Render one beam in the current (already palm-translated + rotated) frame, style-dependent. */
  private drawBeam(
    ctx: CanvasRenderingContext2D,
    len: number,
    width: number,
    intensity: number,
    t: number,
  ): void {
    if (len < 1) return;
    const style = this.config.params.beamStyle;
    const a = Math.min(1, intensity);

    if (style === 'electric') {
      // Jagged bolt: polyline from palm to tip with timed perpendicular jitter.
      const glow = width * 0.9;
      ctx.globalAlpha = a * 0.5;
      ctx.drawImage(this.beamStrip, 0, -glow, len, glow * 2); // soft glow behind
      const drawBolt = (amp: number, alpha: number, lw: number) => {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        for (let s = 1; s < BOLT_SEGMENTS; s++) {
          const f = s / (BOLT_SEGMENTS - 1);
          ctx.lineTo(len * f, this.boltOffset[s] * amp);
        }
        ctx.stroke();
      };
      drawBolt(width * 1.6, a, Math.max(2, width * 0.18));      // main bolt
      drawBolt(width * 2.6, a * 0.35, Math.max(1, width * 0.1)); // fainter branch
      return;
    }

    if (style === 'laser') {
      // Thin, crisp, constant width.
      const w = Math.max(8, width * 0.35);
      ctx.globalAlpha = a * 0.8;
      ctx.drawImage(this.beamStrip, 0, -w, len, w * 2);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, -w * 0.18, len, w * 0.36);
      return;
    }

    // plasma (default): living beam whose width undulates along its length.
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const segs = 10;
    // top edge out, bottom edge back — a gently wavy quad.
    for (let s = 0; s <= segs; s++) {
      const f = s / segs;
      const wob = 1 + 0.12 * Math.sin(f * 6 - t * 9);
      const yEdge = -(width * 0.3) * (1 - f * 0.7) * wob;
      if (s === 0) ctx.moveTo(len * f, yEdge);
      else ctx.lineTo(len * f, yEdge);
    }
    for (let s = segs; s >= 0; s--) {
      const f = s / segs;
      const wob = 1 + 0.12 * Math.sin(f * 6 - t * 9 + Math.PI);
      const yEdge = (width * 0.3) * (1 - f * 0.7) * wob;
      ctx.lineTo(len * f, yEdge);
    }
    ctx.closePath();
    ctx.fill();

    // Outer glow via the pre-rendered strip (no per-frame gradient).
    ctx.globalAlpha = a;
    ctx.drawImage(this.beamStrip, 0, -width, len, width * 2);
  }

  gracefulRelease(handIndex: number): void {
    this.charge[handIndex] = 0;
    this.firing[handIndex] = false;
    this.wasFiring[handIndex] = false;
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
  }
}


