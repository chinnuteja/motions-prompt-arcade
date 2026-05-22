import { NormalizedLandmark } from '@mediapipe/tasks-vision';

export type PlayerState =
  | "READY"
  | "PLAYING"
  | "CHALLENGE_INTRO"
  | "CHALLENGE_ACTIVE"
  | "CHALLENGE_SUCCESS"
  | "COMPLETE";

export type AppPhase =
  | "URL_INPUT"
  | "GENERATING"
  | "REVIEW_CHALLENGES"
  | "SETUP"       // Camera permission + MediaPipe loading
  | "EXPERIENCE"  // v1 FSM takes over
  | "END_SCREEN";

export interface ChallengeConfig {
  id: string;
  challengeType?: string;
  triggerTimestamp: number;
  instruction: string;
  evaluator: (landmarks: NormalizedLandmark[]) => number;
  holdFrames: number;
  confidenceThreshold: number;
  promptTimestamp: number;
  promptText: string;
  rationale?: string; // Why the AI "chose" this moment
  selectedPrimitive?: string;
  inputSignal?: string;
  winCondition?: string;
  difficulty?: string;
  viralMoment?: string;
}

export interface DemoVideo {
  id: string;
  title: string;
  thumbnail: string;
  localSrc?: string;       // Path to local mp4 in /public
  youtubeId?: string;      // Used for real v3 playback
  challenges: ChallengeConfig[];
}

export interface ClipSegment {
  startTime: number;  // ms offset from recording start
  endTime: number;    // ms offset from recording start
  label: string;
}
