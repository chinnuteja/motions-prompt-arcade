/**
 * Placeholder effect: a glowing circle follows the index fingertip.
 * Used to test the EffectEngine shell before real effects are built.
 */
import { VfxEffect } from './types';
import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, PALETTES } from '../vfx-schema';

export class PlaceholderEffect implements VfxEffect {
  readonly effectIncludesVideo = false;

  private w = 0;
  private h = 0;
  private color = '#00f0ff';
  private positions: Array<{ x: number; y: number; alpha: number }> = [];

  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void {
    this.w = canvasWidth;
    this.h = canvasHeight;
    this.color = PALETTES[config.palette].primary;
    this.positions = [];
  }

  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    _video: HTMLVideoElement,
  ): void {
    // Add current fingertip positions to trail
    for (let h = 0; h < 2; h++) {
      const hand = hands[h];
      if (!hand || hand.track === 'lost') continue;
      this.positions.push({ x: hand.indexTip.x, y: hand.indexTip.y, alpha: ramp });
    }

    // Fade out trail
    for (let i = this.positions.length - 1; i >= 0; i--) {
      this.positions[i].alpha -= dt * 2;
      if (this.positions[i].alpha <= 0) {
        this.positions.splice(i, 1);
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, _video: HTMLVideoElement): void {
    // Draw trail
    for (const pos of this.positions) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 18, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.globalAlpha = pos.alpha * 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw current dots (brighter)
    for (const pos of this.positions.slice(-2)) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = pos.alpha;
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 24, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.globalAlpha = pos.alpha * 0.2;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  gracefulRelease(_handIndex: number): void {
    // Trail just fades naturally
  }

  getActiveCount(): number {
    return this.positions.length;
  }

  stepDownQuality(): void {
    // Nothing to degrade
  }
}
