import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, FireMagicConfig, PALETTES } from '../vfx-schema';
import { curlNoise, expDamp, buildFireRamp, makeFlameSprite, PingPongCanvas, clamp } from './fxUtils';

const BLOB_COUNTS = [220, 300, 380];

interface HandBasis {
  palmX: number;
  palmY: number;
  forwardX: number;
  forwardY: number;
  sideX: number;
  sideY: number;
  twist: number;
  scale: number;
}

interface HeatSource {
  x: number;
  y: number;
  h: number;
  vx: number;
  vy: number;
  spread: number;
  radius: number;
}

export class FireMagicEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private config!: FireMagicConfig;
  private ppc!: PingPongCanvas;
  private w = 0;
  private h = 0;

  // Blob SoA
  private cap = 0;
  private x!: Float32Array;
  private y!: Float32Array;
  private vx!: Float32Array;
  private vy!: Float32Array;
  private r!: Float32Array;
  private heat!: Float32Array;
  
  // Hand state
  private charge = [0, 0];
  private wasFist = [false, false];

  // Assets
  private sprites!: { core: HTMLCanvasElement; mid: HTMLCanvasElement; cool: HTMLCanvasElement };
  private bgTreatment = 'rgba(0,0,0,0)';

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'fire_magic') throw new Error('Wrong config type');
    this.config = config as FireMagicConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    // Ping pong canvas is half resolution
    this.ppc = new PingPongCanvas(Math.floor(canvasWidth / 2), Math.floor(canvasHeight / 2));

    const palette = PALETTES[config.palette];
    this.bgTreatment = palette.bgTreatment || 'rgba(0,0,0,0.4)';
    const ramp = buildFireRamp(palette);
    
    // Form: wildfire = larger, softer. plasma = tighter, saturated.
    const isPlasma = this.config.params.form === 'plasma';
    const baseR = isPlasma ? 28 : 42;
    
    this.sprites = {
      core: makeFlameSprite(baseR * 1.5, ramp.core, ramp.mid),
      mid: makeFlameSprite(baseR * 1.8, ramp.mid, ramp.cool),
      cool: makeFlameSprite(baseR * 2.2, ramp.cool, 'rgba(0,0,0,0)'),
    };

    this.cap = BLOB_COUNTS[config.intensity - 1] || 300;
    this.x = new Float32Array(this.cap);
    this.y = new Float32Array(this.cap);
    this.vx = new Float32Array(this.cap);
    this.vy = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.heat = new Float32Array(this.cap);

    for (let i = 0; i < this.cap; i++) {
      this.resetBlob(i);
      this.x[i] = Math.random() * this.w;
      this.y[i] = Math.random() * this.h;
    }
  }

  private resetBlob(i: number, px = -100, py = -100, vx = 0, vy = 0, h = 0) {
    this.x[i] = px;
    this.y[i] = py;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.heat[i] = h;
    const isPlasma = this.config.params.form === 'plasma';
    this.r[i] = (isPlasma ? 10 : 14) + Math.random() * (isPlasma ? 22 : 34);
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    void _video;
    const t = performance.now() * 0.001;
    const isPlasma = this.config.params.form === 'plasma';
    const curlStrength = isPlasma ? 260 : 340;
    const microCurlStrength = isPlasma ? 420 : 520;
    const buoyancy = isPlasma ? 680 : 520;

    // Heat sources from hands
    const activeSources: HeatSource[] = [];

    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      if (!hand || hand.track === 'lost') {
        this.charge[hi] = 0;
        this.wasFist[hi] = false;
        continue;
      }

      const basis = this.getHandBasis(hand);
      const isFist = hand.openness < 0.4;
      const isOpen = hand.openness > 0.65;
      
      // CONDENSE
      if (isFist) {
        this.charge[hi] = Math.min(1, this.charge[hi] + dt / 1.2); // charge 0->1 over 1.2s
        this.wasFist[hi] = true;
      }
      
      // ERUPTION burst
      let eruptingThisFrame = false;
      if (isOpen && this.wasFist[hi] && this.charge[hi] > 0.15) {
        eruptingThisFrame = true;
        this.wasFist[hi] = false;
        
        const burstMag = 1500 + 1200 * this.charge[hi];
        for (let i = 0; i < this.cap; i++) {
          const dx = this.x[i] - hand.palm.x;
          const dy = this.y[i] - hand.palm.y;
          const dist = Math.hypot(dx, dy) || 1;
          if (dist < 150) {
            this.heat[i] = 1;
            const contour = ((dx * basis.sideX + dy * basis.sideY) / Math.max(1, basis.scale)) * 0.35;
            this.vx[i] += basis.forwardX * burstMag + basis.sideX * contour * burstMag + (dx / dist) * burstMag * 0.35;
            this.vy[i] += basis.forwardY * burstMag + basis.sideY * contour * burstMag - burstMag * 0.18;
          }
        }
        this.charge[hi] = 0;
      } else if (isOpen) {
        this.wasFist[hi] = false;
        this.charge[hi] = Math.max(0, this.charge[hi] - dt * 2);
      }

      // Flamethrower mode
      if (isOpen && this.config.params.eruption === 'flamethrower' && !eruptingThisFrame) {
        // A tight ribbon of sources along the knuckles, launched in the hand's
        // forward direction and sheared by wrist twist.
        for (const src of this.handContourSources(hand, basis, 1.0, 1350)) activeSources.push(src);
      }

      // Pilot flames (idle)
      if (hand.openness >= 0.4 && hand.openness <= 0.65) {
        for (const src of this.handContourSources(hand, basis, 0.72, 520)) activeSources.push(src);
      }

      if (isFist && this.charge[hi] > 0.05) {
        activeSources.push({
          x: basis.palmX,
          y: basis.palmY,
          h: 0.6 + this.charge[hi] * 0.4,
          vx: basis.sideX * 220 * basis.twist + hand.indexVel.x * 0.2,
          vy: basis.sideY * 220 * basis.twist + hand.indexVel.y * 0.2,
          spread: Math.max(10, basis.scale * 0.18),
          radius: 0.65,
        });
      }
    }

    const damp = expDamp(isPlasma ? 3.7 : 3.0, dt);
    const heatDamp = expDamp(this.config.params.trails === 'smoky' ? 3.2 : 5.6, dt);
    
    // Physics pass
    for (let i = 0; i < this.cap; i++) {
      if (this.heat[i] <= 0.01) {
        // Respawn dead blob at a random active source
        if (activeSources.length > 0 && Math.random() < 0.46) {
          const src = activeSources[Math.floor(Math.random() * activeSources.length)];
          const spread = src.spread;
          this.resetBlob(
            i,
            src.x + (Math.random() - 0.5) * spread,
            src.y + (Math.random() - 0.5) * spread,
            src.vx * (0.82 + Math.random() * 0.36) + (Math.random() - 0.5) * 180,
            src.vy * (0.82 + Math.random() * 0.36) + (Math.random() - 0.5) * 180,
            src.h,
          );
          this.r[i] *= src.radius;
        }
        continue;
      }

      // Fist attraction / tangential swirl
      let fistDist = Infinity;
      let fx = 0, fy = 0;
      
      for (let hi = 0; hi < 2; hi++) {
        if (this.charge[hi] > 0) {
          const hand = hands[hi]!;
          const dx = hand.palm.x - this.x[i];
          const dy = hand.palm.y - this.y[i];
          const d = Math.hypot(dx, dy);
          if (d < fistDist) fistDist = d;
          
          if (d < 180) {
            const capR = Math.max(30, 180 - 150 * this.charge[hi]);
            const pull = (d > capR ? 1000 : -200) * this.charge[hi] * dt;
            fx += (dx / (d || 1)) * pull;
            fy += (dy / (d || 1)) * pull;
            // Swirl
            const swirl = 800 * this.charge[hi] * dt;
            fx += (-dy / (d || 1)) * swirl;
            fy += (dx / (d || 1)) * swirl;
            this.heat[i] = Math.max(this.heat[i], this.charge[hi]);
          }
        }
      }

      // Advection
      const c = curlNoise(this.x[i], this.y[i], t * 1.8);
      const micro = this.microCurl(this.x[i], this.y[i], t + i * 0.013);
      const tear = Math.sin(this.x[i] * 0.035 + t * 28 + i) * Math.cos(this.y[i] * 0.028 - t * 21);
      this.vx[i] += (c.x * curlStrength + micro.x * microCurlStrength + tear * 150) * dt + fx;
      this.vy[i] += (c.y * curlStrength + micro.y * microCurlStrength - this.heat[i] * buoyancy - Math.abs(tear) * 70) * dt + fy;

      this.vx[i] *= damp;
      this.vy[i] *= damp;
      
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      
      const speed = Math.hypot(this.vx[i], this.vy[i]);
      const combustion = 1 - heatDamp;
      const fastTear = clamp(speed / 1800, 0, 0.55);
      const edgeLoss = this.y[i] < 0 || this.x[i] < 0 || this.x[i] > this.w ? 0.35 : 0;
      const condensed = fistDist <= 95 ? 0.45 : 1;
      this.heat[i] -= this.heat[i] * (combustion * condensed + fastTear * dt * 3.0 + edgeLoss);
      if (this.heat[i] < 0.012) this.resetBlob(i);
    }
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

    const cross = forwardX * sideY - forwardY * sideX;
    const twist = clamp(cross, -1, 1);
    return {
      palmX: hand.palm.x,
      palmY: hand.palm.y,
      forwardX,
      forwardY,
      sideX,
      sideY,
      twist,
      scale: Math.max(32, hand.scale),
    };
  }

  private handContourSources(hand: HandSignals, basis: HandBasis, heat: number, speed: number): HeatSource[] {
    const sources: HeatSource[] = [];
    const contour = [5, 9, 13, 17, 8, 12, 16, 20];
    const twistShear = basis.twist * 360;
    for (let i = 0; i < contour.length; i++) {
      const lm = hand.landmarks[contour[i]];
      if (!lm) continue;
      const sideOffset = ((i / Math.max(1, contour.length - 1)) - 0.5) * 2;
      const flameSpeed = speed * (0.82 + Math.random() * 0.28);
      sources.push({
        x: lm.x + basis.sideX * sideOffset * basis.scale * 0.05,
        y: lm.y + basis.sideY * sideOffset * basis.scale * 0.05,
        h: heat,
        vx: basis.forwardX * flameSpeed + basis.sideX * twistShear * sideOffset + hand.indexVel.x * 0.35,
        vy: basis.forwardY * flameSpeed + basis.sideY * twistShear * sideOffset + hand.indexVel.y * 0.35 - 120,
        spread: clamp(basis.scale * 0.22, 12, 32),
        radius: contour[i] >= 8 ? 0.58 : 0.78,
      });
    }
    return sources;
  }

  private microCurl(x: number, y: number, t: number): { x: number; y: number } {
    const s1 = 0.027;
    const s2 = 0.043;
    const a = Math.sin(x * s1 + t * 9.0) * Math.cos(y * s1 - t * 7.0);
    const b = Math.cos(x * s2 - t * 11.0) * Math.sin(y * s2 + t * 8.0);
    return { x: b - a * 0.35, y: -a - b * 0.35 };
  }

  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
    // 1. Draw video background (since effectIncludesVideo = false)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.translate(-this.w, 0);
    ctx.drawImage(video, 0, 0, this.w, this.h);
    ctx.restore();

    // Darken background so fire pops
    ctx.fillStyle = this.bgTreatment;
    ctx.fillRect(0, 0, this.w, this.h);

    // 2. Update Ping-Pong Canvas (Half Res)
    const pw = this.ppc.width;
    const ph = this.ppc.height;
    const writeCtx = this.ppc.writeCtx;

    // Clear write buffer
    writeCtx.clearRect(0, 0, pw, ph);

    // Calculate delta time for visual feedback loop (assume ~60fps)
    const dt = 1 / 60;
    const k = this.config.params.trails === 'smoky' ? 7.5 : 12.0;
    const fade = 1 - Math.exp(-k * dt);

    writeCtx.save();
    // Feedback transform: quick rise + contraction. This prevents old blobs from
    // hanging around as smoke and makes the field read as volatile plasma.
    writeCtx.translate(pw / 2, ph);
    writeCtx.scale(0.994, 0.988);
    writeCtx.translate(-pw / 2 + Math.sin(performance.now() * 0.035) * 1.2, -ph - 165 * dt);
    
    writeCtx.globalAlpha = Math.max(0, 1 - fade);
    writeCtx.globalCompositeOperation = 'source-over';
    writeCtx.drawImage(this.ppc.read, 0, 0);
    writeCtx.restore();

    // Stamp new blobs additively
    writeCtx.globalCompositeOperation = 'lighter';
    const hw = pw / this.w;
    const hh = ph / this.h;
    const isPlasma = this.config.params.form === 'plasma';

    for (let i = 0; i < this.cap; i++) {
      if (this.heat[i] <= 0.05) continue;
      
      let sprite = this.sprites.cool;
      if (this.heat[i] > 0.6) sprite = this.sprites.core;
      else if (this.heat[i] > 0.3 || isPlasma) sprite = this.sprites.mid;

      const px = this.x[i] * hw;
      const py = this.y[i] * hh;
      const pr = this.r[i] * hw;
      
      writeCtx.globalAlpha = this.heat[i] * this.heat[i];
      writeCtx.drawImage(sprite, px - pr, py - pr, pr * 2, pr * 2);
    }

    // Draw palm charging cores
    for (let hi = 0; hi < 2; hi++) {
      if (this.charge[hi] > 0.1) {
        // We could draw a bright spot here if we tracked palm pos into state
      }
    }

    this.ppc.swap();

    // 3. Composite fire up to main canvas
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.ppc.read, 0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'source-over';
  }

  gracefulRelease(handIndex: number): void {
    this.charge[handIndex] = 0;
    this.wasFist[handIndex] = false;
  }

  getActiveCount(): number {
    let count = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.heat[i] > 0) count++;
    }
    return count;
  }

  stepDownQuality(): void {
    const newCap = Math.max(100, Math.floor(this.cap * 0.75));
    this.cap = newCap;
  }
}
