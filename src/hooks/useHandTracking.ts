import { useEffect, useRef, useState } from 'react';
import { FilesetResolver, HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';

// ─── Types ──────────────────────────────────────────────────────

export type TrackState = 'tracking' | 'coasting' | 'lost';

export interface HandSignals {
  track: TrackState;
  confidence: number;
  framesSinceSeen: number;

  // Positions (mirrored, in pixel space, EMA-smoothed)
  palm: { x: number; y: number };
  indexTip: { x: number; y: number };
  landmarks: Array<{ x: number; y: number }>;

  // Velocity (pixels per second, EMA-smoothed)
  indexVel: { x: number; y: number };

  // Gestures (normalized, depth-invariant)
  pinch: number;           // 0–1 continuous
  pinching: boolean;       // hysteresis state
  pinchJustStarted: boolean;
  pinchJustEnded: boolean;
  openness: number;        // 0 (fist) → 1 (splayed)

  // Meta
  scale: number;           // hand size proxy in px (wrist→middle MCP)
  edgeClipped: boolean;    // landmarks hugging frame edge
}

export interface HandTrackingState {
  hands: [HandSignals | null, HandSignals | null];
  detectionHz: number;
  t: number; // timestamp
}

// ─── Constants ──────────────────────────────────────────────────

const HAND_MODEL_URL = '/mediapipe/hand_landmarker.task';
const POSITION_ALPHA = 0.65;       // Increased for much snappier tracking (was 0.35)
const VELOCITY_ALPHA = 0.75;       // Increased for snappier velocity (was 0.5)
const CONFIDENCE_ALPHA = 0.3;      // EMA for detection confidence
const PINCH_ENTER = 0.28;          // normalized pinch distance to enter "pinching"
const PINCH_EXIT = 0.65;           // MUCH wider exit so you don't drop the pen (was 0.40)
const COASTING_FRAMES = 12;        // ~200ms at 60fps before LOST
const EDGE_MARGIN = 0.02;          // 2% of frame = "edge clipped"
const MIN_EDGE_LANDMARKS = 4;      // this many at edge → edgeClipped = true

// ─── Internal per-hand slot state ───────────────────────────────

interface HandSlotInternal {
  label: string;           // "Left" or "Right"
  track: TrackState;
  framesSinceSeen: number;
  confidence: number;

  // Smoothed values
  palmX: number; palmY: number;
  tipX: number; tipY: number;
  landmarks: Array<{ x: number; y: number }>;
  velX: number; velY: number;
  pinch: number;
  pinching: boolean;
  prevPinching: boolean;
  openness: number;
  scale: number;

  // Previous raw for velocity calc
  prevRawTipX: number; prevRawTipY: number;
  prevTimestamp: number;

  initialized: boolean;
}

function createEmptySlot(label: string): HandSlotInternal {
  return {
    label, track: 'lost', framesSinceSeen: 999, confidence: 0,
    palmX: 0, palmY: 0, tipX: 0, tipY: 0, landmarks: [],
    velX: 0, velY: 0, pinch: 1, pinching: false, prevPinching: false,
    openness: 1, scale: 0,
    prevRawTipX: 0, prevRawTipY: 0, prevTimestamp: 0,
    initialized: false,
  };
}

// ─── Math helpers ───────────────────────────────────────────────

function dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function ema(prev: number, raw: number, alpha: number): number {
  return prev + alpha * (raw - prev);
}

// ─── Derive signals from raw landmarks ──────────────────────────

function updateSlot(
  slot: HandSlotInternal,
  landmarks: NormalizedLandmark[],
  confidence: number,
  canvasW: number,
  canvasH: number,
  timestamp: number,
): void {
  // Mirror x for natural UX (camera is mirrored)
  const mirror = (x: number) => (1 - x) * canvasW;
  const toY = (y: number) => y * canvasH;

  // ── Palm center: average of wrist(0), index MCP(5), middle MCP(9), ring MCP(13), pinky MCP(17)
  const palmLandmarks = [landmarks[0], landmarks[5], landmarks[9], landmarks[13], landmarks[17]];
  const rawPalmX = mirror(palmLandmarks.reduce((s, l) => s + l.x, 0) / 5);
  const rawPalmY = toY(palmLandmarks.reduce((s, l) => s + l.y, 0) / 5);

  // ── Index fingertip (landmark 8)
  const rawTipX = mirror(landmarks[8].x);
  const rawTipY = toY(landmarks[8].y);

  // ── Scale: wrist(0) → middle MCP(9) distance in pixels
  const rawScale = dist(landmarks[0], landmarks[9]) * Math.max(canvasW, canvasH);

  // ── Pinch: thumb tip(4) ↔ index tip(8), normalized by hand scale
  const handScaleNorm = dist(landmarks[0], landmarks[9]);
  const rawPinch = handScaleNorm > 0.001 ? dist(landmarks[4], landmarks[8]) / handScaleNorm : 1;

  // ── Openness: mean distance of 5 fingertips from palm, normalized
  const fingertips = [landmarks[4], landmarks[8], landmarks[12], landmarks[16], landmarks[20]];
  const palmCenter = {
    x: palmLandmarks.reduce((s, l) => s + l.x, 0) / 5,
    y: palmLandmarks.reduce((s, l) => s + l.y, 0) / 5,
  };
  const meanFingerDist = fingertips.reduce((s, f) => {
    const dx = f.x - palmCenter.x;
    const dy = f.y - palmCenter.y;
    return s + Math.sqrt(dx * dx + dy * dy);
  }, 0) / 5;
  // Remap: ~0.4 (fist) → 0, ~1.1 (splayed) → 1
  const rawOpenness = Math.max(0, Math.min(1, (meanFingerDist / handScaleNorm - 0.4) / 0.7));

  // ── Edge clipping: count landmarks within EDGE_MARGIN of frame border
  let edgeCount = 0;
  for (const lm of landmarks) {
    if (lm.x < EDGE_MARGIN || lm.x > 1 - EDGE_MARGIN || lm.y < EDGE_MARGIN || lm.y > 1 - EDGE_MARGIN) {
      edgeCount++;
    }
  }
  const edgeClipped = edgeCount >= MIN_EDGE_LANDMARKS;

  const mappedLandmarks = landmarks.map(lm => ({ x: mirror(lm.x), y: toY(lm.y) }));

  // ── First frame: snap (no EMA chase from 0,0)
  if (!slot.initialized) {
    slot.palmX = rawPalmX; slot.palmY = rawPalmY;
    slot.tipX = rawTipX; slot.tipY = rawTipY;
    slot.landmarks = mappedLandmarks;
    slot.velX = 0; slot.velY = 0;
    slot.pinch = rawPinch;
    slot.openness = rawOpenness;
    slot.scale = rawScale;
    slot.confidence = confidence;
    slot.prevRawTipX = rawTipX; slot.prevRawTipY = rawTipY;
    slot.prevTimestamp = timestamp;
    slot.initialized = true;
  } else {
    // EMA smooth
    slot.palmX = ema(slot.palmX, rawPalmX, POSITION_ALPHA);
    slot.palmY = ema(slot.palmY, rawPalmY, POSITION_ALPHA);
    slot.tipX = ema(slot.tipX, rawTipX, POSITION_ALPHA);
    slot.tipY = ema(slot.tipY, rawTipY, POSITION_ALPHA);
    for (let i = 0; i < mappedLandmarks.length; i++) {
      if (!slot.landmarks[i]) slot.landmarks[i] = mappedLandmarks[i];
      else {
        slot.landmarks[i].x = ema(slot.landmarks[i].x, mappedLandmarks[i].x, POSITION_ALPHA);
        slot.landmarks[i].y = ema(slot.landmarks[i].y, mappedLandmarks[i].y, POSITION_ALPHA);
      }
    }
    slot.pinch = ema(slot.pinch, rawPinch, POSITION_ALPHA);
    slot.openness = ema(slot.openness, rawOpenness, POSITION_ALPHA);
    slot.scale = ema(slot.scale, rawScale, POSITION_ALPHA);
    slot.confidence = ema(slot.confidence, confidence, CONFIDENCE_ALPHA);

    // Velocity (pixels per second)
    const dt = (timestamp - slot.prevTimestamp) / 1000;
    if (dt > 0.001) {
      const rawVelX = (rawTipX - slot.prevRawTipX) / dt;
      const rawVelY = (rawTipY - slot.prevRawTipY) / dt;
      slot.velX = ema(slot.velX, rawVelX, VELOCITY_ALPHA);
      slot.velY = ema(slot.velY, rawVelY, VELOCITY_ALPHA);
    }
    slot.prevRawTipX = rawTipX; slot.prevRawTipY = rawTipY;
    slot.prevTimestamp = timestamp;
  }

  // ── Pinch hysteresis
  slot.prevPinching = slot.pinching;
  if (!slot.pinching && slot.pinch < PINCH_ENTER) {
    slot.pinching = true;
  } else if (slot.pinching && slot.pinch > PINCH_EXIT) {
    slot.pinching = false;
  }

  // ── Track state
  slot.track = 'tracking';
  slot.framesSinceSeen = 0;

  // Store edge info (read externally)
  (slot as unknown as { edgeClipped: boolean }).edgeClipped = edgeClipped;
}

function slotToSignals(slot: HandSlotInternal): HandSignals {
  return {
    track: slot.track,
    confidence: slot.confidence,
    framesSinceSeen: slot.framesSinceSeen,
    palm: { x: slot.palmX, y: slot.palmY },
    indexTip: { x: slot.tipX, y: slot.tipY },
    landmarks: slot.landmarks,
    indexVel: { x: slot.velX, y: slot.velY },
    pinch: slot.pinch,
    pinching: slot.pinching,
    pinchJustStarted: slot.pinching && !slot.prevPinching,
    pinchJustEnded: !slot.pinching && slot.prevPinching,
    openness: slot.openness,
    scale: slot.scale,
    edgeClipped: (slot as unknown as { edgeClipped: boolean }).edgeClipped ?? false,
  };
}

// ─── The Hook ───────────────────────────────────────────────────

export function useHandTracking(
  videoElement: HTMLVideoElement | null,
  isRunning: boolean,
  canvasWidth: number,
  canvasHeight: number,
) {
  const [isReady, setIsReady] = useState(false);
  const signalsRef = useRef<HandTrackingState>({
    hands: [null, null],
    detectionHz: 0,
    t: 0,
  });

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);

  // Persistent per-hand slots (keyed by handedness, not array index)
  const slotsRef = useRef<{ left: HandSlotInternal; right: HandSlotInternal }>({
    left: createEmptySlot('Left'),
    right: createEmptySlot('Right'),
  });

  // Detection Hz tracking
  const detectionCountRef = useRef(0);
  const detectionHzRef = useRef(0);
  const lastHzTimestamp = useRef(0);

  // ── Initialize HandLandmarker
  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );

        const landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: HAND_MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.2,
          minTrackingConfidence: 0.2,
        });

        if (isMounted) {
          landmarkerRef.current = landmarker;
          setIsReady(true);
        }
      } catch (error) {
        console.error('Failed to initialize HandLandmarker:', error);
      }
    };

    init();

    return () => {
      isMounted = false;
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  // ── Detection loop
  useEffect(() => {
    let animationFrameId: number;

    const loop = () => {
      if (!videoElement || !landmarkerRef.current || !isRunning) return;
      if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        if (isRunning) animationFrameId = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();

      // Only detect on new video frames
      if (videoElement.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = videoElement.currentTime;
        const results = landmarkerRef.current.detectForVideo(videoElement, now);

        // Detection Hz measurement
        detectionCountRef.current++;
        if (now - lastHzTimestamp.current >= 1000) {
          detectionHzRef.current = detectionCountRef.current;
          detectionCountRef.current = 0;
          lastHzTimestamp.current = now;
        }

        const slots = slotsRef.current;

        // Track which slots got updated this frame
        let leftUpdated = false;
        let rightUpdated = false;

        if (results.landmarks && results.landmarks.length > 0) {
          for (let i = 0; i < results.landmarks.length; i++) {
            const landmarks = results.landmarks[i];
            const handedness = results.handedness?.[i]?.[0];
            const label = handedness?.categoryName || 'Right';
            const conf = handedness?.score || 0.5;

            // Route to the correct slot by handedness label
            // MediaPipe reports "Left"/"Right" from the camera's perspective
            // Since we mirror, camera-Left = user's Right
            if (label === 'Left') {
              updateSlot(slots.right, landmarks, conf, canvasWidth, canvasHeight, now);
              rightUpdated = true;
            } else {
              updateSlot(slots.left, landmarks, conf, canvasWidth, canvasHeight, now);
              leftUpdated = true;
            }
          }
        }

        // Handle slots that were NOT updated (coasting → lost)
        if (!leftUpdated) {
          slots.left.framesSinceSeen++;
          if (slots.left.track === 'tracking') {
            slots.left.track = 'coasting';
          }
          if (slots.left.framesSinceSeen > COASTING_FRAMES && slots.left.track === 'coasting') {
            slots.left.track = 'lost';
            slots.left.initialized = false;
          }
        }
        if (!rightUpdated) {
          slots.right.framesSinceSeen++;
          if (slots.right.track === 'tracking') {
            slots.right.track = 'coasting';
          }
          if (slots.right.framesSinceSeen > COASTING_FRAMES && slots.right.track === 'coasting') {
            slots.right.track = 'lost';
            slots.right.initialized = false;
          }
        }

        // Build output signals
        const leftSignals = slots.left.track !== 'lost' ? slotToSignals(slots.left) : null;
        const rightSignals = slots.right.track !== 'lost' ? slotToSignals(slots.right) : null;

        signalsRef.current = {
          hands: [leftSignals, rightSignals],
          detectionHz: detectionHzRef.current,
          t: now,
        };
      }

      if (isRunning) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };

    if (isRunning && isReady && videoElement) {
      animationFrameId = requestAnimationFrame(loop);
    } else {
      signalsRef.current = { hands: [null, null], detectionHz: 0, t: 0 };
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isRunning, isReady, videoElement, canvasWidth, canvasHeight]);

  return { signalsRef, isReady };
}
