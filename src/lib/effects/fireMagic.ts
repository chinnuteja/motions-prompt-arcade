import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, FireMagicConfig, PALETTES } from '../vfx-schema';
import { curlNoise, expDamp, buildFireRamp, makeFlameSprite, makeGlowSprite, EmberPool, PingPongCanvas, clamp } from './fxUtils';

const BLOB_COUNTS = [220, 300, 380];
const SHOCK_LOBE_LIFE = 0.42; // seconds the directional eruption pressure licks live

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

interface ShockLobe {
  x: number;
  y: number;
  fx: number;
  fy: number;
  sx: number;
  sy: number;
  age: number;
  life: number;
  length: number;
  width: number;
  charge: number;
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
  private flash = [0, 0];                              // eruption flash decay, per hand
  private lastBasis: (HandBasis | null)[] = [null, null];
  private emitterCarry = [0, 0];                       // fractional deterministic stream emitters
  private burstCursor = 0;                             // overwrite cursor for one-shot seeded blobs

  // One-shot directional pressure licks. No perfect circles: the release follows the hand.
  private shockLobes: ShockLobe[] = [];

  // Carried into draw() so trail fade uses the real frame time, not a guess
  private lastDt = 1 / 60;

  // Assets
  private sprites!: { core: HTMLCanvasElement; mid: HTMLCanvasElement; cool: HTMLCanvasElement };
  private embers!: EmberPool;                          // sparse bright sparks — the crackle of life
  private emberSprite!: HTMLCanvasElement;
  private ringColor = 'rgb(255,255,255)';
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

