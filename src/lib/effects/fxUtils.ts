/**
 * Shared physics + rendering utilities for all Hand VFX engines.
 *
 * Design rules baked in here:
 *  - Every time-dependent decay is frame-rate INDEPENDENT (uses dt, not per-frame constants).
 *  - Anything allocated per-frame in the old engines (gradients especially) is pre-rendered once here.
 *  - Pools are fixed-capacity SoA (Float32Array) so the hot loops never allocate.
 */

import { PaletteColors } from '../vfx-schema';

// ─── Physics ─────────────────────────────────────────────────────

/**
 * Frame-rate-independent damping factor.
 * Multiply a velocity by this each step to decay it at a continuous rate `k` (1/sec).
 * At dt→0 this approaches 1 (no decay); larger k = faster decay.
 *
 * Replaces the old `v *= 0.88` pattern, which decayed PER FRAME and therefore
 * felt twice as draggy at 30fps as at 60fps.
 */
export function expDamp(k: number, dt: number): number {
  return Math.exp(-k * dt);
}

/**
 * Semi-implicit (symplectic) Euler spring-damper toward a target.
 * Returns the new { pos, vel }. Stable for stiff springs at large dt because
 * velocity is updated from the NEW spring force before integrating position.
 *
 *   stiffness  ~ how hard it's pulled to target (acceleration per px of error)
 *   damping    ~ velocity bleed (1/sec); critical damping ≈ 2*sqrt(stiffness)
 *
 * Used for: card hover/follow, held-card lag, ribbon head weight.
 */
export function springStep(
  pos: number,
  vel: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number,
): { pos: number; vel: number } {
  const accel = (target - pos) * stiffness;
  let v = vel + accel * dt;
  v *= expDamp(damping, dt);
  return { pos: pos + v * dt, vel: v };
}

/**
 * Cheap divergence-free-ish curl noise. Coherent swirling flow field.
 * Shared by nebula 'swarm' drift and the smoke brush billow.
 */
export function curlNoise(x: number, y: number, t: number): { x: number; y: number } {
  const scale = 0.005;
  const n1 = Math.sin(x * scale + t) * Math.cos(y * scale + t);
  const n2 = Math.cos(x * scale - t) * Math.sin(y * scale - t);
  return { x: n2, y: -n1 };
}

