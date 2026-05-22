import { ChallengeConfig } from '../lib/types';
import { evaluateRaiseRightHand, evaluateRaiseBothHands } from '../lib/evaluators';

export const GAME_CHALLENGES: ChallengeConfig[] = [
  {
    id: "raise-right-hand",
    triggerTimestamp: 3.0, 
    instruction: "Raise your right hand! 🖐️",
    evaluator: evaluateRaiseRightHand,
    holdFrames: 8,
    confidenceThreshold: 0.85,
    promptTimestamp: 1.0,
    promptText: "🎓 Can you raise your right hand?",
  },
  {
    id: "raise-both-hands",
    triggerTimestamp: 7.0, 
    instruction: "Now raise BOTH hands! 🙌",
    evaluator: evaluateRaiseBothHands,
    holdFrames: 8,
    confidenceThreshold: 0.85,
    promptTimestamp: 5.5,
    promptText: "🎓 Now try raising BOTH hands!",
  }
];
