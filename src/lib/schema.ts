export type GameMechanic = 'count-reps' | 'survival-dodge' | 'pose-match' | 'strike-targets';
export type CVPrimitive = 'squat' | 'lateral-dodge' | 'jump' | 'punch' | 'both-hands-raise';

export interface GameConfig {
  title: string;
  mechanic: GameMechanic;
  primitive: CVPrimitive;
  duration: number; // in seconds
  instructions: string;
  threatEmoji?: string;
  themeColor?: string;
}

/**
 * Helper to encode the GameConfig to a base64 string for URL sharing
 */
export function encodeGameConfig(config: GameConfig): string {
  const jsonStr = JSON.stringify(config);
  if (typeof window === 'undefined') {
    return Buffer.from(encodeURIComponent(jsonStr)).toString('base64');
  }
  return btoa(encodeURIComponent(jsonStr));
}

/**
 * Helper to decode the GameConfig from a base64 string
 */
export function decodeGameConfig(encoded: string): GameConfig | null {
  try {
    let jsonString = '';
    if (typeof window === 'undefined') {
      jsonString = decodeURIComponent(Buffer.from(encoded, 'base64').toString('utf-8'));
    } else {
      jsonString = decodeURIComponent(atob(encoded));
    }
    return JSON.parse(jsonString) as GameConfig;
  } catch (e) {
    console.error('Failed to decode GameConfig:', e);
    return null;
  }
}
