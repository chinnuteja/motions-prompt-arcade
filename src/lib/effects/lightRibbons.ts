import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, LightRibbonsConfig, PALETTES } from '../vfx-schema';
import { springStep, expDamp, curlNoise, makeGlowSprite, EmberPool } from './fxUtils';

/**
 * LIGHT RIBBONS  (config.effect === 'light_ribbons')
 *
 * A weighted follow-the-leader chain per hand draws flowing ink in the air.
 * The chain HEAD is a spring (mass + overshoot); the tail follows by lerp.
 * Rendering is volumetric (under-glow + twisting body + hot white filament).
 *
 * FORMATION — RUNE RINGS: draw a rough closed loop in the air and it SNAPS into
 * a perfect rotating holographic ring (Dr. Strange style) that persists in place.
 *
 * Schema params:
 *   brush       : 'ribbon' | 'lightning' | 'smoke'
 *   persistence : 'fading' | 'lasting'
 *   pinchAction : 'penDown' | 'widthControl'
 */

const CHAIN_LENGTH = 28;
const CHAIN_LERP = 0.35;
const PATH_MAX = 64; // ring buffer length for circle detection

interface Chain {
  nodes: Array<{ x: number; y: number }>;
  hvx: number;          // head velocity (spring integrator)
  hvy: number;
  depositing: boolean;
  speed: number;
  baseWidth: number;
}

interface RuneRing {
  x: number;
  y: number;
  r: number;
  age: number;
  maxAge: number;
  spin: number;
  flash: number;       // 1→0 spawn flash
  color: string;
}

interface RuneReveal {
  x: number;
  y: number;
  r: number;
  age: number;
  maxAge: number;
  color: string;
  spin: number;
}

