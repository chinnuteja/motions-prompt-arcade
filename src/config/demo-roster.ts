import { DemoVideo } from '../lib/types';
import {
  createMovementEvaluator,
  createPunchEvaluator,
  evaluateRaiseBothHands,
  evaluateRaiseRightHand,
} from '../lib/evaluators';

/**
 * Pre-authored challenge sets for demo videos.
 * Keyed by a fake "YouTube ID" so the URL input can look them up.
 * All challenges stay inside the MediaPipe lite reliability envelope:
 * - Large arm movements only
 * - No face occlusion
 * - No left/right precision in mirror view
 */

// The generic fallback set (used for any unknown URL)
const GENERIC_CHALLENGES = [
  {
    id: "raise-right-hand",
    challengeType: "raise-right-hand",
    triggerTimestamp: 3.0,
    instruction: "Raise your right hand! 🖐️",
    evaluator: evaluateRaiseRightHand,
    holdFrames: 8,
    confidenceThreshold: 0.85,
    promptTimestamp: 1.0,
    promptText: "🎓 Can you raise your right hand?",
    rationale: "Host greets the audience — a natural moment for participation",
    selectedPrimitive: 'single-hand-raise',
    inputSignal: 'right wrist above nose',
    winCondition: 'hold hand raised for ~0.25s',
    difficulty: 'easy',
    viralMoment: 'quick reaction beat with clean silhouette pose',
  },
  {
    id: "raise-both-hands",
    challengeType: "raise-both-hands",
    triggerTimestamp: 7.0,
    instruction: "Now raise BOTH hands! 🙌",
    evaluator: evaluateRaiseBothHands,
    holdFrames: 8,
    confidenceThreshold: 0.85,
    promptTimestamp: 5.5,
    promptText: "🎓 Now try raising BOTH hands!",
    rationale: "Energy peaks — perfect moment to escalate the interaction",
    selectedPrimitive: 'both-hands-raise',
    inputSignal: 'both wrists above shoulders',
    winCondition: 'both hands held overhead briefly',
    difficulty: 'easy',
    viralMoment: 'readable full-body celebration frame',
  },
];

