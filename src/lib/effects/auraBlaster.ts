import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, AuraBlasterConfig, PALETTES } from '../vfx-schema';
import { expDamp, PingPongCanvas, clamp, makeGlowSprite } from './fxUtils';

const PARTICLE_COUNT = 400;

export class AuraBlasterEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private config!: AuraBlasterConfig;
  private ppc!: PingPongCanvas;
  private w = 0;
  private h = 0;

  // State
  private charge = [0, 0];
  private firing = [false, false];

  // Particles (for charge suck-in and beam trailing)
  private px!: Float32Array;
  private py!: Float32Array;
  private pvx!: Float32Array;
  private pvy!: Float32Array;
  private life!: Float32Array;
  private pType!: Uint8Array; // 0 = ambient/suck, 1 = blast spark

  private spriteCore!: HTMLCanvasElement;
  private spriteGlow!: HTMLCanvasElement;
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

    this.px = new Float32Array(PARTICLE_COUNT);
    this.py = new Float32Array(PARTICLE_COUNT);
    this.pvx = new Float32Array(PARTICLE_COUNT);
    this.pvy = new Float32Array(PARTICLE_COUNT);
    this.life = new Float32Array(PARTICLE_COUNT);
    this.pType = new Uint8Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.resetParticle(i);
      this.px[i] = Math.random() * this.w;
      this.py[i] = Math.random() * this.h;
    }
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
    video: HTMLVideoElement
  ): void {
    this.lastHands = hands;
    
    // 1. Process Hands
    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (!hand || hand.track === 'lost') {
        this.charge[hi] = Math.max(0, this.charge[hi] - dt);
        this.firing[hi] = false;
        continue;
      }

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

    // 2. Process Particles
    const damp = expDamp(2.0, dt);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Find if we should spawn a blast particle
        let spawned = false;
        for (let hi = 0; hi < 2; hi++) {
          if (this.firing[hi] && Math.random() < 0.2) {
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
              const pull = (4000 / dist) * this.charge[hi];
              this.pvx[i] += (dx / dist) * pull * dt;
              this.pvy[i] += (dy / dist) * pull * dt;
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
    // Determine screen shake magnitude
    let shakeX = 0;
    let shakeY = 0;
    let maxCharge = 0;
    let isAnyFiring = false;
    
    for (let hi = 0; hi < 2; hi++) {
      if (this.charge[hi] > maxCharge) maxCharge = this.charge[hi];
      if (this.firing[hi]) isAnyFiring = true;
    }

    if (maxCharge > 0.5) {
      const shakeMag = (maxCharge - 0.5) * 12 + (isAnyFiring ? 15 : 0);
      shakeX = (Math.random() - 0.5) * shakeMag;
      shakeY = (Math.random() - 0.5) * shakeMag;
    }

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
    writeCtx.globalAlpha = 0.85; // Feedback persistence
    writeCtx.globalCompositeOperation = 'source-over';
    writeCtx.drawImage(this.ppc.read, 0, 0);
    writeCtx.restore();

    writeCtx.globalCompositeOperation = 'lighter';
    const hw = pw / this.w;
    const hh = ph / this.h;
    
    // Draw particles into ping-pong
    const palette = PALETTES[this.config.palette];
    writeCtx.fillStyle = palette.primary;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      if (this.life[i] > 0) {
        const x = this.px[i] * hw;
        const y = this.py[i] * hh;
        const r = this.pType[i] === 1 ? 3 : 1.5;
        writeCtx.globalAlpha = Math.min(1, this.life[i] * 2);
        writeCtx.beginPath();
        writeCtx.arc(x, y, r, 0, Math.PI * 2);
        writeCtx.fill();
      }
    }

    this.ppc.swap();

    // Composite Feedback onto main canvas
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.ppc.read, 0, 0, this.w, this.h);

    // Draw Beams and Charge Spheres directly onto main canvas for max resolution and brightness
    ctx.globalCompositeOperation = 'screen';
    
    for (let hi = 0; hi < 2; hi++) {
      const hand = this.lastHands[hi];
      if (!hand) continue;

      const basis = this.getHandBasis(hand);
      const intensity = this.charge[hi];

      // Draw Charge Sphere
      if (intensity > 0.05 && !this.firing[hi]) {
        const radius = 20 + intensity * 60;
        ctx.globalAlpha = Math.min(1, intensity * 1.5);
        ctx.drawImage(this.spriteGlow, basis.palmX - radius * 2, basis.palmY - radius * 2, radius * 4, radius * 4);
        ctx.drawImage(this.spriteCore, basis.palmX - radius, basis.palmY - radius, radius * 2, radius * 2);
      }

      // Draw Beam!
      if (this.firing[hi]) {
        const beamLength = Math.max(this.w, this.h) * 1.5;
        const beamWidth = 40 + intensity * 80;

        ctx.save();
        ctx.translate(basis.palmX, basis.palmY);
        // Calculate rotation angle
        const angle = Math.atan2(basis.forwardY, basis.forwardX);
        ctx.rotate(angle);

        // Core of the beam
        ctx.globalAlpha = Math.min(1, intensity * 2);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(0, -beamWidth * 0.3);
        ctx.lineTo(beamLength, -beamWidth * 0.1);
        ctx.lineTo(beamLength, beamWidth * 0.1);
        ctx.lineTo(0, beamWidth * 0.3);
        ctx.fill();

        // Outer glow of the beam
        const grad = ctx.createLinearGradient(0, -beamWidth, 0, beamWidth);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.3, palette.primary);
        grad.addColorStop(0.5, '#ffffff');
        grad.addColorStop(0.7, palette.primary);
        grad.addColorStop(1, 'rgba(0,0,0,0)');

        ctx.fillStyle = grad;
        ctx.globalAlpha = Math.min(1, intensity);
        ctx.fillRect(0, -beamWidth, beamLength, beamWidth * 2);

        // Beam origin sphere blast
        const blastRadius = beamWidth * 1.5;
        ctx.globalAlpha = 1;
        ctx.drawImage(this.spriteCore, -blastRadius, -blastRadius, blastRadius * 2, blastRadius * 2);

        ctx.restore();
      }
    }
    
    ctx.restore();
  }

  gracefulRelease(handIndex: number): void {
    this.charge[handIndex] = 0;
    this.firing[handIndex] = false;
  }

  getActiveCount(): number {
    return PARTICLE_COUNT;
  }

  stepDownQuality(): void {
    // No-op for this effect, PARTICLE_COUNT is low enough
  }
}


