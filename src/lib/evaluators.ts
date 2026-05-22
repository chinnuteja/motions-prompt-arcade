import { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CVPrimitive } from './schema';

/**
 * Computes a reference scale (roughly torso length or shoulder width) 
 * to make distance thresholds tolerant of how far the user is from the camera.
 */
function getScale(landmarks: NormalizedLandmark[]): number {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  
  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const hipY = (leftHip.y + rightHip.y) / 2;
    return Math.max(Math.abs(hipY - shoulderY), 0.1);
  } else if (leftShoulder && rightShoulder) {
    return Math.max(Math.abs(leftShoulder.x - rightShoulder.x) * 1.5, 0.1);
  }
  return 0.3; // Fallback
}

export function evaluateRaiseRightHand(landmarks: NormalizedLandmark[]): number {
  const rightWrist = landmarks[16];
  const nose = landmarks[0];
  if (!rightWrist || !nose) return 0;
  
  const scale = getScale(landmarks);
  const delta = nose.y - rightWrist.y;
  return Math.min(Math.max(delta / (scale * 0.5), 0), 1);
}

export function evaluateRaiseBothHands(landmarks: NormalizedLandmark[]): number {
  const leftWrist = landmarks[15];
  const rightWrist = landmarks[16];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];

  if (!leftWrist || !rightWrist || !leftShoulder || !rightShoulder) return 0;

  const scale = getScale(landmarks);
  const leftDelta = leftShoulder.y - leftWrist.y;
  const rightDelta = rightShoulder.y - rightWrist.y;

  const leftScore = Math.min(Math.max(leftDelta / (scale * 0.4), 0), 1);
  const rightScore = Math.min(Math.max(rightDelta / (scale * 0.4), 0), 1);

  return Math.min(leftScore, rightScore);
}

export function createMovementEvaluator(): (landmarks: NormalizedLandmark[]) => number {
  let previousLandmarks: NormalizedLandmark[] | null = null;
  const movementHistory: number[] = [];
  const HISTORY_SIZE = 15; 
  
  return (landmarks: NormalizedLandmark[]) => {
    if (!previousLandmarks) {
      previousLandmarks = landmarks;
      return 0;
    }
    const scale = getScale(landmarks);
    const jointsToTrack = [0, 15, 16, 11, 12]; // nose, wrists, shoulders
    let totalDelta = 0;

    for (const index of jointsToTrack) {
      const prev = previousLandmarks[index];
      const curr = landmarks[index];
      if (prev && curr) {
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        totalDelta += Math.sqrt(dx * dx + dy * dy);
      }
    }
    previousLandmarks = landmarks;

    // Normalize delta by scale to account for distance
    const normalizedDelta = totalDelta / scale;
    const isMoving = normalizedDelta > 0.05 ? 1 : 0;
    
    movementHistory.push(isMoving);
    if (movementHistory.length > HISTORY_SIZE) movementHistory.shift();

    const recentMovementScore = movementHistory.reduce((a, b) => a + b, 0) / movementHistory.length;
    return Math.min(recentMovementScore / 0.6, 1.0);
  };
}

export function createPunchEvaluator(): (landmarks: NormalizedLandmark[]) => number {
  let previousRightWrist: NormalizedLandmark | null = null;
  const velocityHistory: number[] = [];
  const HISTORY_SIZE = 10;

  return (landmarks: NormalizedLandmark[]) => {
    const rightWrist = landmarks[16];
    const rightElbow = landmarks[14];
    if (!rightWrist || !rightElbow) return 0;

    if (!previousRightWrist) {
      previousRightWrist = rightWrist;
      return 0;
    }
    const scale = getScale(landmarks);
    
    const dx = rightWrist.x - previousRightWrist.x;
    const dy = rightWrist.y - previousRightWrist.y;
    const distance = Math.sqrt(dx*dx + dy*dy);
    
    previousRightWrist = rightWrist;

    const velocity = distance / scale;
    const rightShoulder = landmarks[12];
    let extension = 0;
    if (rightShoulder) {
       extension = Math.abs(rightWrist.x - rightShoulder.x) / scale;
    }

    const punchScore = Math.min(1, velocity * 4 + extension * 0.5);

    velocityHistory.push(punchScore);
    if (velocityHistory.length > HISTORY_SIZE) velocityHistory.shift();

    const peak = Math.max(...velocityHistory, 0);
    return Math.min(1, peak / 0.8);
  };
}