export class LightRibbonsEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private config!: LightRibbonsConfig;
  private w = 0;
  private h = 0;
  private trailCanvas!: HTMLCanvasElement;
  private trailCtx!: CanvasRenderingContext2D;
  private chains: [Chain, Chain] = [this.createEmptyChain(), this.createEmptyChain()];
  private intensityMult = 1;
  private primary = '#ffffff';
  private secondary = '#ffffff';

  // Cached smoke puff sprites
  private smokeSprite!: [HTMLCanvasElement, HTMLCanvasElement];
  private sparkSprite!: HTMLCanvasElement;
  private sparks!: EmberPool;

  // Rune Ring formation
  private rings: RuneRing[] = [];
  private reveals: RuneReveal[] = [];
  private paths: [Array<{ x: number; y: number }>, Array<{ x: number; y: number }>] = [[], []];
  private widthCtrlTimer: [number, number] = [0, 0];
  private lastPinching: [boolean, boolean] = [false, false];

  // Quality
  private useShadow = true;
  private useRingGlow = true;
  private lightningLines = 3;
  private stampEveryOther = false;
  private frameParity = 0;

  private createEmptyChain(): Chain {
    return {
      nodes: Array.from({ length: CHAIN_LENGTH }, () => ({ x: 0, y: 0 })),
      hvx: 0,
      hvy: 0,
      depositing: false,
      speed: 0,
      baseWidth: 10,
    };
  }

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    if (config.effect !== 'light_ribbons') throw new Error('Wrong config type');
    this.config = config as LightRibbonsConfig;
    this.w = canvasWidth;
    this.h = canvasHeight;

    const palette = PALETTES[config.palette];
    this.primary = palette.primary;
    this.secondary = palette.secondary;
    this.intensityMult = config.intensity === 1 ? 0.6 : config.intensity === 2 ? 1.0 : 1.5;

    this.trailCanvas = document.createElement('canvas');
    this.trailCanvas.width = canvasWidth;
    this.trailCanvas.height = canvasHeight;
    const ctx = this.trailCanvas.getContext('2d');
    if (ctx) this.trailCtx = ctx;

    this.smokeSprite = [
      makeGlowSprite(128, palette.primary),
      makeGlowSprite(128, palette.secondary),
    ];
    this.sparkSprite = makeGlowSprite(24, '#ffffff');
    this.sparks = new EmberPool(config.intensity === 3 ? 220 : 140);
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    void _video;
    if (!this.trailCtx) return;
    this.frameParity ^= 1;

    // 1. Fade trail (dt-correct). fading ≈ ~2s, lasting ≈ ~20s.
    const fadeK = this.config.params.persistence === 'fading' ? 1.6 : 0.32;
    const fadeAlpha = 1 - expDamp(fadeK, dt);
    this.trailCtx.globalCompositeOperation = 'destination-out';
    this.trailCtx.fillStyle = `rgba(0,0,0,${fadeAlpha})`;
    this.trailCtx.fillRect(0, 0, this.w, this.h);
    this.trailCtx.globalCompositeOperation = 'source-over';

    const { pinchAction, brush } = this.config.params;

    for (let hi = 0; hi < 2; hi++) {
      const hand = hands[hi];
      const chain = this.chains[hi];

      let pinchJustEnded = false;

      if (hand && hand.track !== 'lost') {
        let isPenDown = false;
        let snapNeeded = false;

        if (pinchAction === 'penDown') {
          isPenDown = hand.pinching;
          if (!chain.depositing && isPenDown) snapNeeded = true;
          if (!isPenDown && this.lastPinching[hi]) pinchJustEnded = true;
          chain.baseWidth = 24 * this.intensityMult * ramp;
        } else {
          isPenDown = true;
          if (!chain.depositing && hand.framesSinceSeen === 0 && chain.nodes[0].x === 0) snapNeeded = true;
          chain.baseWidth = (8 + hand.pinch * 40) * this.intensityMult * ramp;
        }

        this.lastPinching[hi] = hand.pinching;
        chain.depositing = isPenDown;
        chain.speed = Math.hypot(hand.indexVel.x, hand.indexVel.y);

        if (snapNeeded) {
          for (let i = 0; i < CHAIN_LENGTH; i++) {
            chain.nodes[i].x = hand.indexTip.x;
            chain.nodes[i].y = hand.indexTip.y;
          }
          chain.hvx = 0;
          chain.hvy = 0;
          this.paths[hi] = []; // reset path on new stroke
        } else if (chain.depositing || hand.track === 'tracking') {
          // HEAD = spring toward fingertip
          const sx = springStep(chain.nodes[0].x, chain.hvx, hand.indexTip.x, 260, 22, dt);
          const sy = springStep(chain.nodes[0].y, chain.hvy, hand.indexTip.y, 260, 22, dt);
          chain.nodes[0].x = sx.pos; chain.hvx = sx.vel;
          chain.nodes[0].y = sy.pos; chain.hvy = sy.vel;
          
          // Tail follows
          for (let i = 1; i < CHAIN_LENGTH; i++) {
            chain.nodes[i].x += (chain.nodes[i - 1].x - chain.nodes[i].x) * CHAIN_LERP;
            chain.nodes[i].y += (chain.nodes[i - 1].y - chain.nodes[i].y) * CHAIN_LERP;
          }

          if (chain.depositing) {
            this.paths[hi].push({ x: chain.nodes[0].x, y: chain.nodes[0].y });
            if (this.paths[hi].length > PATH_MAX) this.paths[hi].shift();
          }
        }

        // Head sparks on fast strokes
        if (chain.depositing && chain.speed > 700 && ramp > 0.01) {
          const n = 2 + Math.floor(Math.random() * 3);
          for (let k = 0; k < n; k++) {
            this.sparks.spawn(
              chain.nodes[0].x, chain.nodes[0].y,
              -hand.indexVel.x * 0.1 + (Math.random() - 0.5) * 200,
              -hand.indexVel.y * 0.1 + (Math.random() - 0.5) * 200,
              0.3 + Math.random() * 0.3,
              6 + Math.random() * 8,
            );
          }
        }
      } else {
        // Hand lost: drain in place
        chain.depositing = false;
        for (let i = 1; i < CHAIN_LENGTH; i++) {
          chain.nodes[i].x += (chain.nodes[i - 1].x - chain.nodes[i].x) * CHAIN_LERP;
          chain.nodes[i].y += (chain.nodes[i - 1].y - chain.nodes[i].y) * CHAIN_LERP;
        }
      }

      // Check Rune Ring closure
      let tryDetectCircle = pinchJustEnded;
      if (pinchAction === 'widthControl' && chain.depositing) {
        this.widthCtrlTimer[hi] += dt;
        if (this.widthCtrlTimer[hi] > 0.5) {
          tryDetectCircle = true;
          this.widthCtrlTimer[hi] = 0;
        }
      }

      if (tryDetectCircle && this.paths[hi].length > 10) {
        this.detectRuneRing(hi);
      }

      // Smoke physics
      if (brush === 'smoke' && chain.depositing) {
        const t = performance.now() * 0.001;
        for (let i = 1; i < CHAIN_LENGTH; i++) {
          const c = curlNoise(chain.nodes[i].x, chain.nodes[i].y, t);
          chain.nodes[i].x += c.x * 30 * dt;
          chain.nodes[i].y += (c.y * 30 - 60) * dt; 
        }
      }

      // Stamp head
      if (chain.depositing && ramp > 0.01 && !(this.stampEveryOther && this.frameParity === 0)) {
        this.renderRibbonSegment(this.trailCtx, chain, hi, 0, 4, true);
      }
    }

    // Advance rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      r.spin += 0.6 * dt;
      if (r.flash > 0) r.flash = Math.max(0, r.flash - dt / 0.3);
      if (r.age >= r.maxAge) this.rings.splice(i, 1);
    }

    // Advance hologram reveal bursts
    for (let i = this.reveals.length - 1; i >= 0; i--) {
      const reveal = this.reveals[i];
      reveal.age += dt;
      reveal.spin += 2.4 * dt;
      if (reveal.age >= reveal.maxAge) this.reveals.splice(i, 1);
    }

    this.sparks.step(dt, 120, 1.5);
  }

  private detectRuneRing(hi: number) {
    const path = this.paths[hi];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let pathLen = 0;

    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      if (i > 0) {
        pathLen += Math.hypot(p.x - path[i-1].x, p.y - path[i-1].y);
      }
    }

    if (pathLen < 250) return; // too short

    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 10) return;

    // endpoints must be close relative to the total bounding box
    const gap = Math.hypot(path[0].x - path[path.length-1].x, path[0].y - path[path.length-1].y);
    if (gap > 0.18 * diag) return;

    // Centroid
    let cx = 0, cy = 0;
    for (const p of path) { cx += p.x; cy += p.y; }
    cx /= path.length;
    cy /= path.length;

    // Mean radius & stddev
    let meanR = 0;
    for (const p of path) meanR += Math.hypot(p.x - cx, p.y - cy);
    meanR /= path.length;

    let varR = 0;
    for (const p of path) {
      const d = Math.hypot(p.x - cx, p.y - cy);
      varR += (d - meanR) * (d - meanR);
    }
    const stddev = Math.sqrt(varR / path.length);

    if (stddev < 0.28 * meanR) {
      // It's a circle! Spawn Rune Ring.
      this.crystallizeRuneStroke(hi, cx, cy, meanR, path);
      this.rings.push({
        x: cx,
        y: cy,
        r: meanR,
        age: 0,
        maxAge: this.config.params.persistence === 'lasting' ? 14 : 6,
        spin: Math.random() * Math.PI,
        flash: 1,
        color: this.chainColor(hi)
      });
      if (this.rings.length > 4) this.rings.shift();
      this.reveals.push({
        x: cx,
        y: cy,
        r: meanR,
        age: 0,
        maxAge: 0.55,
        color: this.chainColor(hi),
        spin: Math.random() * Math.PI * 2,
      });
      if (this.reveals.length > 4) this.reveals.shift();
    }
  }

  private crystallizeRuneStroke(
    handIndex: number,
    cx: number,
    cy: number,
    r: number,
    path: Array<{ x: number; y: number }>,
  ): void {
    const chain = this.chains[handIndex];
    chain.depositing = false;
    chain.hvx = 0;
    chain.hvy = 0;
    this.lastPinching[handIndex] = false;
    this.widthCtrlTimer[handIndex] = 0;
    this.paths[handIndex] = [];

    // Vacuum the rough stroke out of the persistent ink layer immediately.
    // The crisp RuneRing is drawn live, so the offscreen trail can be cleared
    // without leaving the hand-drawn scribble under the hologram.
    const ctx = this.trailCtx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(0,0,0,0.96)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(r * 1.45, r + 56), 0, Math.PI * 2);
    ctx.fill();

    if (path.length > 1) {
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(42, r * 0.36);
      ctx.beginPath();
      ctx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Collapse the visible ribbon chain into the new geometric object so no
    // trailing tail remains after the snap.
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      const a = (i / CHAIN_LENGTH) * Math.PI * 2;
      chain.nodes[i].x = cx + Math.cos(a) * r;
      chain.nodes[i].y = cy + Math.sin(a) * r;
    }

    // Emit a rim of small particles as if the messy ink became a clean circuit.
    const colorSign = handIndex === 0 ? 1 : -1;
    const sparkCount = Math.min(28, Math.max(12, Math.floor(r / 7)));
    for (let i = 0; i < sparkCount; i++) {
      const a = (i / sparkCount) * Math.PI * 2;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      const tangentX = -Math.sin(a) * colorSign;
      const tangentY = Math.cos(a) * colorSign;
      this.sparks.spawn(
        px,
        py,
        tangentX * (140 + Math.random() * 90),
        tangentY * (140 + Math.random() * 90) - 20,
        0.35 + Math.random() * 0.25,
        7 + Math.random() * 8,
      );
    }
  }

  draw(ctx: CanvasRenderingContext2D, _video: HTMLVideoElement): void {
    void _video;
    ctx.drawImage(this.trailCanvas, 0, 0);
    ctx.globalCompositeOperation = 'lighter';

    for (let hi = 0; hi < 2; hi++) {
      const chain = this.chains[hi];
      if (chain.depositing) this.renderRibbonSegment(ctx, chain, hi, 0, CHAIN_LENGTH, false);
    }

    this.sparks.draw(ctx, this.sparkSprite);

    // Draw the short crystallization burst before the persistent rune so the
    // clean ring reads as the final, stable state.
    for (const reveal of this.reveals) {
      const t = Math.min(1, reveal.age / reveal.maxAge);
      const alpha = (1 - t) * (1 - t);
      const scanR = reveal.r * (0.72 + t * 0.52);

      ctx.save();
      ctx.translate(reveal.x, reveal.y);
      ctx.rotate(reveal.spin);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = 'screen';
      if (this.useRingGlow) {
        ctx.shadowBlur = 22;
        ctx.shadowColor = reveal.color;
      }

      ctx.strokeStyle = reveal.color;
      ctx.lineWidth = 2 + 6 * (1 - t);
      ctx.beginPath();
      ctx.arc(0, 0, scanR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255,255,255,${0.8 * alpha})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const inner = reveal.r * (0.45 + t * 0.18);
        const outer = reveal.r * (1.18 + t * 0.25);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.restore();
    }
    
    // Draw Rune Rings
    for (const ring of this.rings) {
      const fadeOut = Math.min(1, (ring.maxAge - ring.age) * 2);
      const fadeIn = Math.min(1, ring.age * 5);
      ctx.globalAlpha = fadeOut * fadeIn;

      ctx.save();
      ctx.translate(ring.x, ring.y);

      if (ring.flash > 0) {
        ctx.beginPath();
        ctx.arc(0, 0, ring.r + (1 - ring.flash) * 30, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${ring.flash})`;
        ctx.lineWidth = 6 * ring.flash;
        ctx.stroke();
      }

      if (this.useRingGlow) {
        ctx.shadowBlur = 15;
        ctx.shadowColor = ring.color;
      }

      // Main solid ring
      ctx.beginPath();
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Inner dashed counter-rotating ring
      ctx.save();
      ctx.rotate(-ring.spin * 1.5);
      ctx.beginPath();
      ctx.arc(0, 0, ring.r * 0.85, 0, Math.PI * 2);
      ctx.setLineDash([15, 15]);
      ctx.strokeStyle = this.secondary;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // Tick marks
      ctx.save();
      ctx.rotate(ring.spin);
      ctx.fillStyle = ring.color;
      for (let i = 0; i < 8; i++) {
        ctx.fillRect(ring.r * 1.1, -1.5, 8, 3);
        ctx.rotate(Math.PI / 4);
      }
      ctx.restore();

      // Orbiting bright dot
      const dotX = Math.cos(ring.spin * 2) * ring.r;
      const dotY = Math.sin(ring.spin * 2) * ring.r;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.restore();
    }

    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
  }

  gracefulRelease(handIndex: number): void {
    this.chains[handIndex].depositing = false;
  }

  getActiveCount(): number {
    let active = this.sparks.getAliveCount();
    for (const c of this.chains) if (c.depositing) active += CHAIN_LENGTH;
    return active;
  }

  stepDownQuality(): void {
    if (this.useShadow) { this.useShadow = false; this.intensityMult *= 0.8; return; }
    if (this.useRingGlow) { this.useRingGlow = false; return; }
    if (this.lightningLines > 2) { this.lightningLines = 2; this.sparks.halve(); return; }
    this.stampEveryOther = true;
  }

  private chainColor(handIndex: number): string {
    return handIndex === 0 ? this.primary : this.secondary;
  }

  private renderRibbonSegment(
    ctx: CanvasRenderingContext2D,
    chain: Chain,
    handIndex: number,
    startIdx: number,
    endIdx: number,
    isTrailStamp: boolean,
  ) {
    const { brush } = this.config.params;
    const speedMod = Math.max(0.4, Math.min(1.6, 1.6 - chain.speed * 0.0005));
    const maxW = chain.baseWidth * speedMod;

    if (brush === 'smoke') this.drawSmoke(ctx, chain, handIndex, startIdx, endIdx, maxW, isTrailStamp);
    else if (brush === 'lightning') this.drawLightning(ctx, chain, handIndex, startIdx, endIdx, maxW, isTrailStamp);
    else this.drawRibbon(ctx, chain, handIndex, startIdx, endIdx, maxW, isTrailStamp);
  }

  private drawRibbon(
    ctx: CanvasRenderingContext2D,
    chain: Chain,
    handIndex: number,
    startIdx: number,
    endIdx: number,
    maxW: number,
    isTrailStamp: boolean,
  ) {
    const leftEdge: Array<{ x: number; y: number }> = [];
    const rightEdge: Array<{ x: number; y: number }> = [];
    const t = performance.now() * 0.001;

    for (let i = startIdx; i < endIdx; i++) {
      let dx = 0, dy = 0;
      if (i === 0) {
        dx = chain.nodes[1].x - chain.nodes[0].x;
        dy = chain.nodes[1].y - chain.nodes[0].y;
      } else if (i === CHAIN_LENGTH - 1) {
        dx = chain.nodes[i].x - chain.nodes[i - 1].x;
        dy = chain.nodes[i].y - chain.nodes[i - 1].y;
      } else {
        dx = chain.nodes[i + 1].x - chain.nodes[i - 1].x;
        dy = chain.nodes[i + 1].y - chain.nodes[i - 1].y;
      }
      const len = Math.hypot(dx, dy);
      if (len > 0.001) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }

      const nx = -dy;
      const ny = dx;
      
      // 3D twist math
      const twist = Math.abs(Math.sin(i * 0.55 + t * 3));
      const twistW = 0.35 + 0.65 * twist;
      const taper = 1 - i / CHAIN_LENGTH;
      const wdt = maxW * taper * twistW;

      leftEdge.push({ x: chain.nodes[i].x + nx * wdt, y: chain.nodes[i].y + ny * wdt });
      rightEdge.push({ x: chain.nodes[i].x - nx * wdt, y: chain.nodes[i].y - ny * wdt });
    }
    if (leftEdge.length < 2) return;

    const head = chain.nodes[startIdx];
    const tail = chain.nodes[Math.min(endIdx - 1, CHAIN_LENGTH - 1)];
    const grad = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
    grad.addColorStop(0, this.primary);
    grad.addColorStop(1, this.secondary);

    // Pass 1: Wide soft underglow
    if (!isTrailStamp && this.useShadow) {
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = this.chainColor(handIndex);
      ctx.globalAlpha = 0.25;
      ctx.shadowBlur = 20;
      ctx.shadowColor = this.chainColor(handIndex);
      
      ctx.beginPath();
      for (let i = 0; i < leftEdge.length; i++) {
        const dx = leftEdge[i].x - chain.nodes[startIdx + i].x;
        const dy = leftEdge[i].y - chain.nodes[startIdx + i].y;
        ctx.lineTo(chain.nodes[startIdx + i].x + dx * 1.8, chain.nodes[startIdx + i].y + dy * 1.8);
      }
      for (let i = rightEdge.length - 1; i >= 0; i--) {
        const dx = rightEdge[i].x - chain.nodes[startIdx + i].x;
        const dy = rightEdge[i].y - chain.nodes[startIdx + i].y;
        ctx.lineTo(chain.nodes[startIdx + i].x + dx * 1.8, chain.nodes[startIdx + i].y + dy * 1.8);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Pass 2: Main body with twist
    ctx.fillStyle = grad;
    ctx.globalAlpha = isTrailStamp ? 0.8 : 0.9;
    if (this.useShadow) {
      ctx.shadowBlur = isTrailStamp ? 10 : 20;
      ctx.shadowColor = this.chainColor(handIndex);
    }

    ctx.beginPath();
    ctx.moveTo(leftEdge[0].x, leftEdge[0].y);
    for (let i = 1; i < leftEdge.length; i++) ctx.lineTo(leftEdge[i].x, leftEdge[i].y);
    for (let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i].x, rightEdge[i].y);
    ctx.closePath();
    ctx.fill();

    if (startIdx === 0) {
      ctx.fillStyle = this.primary;
      ctx.beginPath();
      ctx.arc(chain.nodes[0].x, chain.nodes[0].y, maxW, 0, Math.PI * 2);
      ctx.fill();
    }

    // Pass 3: Thin white centerline
    if (!isTrailStamp) {
      ctx.beginPath();
      ctx.moveTo(chain.nodes[startIdx].x, chain.nodes[startIdx].y);
      for (let i = startIdx + 1; i < endIdx; i++) {
        ctx.lineTo(chain.nodes[i].x, chain.nodes[i].y);
      }
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
  }

  private drawLightning(
    ctx: CanvasRenderingContext2D,
    chain: Chain,
    handIndex: number,
    startIdx: number,
    endIdx: number,
    maxW: number,
    isTrailStamp: boolean,
  ) {
    const lines = this.lightningLines;
    const jitterAmount = maxW * 1.5;
    const flicker = 0.7 + Math.random() * 0.3;
    const color = this.chainColor(handIndex);

    ctx.globalAlpha = (isTrailStamp ? 0.6 : 0.8) * flicker;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this.useShadow) { ctx.shadowBlur = isTrailStamp ? 10 : 30; ctx.shadowColor = color; }

    for (let l = 0; l < lines; l++) {
      ctx.beginPath();
      for (let i = startIdx; i < endIdx; i++) {
        const p1 = chain.nodes[i];
        const p2 = chain.nodes[Math.min(i + 1, CHAIN_LENGTH - 1)];
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len > 0.001) { dx /= len; dy /= len; }
        const nx = -dy;
        const ny = dx;
        const taper = 1 - i / CHAIN_LENGTH;
        const j = (Math.random() - 0.5) * jitterAmount * taper;
        const px = p1.x + nx * j;
        const py = p1.y + ny * j;
        if (i === startIdx) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, maxW * 0.2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, maxW * 0.5);
      ctx.stroke();
    }

    // Fork branches
    if (!isTrailStamp && Math.random() < 0.15 && endIdx - startIdx > 6) {
      const origin = startIdx + 2 + Math.floor(Math.random() * (endIdx - startIdx - 4));
      const p1 = chain.nodes[origin];
      const p2 = chain.nodes[Math.min(origin + 1, CHAIN_LENGTH - 1)];
      let bx = p2.x - p1.x;
      let by = p2.y - p1.y;
      const blen = Math.hypot(bx, by) || 1;
      bx /= blen; by /= blen;
      const sign = Math.random() < 0.5 ? 1 : -1;
      const ang = sign * (0.5 + Math.random() * 0.3);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let fx = p1.x;
      let fy = p1.y;
      let fdx = bx * ca - by * sa;
      let fdy = bx * sa + by * ca;
      const segs = 4 + Math.floor(Math.random() * 3);
      const stamp = this.trailCtx;
      stamp.globalAlpha = 0.7 * flicker;
      stamp.lineCap = 'round';
      if (this.useShadow) { stamp.shadowBlur = 12; stamp.shadowColor = color; }
      stamp.beginPath();
      stamp.moveTo(fx, fy);
      const step = (blen * (endIdx - startIdx)) / segs * 0.5;
      for (let s = 0; s < segs; s++) {
        fx += fdx * step + (Math.random() - 0.5) * step * 0.6;
        fy += fdy * step + (Math.random() - 0.5) * step * 0.6;
        stamp.lineTo(fx, fy);
        fdx += (Math.random() - 0.5) * 0.4;
        fdy += (Math.random() - 0.5) * 0.4;
      }
      stamp.strokeStyle = '#ffffff';
      stamp.lineWidth = Math.max(1, maxW * 0.18);
      stamp.stroke();
      stamp.strokeStyle = color;
      stamp.lineWidth = Math.max(1.5, maxW * 0.32);
      stamp.stroke();
      stamp.shadowBlur = 0;
      stamp.globalAlpha = 1;
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
  }

  private drawSmoke(
    ctx: CanvasRenderingContext2D,
    chain: Chain,
    handIndex: number,
    startIdx: number,
    endIdx: number,
    maxW: number,
    isTrailStamp: boolean,
  ) {
    const sprite = this.smokeSprite[handIndex];
    ctx.globalAlpha = isTrailStamp ? 0.15 : 0.25;
    for (let i = startIdx; i < endIdx; i++) {
      const p = chain.nodes[i];
      const taper = 1 - i / CHAIN_LENGTH;
      const r = maxW * (2 + (1 - taper) * 4);
      if (r <= 0.1) continue;
      ctx.globalAlpha = (isTrailStamp ? 0.12 : 0.22) * taper;
      ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1.0;
  }
}