    // Embers + shockwave inherit the palette's hottest stop so nothing is hardcoded orange.
    this.emberSprite = makeGlowSprite(16, ramp.core, 'rgba(0,0,0,0)');
    this.embers = new EmberPool(140);
    this.ringColor = ramp.core;

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
    this.lastDt = dt;
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
        this.lastBasis[hi] = null;
        this.emitterCarry[hi] = 0;
        continue;
      }

      const basis = this.getHandBasis(hand);
      this.lastBasis[hi] = basis;
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

        const chg = this.charge[hi];
        const burstMag = (1550 + 1450 * chg) * (isPlasma ? 1.15 : 1);
        // Capture scales with hand size so eruptions read the same near or far from camera.
        // The capture is cone-shaped, so the blast feels released from the palm instead of
        // stamped as a flat circular UI ripple.
        const captureR = Math.max(190, basis.scale * (3.2 + chg * 1.8));
        const baseWidth = Math.max(58, basis.scale * (0.7 + chg * 0.25));
        for (let i = 0; i < this.cap; i++) {
          const dx = this.x[i] - hand.palm.x;
          const dy = this.y[i] - hand.palm.y;
          const axial = dx * basis.forwardX + dy * basis.forwardY;
          const lateral = dx * basis.sideX + dy * basis.sideY;
          const forwardT = clamp((axial + basis.scale * 0.65) / captureR, 0, 1);
          const coneWidth = baseWidth + forwardT * basis.scale * (1.25 + chg);
          if (axial > -basis.scale * 1.15 && axial < captureR && Math.abs(lateral) < coneWidth) {
            const edge = 1 - Math.abs(lateral) / coneWidth;
            const thrust = burstMag * (0.62 + 0.55 * edge) * (1 - forwardT * 0.28);
            const sideKick = (lateral / Math.max(1, coneWidth)) * burstMag * 0.42;
            this.heat[i] = Math.max(this.heat[i], 0.82 + chg * 0.22);
            this.vx[i] += basis.forwardX * thrust + basis.sideX * sideKick;
            this.vy[i] += basis.forwardY * thrust + basis.sideY * sideKick - 90 * (1 - forwardT);
          }
        }
        // The payoff: a flash at the palm, an expanding heat ripple, and a shower of sparks.
        this.flash[hi] = 1;
        this.seedEruptionCone(hand, basis, chg);
        this.pushShockLobe(basis, chg);
        this.emberBurst(hand, basis, chg);
        this.charge[hi] = 0;
      } else if (isOpen) {
        this.wasFist[hi] = false;
        this.charge[hi] = Math.max(0, this.charge[hi] - dt * 2);
      }

      // Continuous fire logic
      if (isOpen) {
        if (this.config.params.eruption === 'flamethrower' && !eruptingThisFrame) {
          // Layered palm stream: dense core, rolling side flame, and knuckle contour.
          for (const src of this.flamethrowerSources(hand, basis)) activeSources.push(src);
          this.injectFlamethrower(hand, basis, hi, dt, ramp);
        } else if (this.config.params.eruption === 'burst' && !eruptingThisFrame) {
          // Fingertip jets! Fire shoots continuously from fingertips
          const fingertips = [8, 12, 16, 20];
          for (const ti of fingertips) {
            const lm = hand.landmarks[ti];
            if (lm) {
              activeSources.push({
                x: lm.x,
                y: lm.y,
                h: 0.85,
                vx: basis.forwardX * 600 + (Math.random() - 0.5) * 150 + hand.indexVel.x * 0.4,
                vy: basis.forwardY * 600 + (Math.random() - 0.5) * 150 + hand.indexVel.y * 0.4,
                spread: 14,
                radius: 0.7,
              });
            }
          }
        }
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
        // Respawn dead blob at a random active source. Spawn rate + heat follow the
        // session `ramp` envelope so the whole field blooms in and fades out gracefully.
        if (activeSources.length > 0 && Math.random() < 0.46 * ramp) {
          const src = activeSources[Math.floor(Math.random() * activeSources.length)];
          const spread = src.spread;
          this.resetBlob(
            i,
            src.x + (Math.random() - 0.5) * spread,
            src.y + (Math.random() - 0.5) * spread,
            src.vx * (0.82 + Math.random() * 0.36) + (Math.random() - 0.5) * 180,
            src.vy * (0.82 + Math.random() * 0.36) + (Math.random() - 0.5) * 180,
            src.h * ramp,
          );
          this.r[i] *= src.radius;
          // Occasional bright spark riding off the flame.
          if (Math.random() < 0.08) {
            this.embers.spawn(
              src.x,
              src.y,
              src.vx * 0.3 + (Math.random() - 0.5) * 80,
              src.vy * 0.3 - 40,
              0.6 + Math.random() * 0.6,
              3 + Math.random() * 3,
            );
          }
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
      const edgeLoss = this.y[i] < 0 || this.y[i] > this.h || this.x[i] < 0 || this.x[i] > this.w ? 0.35 : 0;
      const condensed = fistDist <= 95 ? 0.45 : 1;
      this.heat[i] -= this.heat[i] * (combustion * condensed + fastTear * dt * 3.0 + edgeLoss);
      if (this.heat[i] < 0.012) this.resetBlob(i);
    }

    // Decay transient flourishes and advance sparks (buoyant: negative gravity).
    for (let hi = 0; hi < 2; hi++) {
      if (this.flash[hi] > 0) this.flash[hi] = Math.max(0, this.flash[hi] - dt * 5);
    }
    for (let r = this.shockLobes.length - 1; r >= 0; r--) {
      this.shockLobes[r].age += dt;
      if (this.shockLobes[r].age > this.shockLobes[r].life) this.shockLobes.splice(r, 1);
    }
    this.embers.step(dt, -160, 1.5);
  }

  private pushShockLobe(basis: HandBasis, charge: number): void {
    const length = clamp(basis.scale * (4.6 + charge * 4.2), 260, 760);
    const width = clamp(basis.scale * (1.0 + charge * 1.45), 90, 340);
    this.shockLobes.push({
      x: basis.palmX,
      y: basis.palmY,
      fx: basis.forwardX,
      fy: basis.forwardY,
      sx: basis.sideX,
      sy: basis.sideY,
      age: 0,
      life: SHOCK_LOBE_LIFE + charge * 0.12,
      length,
      width,
      charge,
    });
    if (this.shockLobes.length > 4) this.shockLobes.shift();
  }

  private nextBurstSlot(): number {
    for (let a = 0; a < this.cap; a++) {
      const idx = (this.burstCursor + a) % this.cap;
      if (this.heat[idx] < 0.28) {
        this.burstCursor = (idx + 1) % this.cap;
        return idx;
      }
    }
    const idx = this.burstCursor % this.cap;
    this.burstCursor = (this.burstCursor + 1) % this.cap;
    return idx;
  }

  private seedBlob(
    x: number,
    y: number,
    vx: number,
    vy: number,
    heat: number,
    radiusMul: number,
  ): void {
    const i = this.nextBurstSlot();
    this.resetBlob(i, x, y, vx, vy, clamp(heat, 0, 1));
    this.r[i] *= radiusMul;
  }

  private seedEruptionCone(hand: HandSignals, basis: HandBasis, charge: number): void {
    const isPlasma = this.config.params.form === 'plasma';
    const count = Math.floor((isPlasma ? 72 : 96) + 76 * charge);
    const length = clamp(basis.scale * (5.2 + charge * (isPlasma ? 3.2 : 4.1)), 330, 880);
    const widthBase = basis.scale * (isPlasma ? 0.28 : 0.42);
    const widthGrow = basis.scale * (isPlasma ? 1.05 : 1.62) * (0.75 + charge * 0.5);
    const thrustBase = (isPlasma ? 1420 : 1180) + charge * (isPlasma ? 1250 : 1040);

    for (let i = 0; i < count; i++) {
      const u = Math.pow(Math.random(), 0.58);
      const axial = basis.scale * 0.18 + u * length;
      const width = widthBase + widthGrow * Math.sin(u * Math.PI * 0.88);
      const sideNorm = (Math.random() - 0.5) * 2;
      const lick = Math.sin(i * 1.73 + u * 9.0) * width * 0.12;
      const lateral = sideNorm * width * (0.18 + Math.random() * 0.82) + lick;
      const px = hand.palm.x + basis.forwardX * axial + basis.sideX * lateral;
      const py = hand.palm.y + basis.forwardY * axial + basis.sideY * lateral;
      const edge = 1 - Math.min(1, Math.abs(lateral) / Math.max(1, width));
      const speed = thrustBase * (1.05 - u * 0.28) * (0.78 + Math.random() * 0.42);
      const sideKick = sideNorm * (260 + 420 * charge) * (1 - u * 0.45);
      this.seedBlob(
        px,
        py,
        basis.forwardX * speed + basis.sideX * sideKick + hand.indexVel.x * 0.16,
        basis.forwardY * speed + basis.sideY * sideKick + hand.indexVel.y * 0.16 - (80 + 180 * u),
        0.72 + edge * 0.34 + charge * 0.12 - u * 0.18,
        (isPlasma ? 0.62 : 0.82) + edge * 0.45,
      );
    }
  }

  private emberBurst(hand: HandSignals, basis: HandBasis, charge: number): void {
    const n = Math.floor(30 + 50 * charge);
    for (let i = 0; i < n; i++) {
      const lateral = (Math.random() - 0.5) * 1.4;          // forward-biased cone
      const sp = 220 + Math.random() * 520 * (0.5 + charge);
      const vx = basis.forwardX * sp + basis.sideX * lateral * sp * 0.6 + (Math.random() - 0.5) * 120;
      const vy = basis.forwardY * sp + basis.sideY * lateral * sp * 0.6 + (Math.random() - 0.5) * 120 - 80;
      this.embers.spawn(hand.palm.x, hand.palm.y, vx, vy, 0.6 + Math.random() * 0.8, 3 + Math.random() * 4);
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

  private flamethrowerSources(hand: HandSignals, basis: HandBasis): HeatSource[] {
    const isPlasma = this.config.params.form === 'plasma';
    const speed = isPlasma ? 1680 : 1450;
    const sources = this.handContourSources(hand, basis, 1.0, speed);
    const coreHeat = isPlasma ? 1.05 : 0.96;
    const coreSpread = clamp(basis.scale * (isPlasma ? 0.16 : 0.24), 12, 34);

    for (let lane = -1; lane <= 1; lane++) {
      const side = lane * basis.scale * (isPlasma ? 0.12 : 0.18);
      const laneSpeed = speed * (lane === 0 ? 1.08 : 0.86);
      sources.push({
        x: basis.palmX + basis.forwardX * basis.scale * 0.2 + basis.sideX * side,
        y: basis.palmY + basis.forwardY * basis.scale * 0.2 + basis.sideY * side,
        h: coreHeat,
        vx: basis.forwardX * laneSpeed + basis.sideX * lane * 180 + hand.indexVel.x * 0.2,
        vy: basis.forwardY * laneSpeed + basis.sideY * lane * 180 + hand.indexVel.y * 0.2 - 95,
        spread: coreSpread,
        radius: lane === 0 ? 0.9 : 0.72,
      });
    }

    return sources;
  }

  private injectFlamethrower(
    hand: HandSignals,
    basis: HandBasis,
    handIndex: number,
    dt: number,
    ramp: number,
  ): void {
    if (ramp <= 0.02) return;

    const isPlasma = this.config.params.form === 'plasma';
    const intensityBoost = 0.82 + this.config.intensity * 0.16;
    const rate = (isPlasma ? 105 : 132) * intensityBoost * ramp;
    this.emitterCarry[handIndex] += rate * dt;
    const n = Math.min(9, Math.floor(this.emitterCarry[handIndex]));
    this.emitterCarry[handIndex] -= n;

    const fingertips = [8, 12, 16, 20];
    for (let i = 0; i < n; i++) {
      const fromPalmCore = Math.random() < 0.48;
      const lm = fromPalmCore
        ? hand.palm
        : (hand.landmarks[fingertips[Math.floor(Math.random() * fingertips.length)]] || hand.palm);
      const u = Math.random();
      const sideNorm = (Math.random() - 0.5) * 2;
      const width = basis.scale * (isPlasma ? 0.42 : 0.72) * (0.35 + u);
      const axialJitter = basis.scale * (fromPalmCore ? 0.18 + u * 0.28 : 0.04);
      const px = lm.x + basis.forwardX * axialJitter + basis.sideX * sideNorm * width * 0.42;
      const py = lm.y + basis.forwardY * axialJitter + basis.sideY * sideNorm * width * 0.42;
      const speed = (isPlasma ? 1540 : 1320) * (0.85 + Math.random() * 0.55);
      const sideKick = sideNorm * (isPlasma ? 260 : 390) * (0.55 + Math.random() * 0.75);
      const heat = (isPlasma ? 0.92 : 0.82) + Math.random() * 0.18;

      this.seedBlob(
        px,
        py,
        basis.forwardX * speed + basis.sideX * sideKick + hand.indexVel.x * 0.18,
        basis.forwardY * speed + basis.sideY * sideKick + hand.indexVel.y * 0.18 - (isPlasma ? 60 : 130),
        heat,
        fromPalmCore ? (isPlasma ? 0.7 : 0.96) : (isPlasma ? 0.52 : 0.68),
      );

      if (Math.random() < 0.18) {
        this.embers.spawn(
          px,
          py,
          basis.forwardX * speed * 0.28 + basis.sideX * sideKick * 0.55,
          basis.forwardY * speed * 0.28 + basis.sideY * sideKick * 0.55 - 120,
          0.42 + Math.random() * 0.55,
          2.5 + Math.random() * 3.5,
        );
      }
    }
  }

  private microCurl(x: number, y: number, t: number): { x: number; y: number } {
    const s1 = 0.027;
    const s2 = 0.043;
    const a = Math.sin(x * s1 + t * 9.0) * Math.cos(y * s1 - t * 7.0);
    const b = Math.cos(x * s2 - t * 11.0) * Math.sin(y * s2 + t * 8.0);
    return { x: b - a * 0.35, y: -a - b * 0.35 };
  }

  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void {
    void video;

    // 1. Darken the engine-drawn video background so fire pops.
    ctx.fillStyle = this.bgTreatment;
    ctx.fillRect(0, 0, this.w, this.h);

    // 2. Update Ping-Pong Canvas (Half Res)
    const pw = this.ppc.width;
    const ph = this.ppc.height;
    const writeCtx = this.ppc.writeCtx;

    // Clear write buffer
    writeCtx.clearRect(0, 0, pw, ph);

    // Real frame time from the last step() so trails fade consistently off 60fps.
    const dt = this.lastDt;
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

    // Charge orb (condensing core) + eruption flash, stamped into the heat field.
    for (let hi = 0; hi < 2; hi++) {
      const basis = this.lastBasis[hi];
      if (!basis) continue;
      const px = basis.palmX * hw;
      const py = basis.palmY * hh;

      const chg = this.charge[hi];
      if (chg > 0.05) {
        // Condenses (shrinks) and brightens as the charge fills — power gathering in.
        const orbR = (38 - 16 * chg) * hw;
        writeCtx.globalAlpha = 0.25 + 0.6 * chg;
        writeCtx.drawImage(this.sprites.core, px - orbR, py - orbR, orbR * 2, orbR * 2);
      }

      const f = this.flash[hi];
      if (f > 0.01) {
        const fr = basis.scale * 1.4 * hw;
        writeCtx.globalAlpha = f;
        writeCtx.drawImage(this.sprites.core, px - fr, py - fr, fr * 2, fr * 2);
      }
    }

    // Directional pressure licks. These replace the old perfect circle shockwave.
    writeCtx.strokeStyle = this.ringColor;
    writeCtx.lineCap = 'round';
    writeCtx.lineJoin = 'round';
    const lineScale = (hw + hh) * 0.5;
    const now = performance.now() * 0.001;
    for (const lobe of this.shockLobes) {
      const p = lobe.age / lobe.life;
      if (p >= 1) continue;
      const ease = 1 - Math.pow(1 - p, 3);
      const alpha = (1 - p) * (0.22 + lobe.charge * 0.34);

      for (let lane = -2; lane <= 2; lane++) {
        const laneNorm = lane / 2;
        const laneFade = 1 - Math.abs(laneNorm) * 0.34;
        const wiggle = Math.sin(now * 18 + lane * 2.1 + p * 9.0) * lobe.width * 0.08 * (1 - p);
        const startSide = laneNorm * lobe.width * 0.08;
        const midSide = laneNorm * lobe.width * (0.52 + p * 0.36) + wiggle;
        const endSide = laneNorm * lobe.width * (0.9 + p * 0.4) + wiggle * 1.5;
        const len = lobe.length * ease * (lane === 0 ? 1 : 0.82 + Math.abs(laneNorm) * 0.16);

        const x0 = (lobe.x + lobe.sx * startSide) * hw;
        const y0 = (lobe.y + lobe.sy * startSide) * hh;
        const cx = (lobe.x + lobe.fx * len * 0.48 + lobe.sx * midSide) * hw;
        const cy = (lobe.y + lobe.fy * len * 0.48 + lobe.sy * midSide - 34 * (1 - p)) * hh;
        const x1 = (lobe.x + lobe.fx * len + lobe.sx * endSide) * hw;
        const y1 = (lobe.y + lobe.fy * len + lobe.sy * endSide - 58 * p) * hh;

        writeCtx.globalAlpha = alpha * laneFade;
        writeCtx.lineWidth = Math.max(1, (10 - Math.abs(lane) * 2.2) * (1 - p) * lineScale);
        writeCtx.beginPath();
        writeCtx.moveTo(x0, y0);
        writeCtx.quadraticCurveTo(cx, cy, x1, y1);
        writeCtx.stroke();
      }

      if (p < 0.72) {
        for (let s = 0; s < 3; s++) {
          const q = (s + 1) / 4 * ease;
          const wobble = Math.sin(now * 22 + s * 1.9) * lobe.width * 0.1 * (1 - p);
          const px = (lobe.x + lobe.fx * lobe.length * q + lobe.sx * wobble) * hw;
          const py = (lobe.y + lobe.fy * lobe.length * q + lobe.sy * wobble - 32 * p) * hh;
          const rr = (28 + lobe.charge * 38) * (1 - p) * lineScale;
          writeCtx.globalAlpha = alpha * 0.65;
          writeCtx.drawImage(this.sprites.core, px - rr, py - rr, rr * 2, rr * 2);
        }
      }
    }
    writeCtx.globalAlpha = 1;

    this.ppc.swap();

    // 3. Composite fire up to main canvas
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.ppc.read, 0, 0, this.w, this.h);

    // Crisp charge glow on top: a heartbeat that beats faster as the charge fills.
    const t = performance.now() * 0.001;
    ctx.globalCompositeOperation = 'lighter';
    for (let hi = 0; hi < 2; hi++) {
      const basis = this.lastBasis[hi];
      const chg = this.charge[hi];
      if (!basis || chg <= 0.05) continue;
      const pulse = 1 + 0.08 * Math.sin(t * (8 + 12 * chg));
      const gr = (30 + 10 * chg) * pulse;
      ctx.globalAlpha = 0.4 * chg;
      ctx.drawImage(this.sprites.core, basis.palmX - gr, basis.palmY - gr, gr * 2, gr * 2);
    }

    // Sparks ride on top of the composited fire.
    this.embers.draw(ctx, this.emberSprite);

    ctx.globalAlpha = 1;
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
    this.embers.halve();
  }
}