export function createSquatEvaluator(): (landmarks: NormalizedLandmark[]) => number {
  let baselineShoulderY: number | null = null;
  const history: number[] = [];
  const HISTORY_SIZE = 10;

  return (landmarks: NormalizedLandmark[]) => {
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    if (!leftShoulder || !rightShoulder) return 0;

    const currentShoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const scale = getScale(landmarks);

    // Dynamic baseline: moving average of highest shoulder position (lowest Y value)
    if (baselineShoulderY === null) {
      baselineShoulderY = currentShoulderY;
    } else {
      // Slowly adapt baseline up if standing taller, very slowly adapt down
      if (currentShoulderY < baselineShoulderY) {
        baselineShoulderY = baselineShoulderY * 0.9 + currentShoulderY * 0.1;
      } else {
        baselineShoulderY = baselineShoulderY * 0.995 + currentShoulderY * 0.005;
      }
    }

    // A squat is when the shoulders drop significantly relative to the baseline
    // Tracking shoulders instead of hips prevents inferred-jitter from head nods
    const drop = currentShoulderY - baselineShoulderY;
    
    // Squat confidence based on how far shoulders dropped relative to torso length
    const score = Math.max(0, Math.min(1, drop / (scale * 0.5)));
    
    history.push(score);
    if (history.length > HISTORY_SIZE) history.shift();
    
    // Smooth the score
    return history.reduce((a, b) => a + b, 0) / history.length;
  };
}

export function createLateralDodgeEvaluator(): (landmarks: NormalizedLandmark[]) => number {
  return (landmarks: NormalizedLandmark[]) => {
    const nose = landmarks[0];
    if (!nose) return 1; // default center

    // MediaPipe x is 0 at left, 1 at right (mirrored feed means x<0.4 is player moving right physically)
    if (nose.x > 0.6) return 0; // Left lane
    if (nose.x < 0.4) return 2; // Right lane
    return 1; // Center lane
  };
}

export function createJumpEvaluator(): (landmarks: NormalizedLandmark[]) => number {
  let baselineY: number | null = null;
  
  return (landmarks: NormalizedLandmark[]) => {
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    if (!leftShoulder || !rightShoulder) return 0;

    const shoulderY = (leftShoulder.y + rightShoulder.y) / 2;
    const scale = getScale(landmarks);

    if (baselineY === null) {
      baselineY = shoulderY;
    } else {
      // Adapt quickly when moving down (landing), very slowly when moving up (jumping)
      if (shoulderY > baselineY) {
        baselineY = baselineY * 0.9 + shoulderY * 0.1; 
      } else {
        baselineY = baselineY * 0.99 + shoulderY * 0.01;
      }
    }

    // Jump is when shoulders go significantly ABOVE the baseline (lower Y)
    const lift = baselineY - shoulderY;
    const score = Math.max(0, Math.min(1, lift / (scale * 0.2)));
    
    return score;
  };
}

export function getEvaluatorForPrimitive(primitive: CVPrimitive): (landmarks: NormalizedLandmark[]) => number {
  switch (primitive) {
    case 'squat': return createSquatEvaluator();
    case 'lateral-dodge': return createLateralDodgeEvaluator();
    case 'jump': return createJumpEvaluator();
    case 'punch': return createPunchEvaluator();
    case 'both-hands-raise': return evaluateRaiseBothHands;
    default: return createMovementEvaluator();
  }
}