export const DEMO_ROSTER: Record<string, DemoVideo> = {
  // Primary demo — Ms Rachel style toddler video
  "ms-rachel-demo": {
    id: "ms-rachel-demo",
    title: "Ms. Rachel — Songs for Littles",
    thumbnail: "/videos/demo-lesson-thumb.jpg",
    localSrc: "/videos/demo-lesson.mp4",
    challenges: [
      {
        id: "wave-hello",
        challengeType: "raise-right-hand",
        triggerTimestamp: 2.5,
        instruction: "Wave hello! 👋",
        evaluator: evaluateRaiseRightHand,
        holdFrames: 6,
        confidenceThreshold: 0.8,
        promptTimestamp: 1.0,
        promptText: "🎓 Can you wave hello?",
        rationale: "Host says 'hello' — natural prompt for a wave",
        selectedPrimitive: 'single-hand-raise',
        inputSignal: 'right wrist above nose line',
        winCondition: 'hand stays raised as greeting',
        difficulty: 'easy',
        viralMoment: 'friendly hello moment reads instantly in clips',
      },
      {
        id: "hands-up-high",
        challengeType: "raise-both-hands",
        triggerTimestamp: 5.5,
        instruction: "Put your hands up high! 🙌",
        evaluator: evaluateRaiseBothHands,
        holdFrames: 8,
        confidenceThreshold: 0.85,
        promptTimestamp: 4.0,
        promptText: "🎓 Hands up high!",
        rationale: "Song says 'reach up high' — matching the lyric",
        selectedPrimitive: 'both-hands-raise',
        inputSignal: 'both wrists above shoulder line',
        winCondition: 'both hands raised with stable hold',
        difficulty: 'easy',
        viralMoment: 'clear celebratory peak pose',
      },
      {
        id: "right-hand-up",
        challengeType: "raise-right-hand",
        triggerTimestamp: 9.0,
        instruction: "Raise your right hand! 🖐️",
        evaluator: evaluateRaiseRightHand,
        holdFrames: 8,
        confidenceThreshold: 0.85,
        promptTimestamp: 7.5,
        promptText: "🎓 Show me your right hand!",
        rationale: "Teaching moment — identifying right vs. left",
        selectedPrimitive: 'single-hand-raise',
        inputSignal: 'right wrist lifted above nose',
        winCondition: 'right-hand hold completes challenge',
        difficulty: 'easy',
        viralMoment: 'simple call-and-response moment for kids',
      },
    ],
  },

  // Backup — dance tutorial
  "dance-tutorial": {
    id: "dance-tutorial",
    title: "Kids Dance Along — Easy Moves",
    thumbnail: "/videos/demo-lesson-thumb.jpg",
    localSrc: "/videos/demo-lesson.mp4",
    challenges: [
      {
        id: "arms-out",
        challengeType: "raise-both-hands",
        triggerTimestamp: 3.0,
        instruction: "Stretch your arms out wide! 💪",
        evaluator: evaluateRaiseBothHands,
        holdFrames: 8,
        confidenceThreshold: 0.8,
        promptTimestamp: 1.5,
        promptText: "🎓 Arms out wide!",
        rationale: "Instructor demonstrates wide arm stretch",
        selectedPrimitive: 'both-hands-raise',
        inputSignal: 'both wrists at/above shoulder line',
        winCondition: 'wide-arm hold for short beat',
        difficulty: 'easy',
        viralMoment: 'big silhouette movement on beat drop',
      },
      {
        id: "right-hand-wave",
        challengeType: "raise-right-hand",
        triggerTimestamp: 7.0,
        instruction: "Wave your right hand! 👋",
        evaluator: evaluateRaiseRightHand,
        holdFrames: 6,
        confidenceThreshold: 0.85,
        promptTimestamp: 5.5,
        promptText: "🎓 Wave to the camera!",
        rationale: "Break in choreography — instructor waves to audience",
        selectedPrimitive: 'single-hand-raise',
        inputSignal: 'right wrist above facial centerline',
        winCondition: 'quick raised-hand hold',
        difficulty: 'easy',
        viralMoment: 'camera-facing wave reads well in shorts',
      },
    ],
  },

  "boxing-speed-demo": {
    id: "boxing-speed-demo",
    title: "Beginner Boxing Tutorial — Fast Hands",
    thumbnail: "/videos/demo-lesson-thumb.jpg",
    localSrc: "/videos/demo-lesson.mp4",
    challenges: [
      {
        id: "punch-challenge",
        challengeType: "punch-challenge",
        triggerTimestamp: 4.0,
        instruction: "Throw quick jabs! 🥊",
        evaluator: createPunchEvaluator(),
        holdFrames: 6,
        confidenceThreshold: 0.7,
        promptTimestamp: 2.0,
        promptText: "Coach says fast hands — jab now!",
        rationale: "The coach moves from explanation into direct jab demonstration, so the agent picks punch-speed as the most readable high-energy mechanic.",
        selectedPrimitive: 'punch-speed',
        inputSignal: 'right wrist forward velocity + arm extension',
        winCondition: 'reach repeated punch intensity threshold',
        difficulty: 'medium',
        viralMoment: 'rapid jab burst with clear impact timing',
      },
      {
        id: "continuous-movement",
        challengeType: "continuous-movement",
        triggerTimestamp: 9.0,
        instruction: "Keep bouncing and moving! 🔥",
        evaluator: createMovementEvaluator(),
        holdFrames: 45,
        confidenceThreshold: 0.65,
        promptTimestamp: 6.7,
        promptText: "Stay light on your feet.",
        rationale: "The tutorial enters a sustained conditioning section, so continuous movement preserves game flow and keeps the body loop active.",
        selectedPrimitive: 'movement-loop',
        inputSignal: 'multi-joint motion continuity',
        winCondition: 'maintain movement score over rolling window',
        difficulty: 'medium',
        viralMoment: 'full-body rhythm segment before final push',
      },
      {
        id: "raise-both-hands",
        challengeType: "raise-both-hands",
        triggerTimestamp: 13.5,
        instruction: "Hands up guard! 🙌",
        evaluator: evaluateRaiseBothHands,
        holdFrames: 8,
        confidenceThreshold: 0.82,
        promptTimestamp: 11.5,
        promptText: "Finish in defensive guard.",
        rationale: "The coach cues guard position as the round cap, so the agent chooses a clean two-hand pose for a strong final frame.",
        selectedPrimitive: 'both-hands-raise',
        inputSignal: 'both wrists above shoulder line',
        winCondition: 'stable guard hold completes sequence',
        difficulty: 'easy',
        viralMoment: 'victory-style freeze frame for share clip ending',
      },
    ],
  },
};

// Map fake YouTube URLs/IDs to our roster
const URL_TO_ROSTER: Record<string, string> = {
  "dQw4w9WgXcQ": "ms-rachel-demo",
  "ms-rachel": "ms-rachel-demo",
  "msrachel": "ms-rachel-demo",
  "abc123": "dance-tutorial",
  "dance": "dance-tutorial",
  "boxing": "boxing-speed-demo",
  "shadowbox": "boxing-speed-demo",
  "punch": "boxing-speed-demo",
};

/**
 * Given a YouTube URL (or any string), resolve to a DemoVideo.
 * Falls back to generic challenges for unknown URLs.
 */
export function resolveVideoFromURL(url: string): DemoVideo {
  // Try to extract a YouTube video ID
  const idMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  const searchTerm = idMatch ? idMatch[1] : url.toLowerCase().trim();

  // Check direct roster match
  for (const [key, rosterId] of Object.entries(URL_TO_ROSTER)) {
    if (searchTerm.includes(key)) {
      return cloneWithFreshEvaluators(DEMO_ROSTER[rosterId]);
    }
  }

  // Fallback: return generic challenges with the demo video
  return cloneWithFreshEvaluators({
    id: "generic",
    title: extractTitle(url),
    thumbnail: "/videos/demo-lesson-thumb.jpg",
    localSrc: "/videos/demo-lesson.mp4",
    challenges: GENERIC_CHALLENGES,
  });
}

function cloneWithFreshEvaluators(video: DemoVideo): DemoVideo {
  return {
    ...video,
    challenges: video.challenges.map((challenge) => {
      if (challenge.challengeType === 'continuous-movement' || challenge.id === 'continuous-movement') {
        return { ...challenge, evaluator: createMovementEvaluator() };
      }

      if (challenge.challengeType === 'punch-challenge' || challenge.id === 'punch-challenge') {
        return { ...challenge, evaluator: createPunchEvaluator() };
      }

      return { ...challenge };
    }),
  };
}

function extractTitle(url: string): string {
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    return "YouTube Video";
  }
  return "Educational Video";
}
