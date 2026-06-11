// ─── One-Euro Filter ────────────────────────────────────────────
// Smooth when slow, responsive when fast. Standard filter for real-time
// interactive tracking. Beats plain EMA: low speed → heavy smoothing
// (kills jitter at rest), high speed → light smoothing (no lag).
// Ref: Casiez, Roussel, Vogel (2012), "1€ Filter".
//   minCutoff ↓  => more smoothing at low speed
//   beta      ↑  => more responsive at high speed

export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private initialized = false;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, dt: number): number {
    if (!this.initialized || dt <= 0) {
      this.xPrev = x; this.dxPrev = 0; this.initialized = true;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);
    this.xPrev = xHat; this.dxPrev = dxHat;
    return xHat;
  }
  reset(): void { this.initialized = false; this.xPrev = 0; this.dxPrev = 0; }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }
  filter(x: number, y: number, dt: number): { x: number; y: number } {
    return { x: this.fx.filter(x, dt), y: this.fy.filter(y, dt) };
  }
  reset(): void { this.fx.reset(); this.fy.reset(); }
}