/** easeOutBack — slight overshoot, used for card pop-in. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linear interpolation between two hex colors. Returns an `rgb(...)` string. */
export function lerpColor(hexA: string, hexB: string, t: number): string {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const r = Math.round(lerp(a.r, b.r, t));
  const g = Math.round(lerp(a.g, b.g, t));
  const bl = Math.round(lerp(a.b, b.b, t));
  return `rgb(${r},${g},${bl})`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// ─── Rendering ───────────────────────────────────────────────────

/** Path a rounded rectangle (centered-agnostic; caller supplies top-left). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Pre-render a soft radial-gradient glow sprite ONCE.
 * Replaces every per-frame `createRadialGradient` in the old engines.
 * Draw it additively (globalCompositeOperation='lighter' or 'screen') and scale
 * via drawImage's dest w/h — never re-create the gradient.
 */
export function makeGlowSprite(
  size: number,
  innerColor: string,
  outerColor = 'rgba(0,0,0,0)',
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, innerColor);
    grad.addColorStop(0.4, innerColor);
    grad.addColorStop(1, outerColor);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * A vertical white→transparent sheen strip for the glass-card specular highlight.
 * Cached once; drawn rotated/offset per card so the highlight slides as cards tilt.
 */
export function makeSheenSprite(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  return c;
}

// ─── Ember / spark pool ──────────────────────────────────────────

/**
 * Fixed-capacity pooled particle system (SoA). Zero allocation in the hot loop.
 * Used by: card fire trails, ribbon head sparks. Drawn additively with a glow sprite.
 *
 * capacity is set at init and can be halved by an effect's stepDownQuality().
 */
export class EmberPool {
  private cap: number;
  private x: Float32Array;
  private y: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private life: Float32Array;   // seconds remaining
  private maxLife: Float32Array;
  private size: Float32Array;
  private head = 0;             // ring-buffer write cursor
  private alive = 0;

  constructor(capacity: number) {
    this.cap = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number, size: number): void {
    const i = this.head;
    if (this.life[i] <= 0) this.alive++;   // reusing a dead slot grows the live count
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.head = (i + 1) % this.cap;
  }

  /** Advance all live embers. gravity in px/s². drag is a continuous damping rate. */
  step(dt: number, gravity: number, drag: number): void {
    const damp = expDamp(drag, dt);
    let count = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      this.vy[i] += gravity * dt;
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      count++;
    }
    this.alive = count;
  }

  /** Additive draw. Caller sets globalCompositeOperation. */
  draw(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement): void {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      const t = this.life[i] / this.maxLife[i];   // 1→0 over lifetime
      const s = this.size[i] * (0.4 + 0.6 * t);
      ctx.globalAlpha = t;
      ctx.drawImage(sprite, this.x[i] - s / 2, this.y[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  getAliveCount(): number {
    return this.alive;
  }

  /** Halve capacity (quality step-down). Existing embers beyond the new cap are dropped. */
  halve(): void {
    const newCap = Math.max(16, Math.floor(this.cap / 2));
    if (newCap === this.cap) return;
    this.cap = newCap;
    this.x = this.x.slice(0, newCap);
    this.y = this.y.slice(0, newCap);
    this.vx = this.vx.slice(0, newCap);
    this.vy = this.vy.slice(0, newCap);
    this.life = this.life.slice(0, newCap);
    this.maxLife = this.maxLife.slice(0, newCap);
    this.size = this.size.slice(0, newCap);
    this.head = this.head % newCap;
  }
}

// ─── Fire (continuous plasma) ────────────────────────────────────

export interface FireRamp {
  core: string;   // white-hot center
  mid: string;    // body of the flame
  cool: string;   // cooling edges / smoke fringe
}

/**
 * Derive a coherent 3-stop fire color ramp from a palette.
 * ember → realistic orange fire; ocean → blue plasma; acid → green flame; etc.
 * core blends white→glow, mid = glow→primary, cool = primary→secondary.
 */
export function buildFireRamp(palette: PaletteColors): FireRamp {
  return {
    core: lerpColor('#ffffff', palette.glow, 0.35),
    mid: lerpColor(palette.glow, palette.primary, 0.5),
    cool: lerpColor(palette.primary, palette.secondary, 0.6),
  };
}

/**
 * Big soft flame blob sprite. Same machinery as makeGlowSprite but with softer
 * mid-stops so heavily-overlapped blobs read as one continuous volume of fire,
 * never as distinct dots.
 */
export function makeFlameSprite(size: number, inner: string, outer = 'rgba(0,0,0,0)'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (ctx) {
    const r = size / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.25, inner);
    grad.addColorStop(0.7, outer === 'rgba(0,0,0,0)' ? inner : outer);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/**
 * Two offscreen canvases that swap roles each frame. Required for a fire feedback
 * loop: you draw the PREVIOUS frame onto the next one (offset/scaled/faded) so
 * discrete stamps melt into continuous rising flame. Kept at half-res for speed
 * (the upscale on final composite further softens it into plasma).
 */
export class PingPongCanvas {
  private a: HTMLCanvasElement;
  private b: HTMLCanvasElement;
  readonly ctxA: CanvasRenderingContext2D;
  readonly ctxB: CanvasRenderingContext2D;
  private flipped = false;

  constructor(public readonly width: number, public readonly height: number) {
    this.a = document.createElement('canvas');
    this.b = document.createElement('canvas');
    this.a.width = this.b.width = width;
    this.a.height = this.b.height = height;
    this.ctxA = this.a.getContext('2d')!;
    this.ctxB = this.b.getContext('2d')!;
  }

  /** The canvas holding last frame (source to read from). */
  get read(): HTMLCanvasElement {
    return this.flipped ? this.b : this.a;
  }

  /** The canvas to render this frame into (destination). */
  get write(): HTMLCanvasElement {
    return this.flipped ? this.a : this.b;
  }

  get writeCtx(): CanvasRenderingContext2D {
    return this.flipped ? this.ctxA : this.ctxB;
  }

  swap(): void {
    this.flipped = !this.flipped;
  }
}
