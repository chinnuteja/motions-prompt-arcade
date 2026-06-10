import { z } from 'zod';

// ─── Effect Types ───────────────────────────────────────────────

export type EffectType = 'glitch_tiles' | 'particle_nebula' | 'light_ribbons' | 'fire_magic';

export type PaletteId = 'neon' | 'ember' | 'vapor' | 'mono' | 'acid' | 'ocean';

// ─── Palette Presets (client-side only, never sent to LLM) ──────

export interface PaletteColors {
  primary: string;
  secondary: string;
  glow: string;
  bgTreatment: string; // rgba overlay on the dimmed video
}

export const PALETTES: Record<PaletteId, PaletteColors> = {
  neon:  { primary: '#00f0ff', secondary: '#ff00e5', glow: '#00f0ff', bgTreatment: 'rgba(0,0,0,0.25)' },
  ember: { primary: '#ff6a00', secondary: '#ff2200', glow: '#ff8800', bgTreatment: 'rgba(20,5,0,0.25)' },
  vapor: { primary: '#ff77cc', secondary: '#aa55ff', glow: '#ff99dd', bgTreatment: 'rgba(15,5,20,0.25)' },
  mono:  { primary: '#ffffff', secondary: '#888888', glow: '#cccccc', bgTreatment: 'rgba(0,0,0,0.30)' },
  acid:  { primary: '#aaff00', secondary: '#00ff88', glow: '#ccff33', bgTreatment: 'rgba(0,10,0,0.25)' },
  ocean: { primary: '#0088ff', secondary: '#00ccaa', glow: '#44aaff', bgTreatment: 'rgba(0,5,15,0.25)' },
};

// ─── Per-Effect Metadata (client-side, for onboarding HUD) ──────

export const EFFECT_META: Record<EffectType, { gestureHint: string; idleBehavior: string }> = {
  glitch_tiles:    { gestureHint: 'pinch to grab a card · fling to ignite', idleBehavior: 'settle' },
  particle_nebula: { gestureHint: 'make a fist to gather the stars', idleBehavior: 'drift' },
  light_ribbons:   { gestureHint: 'pinch to draw in the air',       idleBehavior: 'fade' },
  fire_magic:      { gestureHint: 'fist to charge the flame · open to erupt', idleBehavior: 'flicker' },
};

// ─── Config Interfaces ──────────────────────────────────────────

export interface EffectConfigBase {
  v: 1;
  effect: EffectType;
  palette: PaletteId;
  intensity: 1 | 2 | 3;
  prompt: string;
}

export interface GlitchTilesConfig extends EffectConfigBase {
  effect: 'glitch_tiles';
  params: {
    tileShape: 'square' | 'wide' | 'shard';
    pullMode: 'attract' | 'repel' | 'vortex' | 'fan';
    snapBack: 'spring' | 'drift';
  };
}

export interface ParticleNebulaConfig extends EffectConfigBase {
  effect: 'particle_nebula';
  params: {
    motion: 'orbit' | 'stream' | 'swarm';
    openHandAction: 'explode' | 'release';
    trail: 'short' | 'long';
  };
}

export interface LightRibbonsConfig extends EffectConfigBase {
  effect: 'light_ribbons';
  params: {
    brush: 'ribbon' | 'lightning' | 'smoke';
    persistence: 'fading' | 'lasting';
    pinchAction: 'penDown' | 'widthControl';
  };
}

export interface FireMagicConfig extends EffectConfigBase {
  effect: 'fire_magic';
  params: {
    eruption: 'burst' | 'flamethrower';
    form: 'wildfire' | 'plasma';
    trails: 'smoky' | 'clean';
  };
}

export type EffectConfig =
  | GlitchTilesConfig
  | ParticleNebulaConfig
  | LightRibbonsConfig
  | FireMagicConfig;

// ─── Zod Schemas (validation on server + client) ────────────────

const glitchTilesSchema = z.object({
  v: z.literal(1),
  effect: z.literal('glitch_tiles'),
  palette: z.enum(['neon', 'ember', 'vapor', 'mono', 'acid', 'ocean']),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string(),
  params: z.object({
    tileShape: z.enum(['square', 'wide', 'shard']),
    pullMode: z.enum(['attract', 'repel', 'vortex', 'fan']),
    snapBack: z.enum(['spring', 'drift']),
  }),
});

const particleNebulaSchema = z.object({
  v: z.literal(1),
  effect: z.literal('particle_nebula'),
  palette: z.enum(['neon', 'ember', 'vapor', 'mono', 'acid', 'ocean']),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string(),
  params: z.object({
    motion: z.enum(['orbit', 'stream', 'swarm']),
    openHandAction: z.enum(['explode', 'release']),
    trail: z.enum(['short', 'long']),
  }),
});

const lightRibbonsSchema = z.object({
  v: z.literal(1),
  effect: z.literal('light_ribbons'),
  palette: z.enum(['neon', 'ember', 'vapor', 'mono', 'acid', 'ocean']),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string(),
  params: z.object({
    brush: z.enum(['ribbon', 'lightning', 'smoke']),
    persistence: z.enum(['fading', 'lasting']),
    pinchAction: z.enum(['penDown', 'widthControl']),
  }),
});

const fireMagicSchema = z.object({
  v: z.literal(1),
  effect: z.literal('fire_magic'),
  palette: z.enum(['neon', 'ember', 'vapor', 'mono', 'acid', 'ocean']),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string(),
  params: z.object({
    eruption: z.enum(['burst', 'flamethrower']),
    form: z.enum(['wildfire', 'plasma']),
    trails: z.enum(['smoky', 'clean']),
  }),
});

export const effectConfigSchema = z.discriminatedUnion('effect', [
  glitchTilesSchema,
  particleNebulaSchema,
  lightRibbonsSchema,
  fireMagicSchema,
]);

/** Validate an unknown object against the EffectConfig schema */
export function validateEffectConfig(data: unknown): EffectConfig | null {
  const result = effectConfigSchema.safeParse(data);
  if (result.success) return result.data as EffectConfig;
  console.error('EffectConfig validation failed:', result.error.issues);
  return null;
}

// ─── Default Config (fallback when validation fails) ────────────

export const DEFAULT_EFFECT_CONFIG: LightRibbonsConfig = {
  v: 1,
  effect: 'light_ribbons',
  palette: 'neon',
  intensity: 2,
  prompt: 'draw with light',
  params: {
    brush: 'ribbon',
    persistence: 'fading',
    pinchAction: 'penDown',
  },
};

// ─── Base64 URL Encoding / Decoding ─────────────────────────────
// Same pattern as the existing GameConfig encoder in schema.ts

export function encodeEffectConfig(config: EffectConfig): string {
  const jsonStr = JSON.stringify(config);
  if (typeof window === 'undefined') {
    return Buffer.from(encodeURIComponent(jsonStr)).toString('base64');
  }
  return btoa(encodeURIComponent(jsonStr));
}

export function decodeEffectConfig(encoded: string): EffectConfig | null {
  try {
    let jsonString = '';
    if (typeof window === 'undefined') {
      jsonString = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf-8'));
    } else {
      jsonString = decodeURIComponent(atob(encoded));
    }
    const parsed = JSON.parse(jsonString);
    // Always validate — URLs are user-editable
    return validateEffectConfig(parsed);
  } catch (e) {
    console.error('Failed to decode EffectConfig:', e);
    return null;
  }
}
