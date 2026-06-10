import { HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig } from '../vfx-schema';

/**
 * The universal effect contract.
 * Every effect (Glitch Tiles, Particle Nebula, Light Ribbons) implements this interface.
 * State lives in plain objects/typed arrays — never React state.
 *
 * From the plan §3: "Each effect is a module exporting { init, step, draw }."
 */
export interface VfxEffect {
  /** Initialize effect state. Called once when the effect is first loaded. */
  init(config: EffectConfig, canvasWidth: number, canvasHeight: number): void;

  /**
   * Advance physics/simulation by dt seconds.
   * @param hands - The two hand signal slots (null if lost)
   * @param dt - Time delta in seconds, clamped to ≤ 0.033 (≤33ms)
   * @param ramp - 0→1 envelope from the session state machine; multiply forces/spawn by this
   * @param video - The live webcam video element (for effects that sample the video, like Glitch Tiles)
   */
  step(
    hands: [HandSignals | null, HandSignals | null],
    dt: number,
    ramp: number,
    video: HTMLVideoElement,
  ): void;

  /**
   * Render the current state onto the canvas.
   * @param ctx - The visible canvas 2D context
   * @param video - The webcam video element
   */
  draw(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): void;

  /**
   * Called when a hand transitions to LOST — the effect should gracefully
   * release any state tied to that hand (e.g., release grabbed tiles with
   * zero velocity, stop depositing ribbon ink, decay particle attraction).
   * From the plan §3: "never by the effect polling raw presence itself."
   */
  gracefulRelease(handIndex: number): void;

  /**
   * Returns the current active entity count (particles, tiles, chain nodes)
   * for the performance overlay. Cheap — the effect already knows this number.
   */
  getActiveCount(): number;

  /**
   * Whether this effect's draw already includes the video
   * (Glitch Tiles = true, the tiles ARE the video; others = false).
   * From the plan §3.1: "effectIncludesVideo"
   */
  readonly effectIncludesVideo: boolean;

  /**
   * Step down quality tier (reduce particle count, tile density, etc.)
   * Called by the adaptive quality system when frame time is too high.
   * One-way: never steps back up within a session.
   */
  stepDownQuality(): void;
}
