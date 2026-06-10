'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useHandTracking, HandSignals } from '../../hooks/useHandTracking';
import { EffectConfig, EffectType, PALETTES, EFFECT_META, PaletteColors } from '../../lib/vfx-schema';
import { VfxEffect } from '../../lib/effects/types';
import styles from './EffectEngine.module.css';

// Detailed instructions for each camera game engine type
const INSTRUCTION_DETAILS: Record<EffectType, { title: string; steps: string[]; gesture: string }> = {
  fire_magic: {
    title: "Fire Magic Controls",
    gesture: "✊ Fist = Charge Flame  ·  🖐️ Open = Erupt / Flamethrower",
    steps: [
      "Show your hands to the camera to bind the plasma field.",
      "Make a tight fist to magnetically condense and charge plasma in your palm.",
      "Release your fist to detonate a wild additive explosion.",
      "With the flamethrower prompt, point your hand to direct streams from your knuckles."
    ]
  },
  particle_nebula: {
    title: "Particle Nebula Controls",
    gesture: "✊ Fist = Gather Stars  ·  🖐️ Open = Detonate Swarm",
    steps: [
      "Let the cosmic swarm flow dynamically using curl noise around your palms.",
      "Make a fist to contract stars into a compact orbital shell.",
      "Open your hand quickly to detonate and scatter the galaxy outward."
    ]
  },
  glitch_tiles: {
    title: "Glitch Tiles Controls",
    gesture: "🤏 Pinch = Grab Card  ·  🖐️ Fling = Throw & Scatter",
    steps: [
      "Pinch your index finger and thumb to grab a floating glass tile.",
      "Move your hand to drag, slide, and position cards in 3D geometry.",
      "Make a quick sweep or swipe gesture (fling) to scatter cards into portals."
    ]
  },
  aura_blaster: {
    title: "Aura Blaster Controls",
    gesture: "✊ Fist = Charge Sphere  ·  🖐️ Open Palm = Fire Beam",
    steps: [
      "Clench your hand into a fist to charge a massive, glowing energy sphere.",
      "Hold the fist to build up power and intensity.",
      "Open your hand (palm forward) to blast a screen-spanning plasma beam!"
    ]
  }
};

// ─── Session States (§4) ────────────────────────────────────────
// "Transitions are rare (seconds apart), so session state IS allowed
//  to live in React state." — Plan §4

type SessionState =
  | 'prePermission'
  | 'permissionDenied'
  | 'noCamera'
  | 'initializing'
  | 'awaitingHands'
  | 'live'
  | 'idle';

// ─── Constants ──────────────────────────────────────────────────

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const HAND_GATE_MS = 500;         // §4.2: 500ms continuous detection to go live
const IDLE_TIMEOUT_MS = 2500;     // §4.3: 2.5s both hands lost → idle
const RAMP_LIVE_MS = 600;         // §4.2: ramp 0→1 over 600ms when going live
const RAMP_RETURN_MS = 300;       // §4.3: ramp back up over 300ms on re-detection
const GESTURE_HINT_MS = 4000;     // §4.2: gesture hint stays 4s after going live
const DT_CLAMP = 0.033;           // §3: clamp dt to ≤33ms
const DROPPED_FRAME_MS = 25;      // §6: frames over 25ms counted as dropped
const PERF_DISPLAY_HZ = 4;        // §6: update perf overlay at 4Hz
const QUALITY_DROP_THRESHOLD = 20; // §6: 20ms frame time threshold
const QUALITY_DROP_FRAMES = 60;    // §6: 60 consecutive frames above threshold

// Quality monitor thresholds (§4.5)
const SCALE_TOO_FAR = 0.06;       // scale < 6% of frame height
const SCALE_TOO_CLOSE = 0.35;     // scale > 35% of frame height
const LUMA_THRESHOLD = 50;         // low light luma threshold
const TOAST_PERSIST_MS = 2000;     // condition must persist 2s before toast
const TOAST_COOLDOWN_MS = 30000;   // same hint doesn't repeat within 30s

// ─── Props ──────────────────────────────────────────────────────

interface EffectEngineProps {
  config: EffectConfig;
  effect: VfxEffect;
}

// ─── Component ──────────────────────────────────────────────────

export function EffectEngine({ config, effect }: EffectEngineProps) {
  // Session state (React state — rare transitions)
  const [session, setSession] = useState<SessionState>('prePermission');
  const [showGestureHint, setShowGestureHint] = useState(true);
  const [toastText, setToastText] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Ramp envelope (plain number in ref, not React state — updated per frame)
  const rampRef = useRef(0);
  const rampTargetRef = useRef(0);
  const rampSpeedRef = useRef(1 / (RAMP_LIVE_MS / 16.67)); // per-frame increment

  // Awaiting hands gate timing
  const handGateStartRef = useRef<number | null>(null);

  // Idle timer
  const bothLostSinceRef = useRef<number | null>(null);

  // Previous hand track states (for gracefulRelease detection)
  const prevTrackRef = useRef<[string | null, string | null]>([null, null]);

  // Performance instrumentation (§6) — all in refs, never React state
  const perfRef = useRef({
    frameCount: 0,
    frameTimeEma: 16.67,
    droppedFrames: 0,
    lastTimestamp: 0,
    qualityDropCounter: 0,
  });

  // Perf overlay DOM refs (direct textContent writes at 4Hz)
  const perfFpsRef = useRef<HTMLSpanElement>(null);
  const perfHzRef = useRef<HTMLSpanElement>(null);
  const perfEntitiesRef = useRef<HTMLSpanElement>(null);
  const perfHandsRef = useRef<HTMLSpanElement>(null);
  const perfDroppedRef = useRef<HTMLSpanElement>(null);

  // Quality monitor state
  const toastCooldownRef = useRef<Record<string, number>>({});
  const toastConditionStartRef = useRef<Record<string, number>>({});

  // Luma check (§4.5: 32×18 offscreen canvas, 1Hz)
  const lumaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lowLightCountRef = useRef(0);

  const palette: PaletteColors = PALETTES[config.palette];
  const meta = EFFECT_META[config.effect];

  // ── Hand tracking hook
  const { signalsRef, isReady } = useHandTracking(
    session === 'awaitingHands' || session === 'live' || session === 'idle'
      ? videoRef.current
      : null,
    session === 'awaitingHands' || session === 'live' || session === 'idle',
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
  );

  // ── Debug toggle: 'd' key or ?debug=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') setShowDebug(true);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') setShowDebug(prev => !prev);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Initialize effect
  useEffect(() => {
    effect.init(config, CANVAS_WIDTH, CANVAS_HEIGHT);
  }, [config, effect]);

  // ── Create luma canvas for low-light detection (§4.5)
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    lumaCanvasRef.current = c;
  }, []);

  // ── Camera permission flow (§4.1)
  const requestCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, facingMode: 'user' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setSession('initializing');
    } catch (err) {
      if (err instanceof DOMException) {
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          setSession('noCamera');
        } else {
          setSession('permissionDenied');
        }
      } else {
        setSession('permissionDenied');
      }
    }
  }, []);

  // ── Transition: initializing → awaitingHands once model is ready
  useEffect(() => {
    if (session === 'initializing' && isReady) {
      setSession('awaitingHands');
    }
  }, [session, isReady]);

  // ── Performance overlay update at 4Hz (§6: direct textContent, not React state)
  useEffect(() => {
    if (!showDebug) return;
    const interval = setInterval(() => {
      const p = perfRef.current;
      const fps = p.frameTimeEma > 0 ? Math.round(1000 / p.frameTimeEma) : 0;
      const signals = signalsRef.current;
      const handsCount = (signals.hands[0] ? 1 : 0) + (signals.hands[1] ? 1 : 0);

      if (perfFpsRef.current) perfFpsRef.current.textContent = `FPS: ${fps}`;
      if (perfHzRef.current) perfHzRef.current.textContent = `Det: ${signals.detectionHz}Hz`;
      if (perfEntitiesRef.current) perfEntitiesRef.current.textContent = `Ent: ${effect.getActiveCount()}`;
      if (perfHandsRef.current) perfHandsRef.current.textContent = `Hands: ${handsCount}`;
      if (perfDroppedRef.current) perfDroppedRef.current.textContent = `Drop: ${p.droppedFrames}`;
    }, 1000 / PERF_DISPLAY_HZ);

    return () => clearInterval(interval);
  }, [showDebug, effect, signalsRef]);

  // ── Quality monitor at 1Hz (§4.5)
  useEffect(() => {
    if (session !== 'live' && session !== 'idle') return;

    const interval = setInterval(() => {
      const signals = signalsRef.current;
      const now = performance.now();

      // Low light check (§4.5: draw video into 32×18, average luma)
      if (lumaCanvasRef.current && videoRef.current) {
        const lCtx = lumaCanvasRef.current.getContext('2d');
        if (lCtx) {
          lCtx.drawImage(videoRef.current, 0, 0, 32, 18);
          try {
            const data = lCtx.getImageData(0, 0, 32, 18).data;
            let lumaSum = 0;
            for (let i = 0; i < data.length; i += 4) {
              lumaSum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            }
            const avgLuma = lumaSum / (32 * 18);
            if (avgLuma < LUMA_THRESHOLD) {
              lowLightCountRef.current++;
              if (lowLightCountRef.current >= 3) {
                showToast('a bit more light helps ✨', now);
              }
            } else {
              lowLightCountRef.current = 0;
            }
          } catch { /* getImageData can fail on tainted canvas */ }
        }
      }

      // Hand distance checks
      for (let h = 0; h < 2; h++) {
        const hand = signals.hands[h];
        if (!hand || hand.track === 'lost') continue;

        const scaleRatio = hand.scale / CANVAS_HEIGHT;

        if (scaleRatio < SCALE_TOO_FAR) {
          checkToastCondition('tooFar', 'come a little closer ✋', now);
        } else if (scaleRatio > SCALE_TOO_CLOSE || hand.edgeClipped) {
          checkToastCondition('tooClose', 'step back a bit', now);
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [session, signalsRef]);

  // Toast helpers (§4.5: one at a time, persist 2s, no repeat within 30s)
  const showToast = useCallback((text: string, now: number) => {
    const lastShown = toastCooldownRef.current[text] || 0;
    if (now - lastShown < TOAST_COOLDOWN_MS) return;
    toastCooldownRef.current[text] = now;
    setToastText(text);
    setTimeout(() => setToastText(null), 3000);
  }, []);

  const checkToastCondition = useCallback((key: string, text: string, now: number) => {
    const start = toastConditionStartRef.current[key];
    if (!start) {
      toastConditionStartRef.current[key] = now;
    } else if (now - start >= TOAST_PERSIST_MS) {
      showToast(text, now);
      delete toastConditionStartRef.current[key];
    }
  }, [showToast]);

  // ── The main rAF loop (§3 + §6)
  useEffect(() => {
    if (session !== 'awaitingHands' && session !== 'live' && session !== 'idle') return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let lastTime = performance.now();

    const loop = (now: number) => {
      // ── dt clamping (§3: ≤33ms so tab-switch doesn't explode physics)
      const rawDt = (now - lastTime) / 1000;
      const dt = Math.min(rawDt, DT_CLAMP);
      lastTime = now;

      // ── Performance instrumentation (§6: arithmetic in refs only)
      const perf = perfRef.current;
      perf.frameCount++;
      const frameMs = rawDt * 1000;
      perf.frameTimeEma += 0.05 * (frameMs - perf.frameTimeEma);
      if (frameMs > DROPPED_FRAME_MS) perf.droppedFrames++;

      // ── Adaptive quality (§6: one-way step-down)
      if (perf.frameTimeEma > QUALITY_DROP_THRESHOLD) {
        perf.qualityDropCounter++;
        if (perf.qualityDropCounter >= QUALITY_DROP_FRAMES) {
          effect.stepDownQuality();
          perf.qualityDropCounter = 0;
        }
      } else {
        perf.qualityDropCounter = 0;
      }

      // ── Read hand signals
      const signals = signalsRef.current;
      const hands = signals.hands;
      const anyHand = hands[0] !== null || hands[1] !== null;

      // ── Session state transitions in the loop
      if (session === 'awaitingHands') {
        // §4.2: gate — hand present with confidence for 500ms continuously
        if (anyHand) {
          if (handGateStartRef.current === null) {
            handGateStartRef.current = now;
          } else if (now - handGateStartRef.current >= HAND_GATE_MS) {
            // Gate opens!
            setSession('live');
            rampTargetRef.current = 1;
            rampSpeedRef.current = 1 / (RAMP_LIVE_MS / 16.67);
            // Hide gesture hint after 4 more seconds
            setTimeout(() => setShowGestureHint(false), GESTURE_HINT_MS);
          }
        } else {
          handGateStartRef.current = null;
        }
      }

      if (session === 'live') {
        // §4.3: both hands lost for >2.5s → idle
        if (!anyHand) {
          if (bothLostSinceRef.current === null) {
            bothLostSinceRef.current = now;
          } else if (now - bothLostSinceRef.current >= IDLE_TIMEOUT_MS) {
            setSession('idle');
          }
        } else {
          bothLostSinceRef.current = null;
        }
      }

      if (session === 'idle') {
        // §4.3: on re-detection, return to live instantly
        if (anyHand) {
          setSession('live');
          rampTargetRef.current = 1;
          rampSpeedRef.current = 1 / (RAMP_RETURN_MS / 16.67);
          bothLostSinceRef.current = null;
        }
      }

      // ── Ramp envelope update
      if (rampRef.current < rampTargetRef.current) {
        rampRef.current = Math.min(rampRef.current + rampSpeedRef.current, rampTargetRef.current);
      } else if (rampRef.current > rampTargetRef.current) {
        rampRef.current = Math.max(rampRef.current - rampSpeedRef.current * 0.5, rampTargetRef.current);
      }

      // ── Detect hand LOST transitions → fire gracefulRelease (§3)
      for (let h = 0; h < 2; h++) {
        const currentTrack = hands[h]?.track ?? 'lost';
        const prevTrack = prevTrackRef.current[h] ?? 'lost';
        if (prevTrack !== 'lost' && currentTrack === 'lost') {
          effect.gracefulRelease(h);
        }
        prevTrackRef.current[h] = currentTrack;
      }

      // ── Step effect physics
      if (session === 'live' || session === 'idle') {
        effect.step(hands, dt, rampRef.current, video);
      }

      // ── Draw
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (!effect.effectIncludesVideo) {
        // Draw mirrored video as background
        ctx.save();
        ctx.translate(CANVAS_WIDTH, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        ctx.restore();
      }

      if (session === 'live' || session === 'idle') {
        effect.draw(ctx, video);
      } else if (session === 'awaitingHands') {
        // During awaiting, just show mirrored webcam (dimmed via CSS overlay)
        if (effect.effectIncludesVideo) {
          ctx.save();
          ctx.translate(CANVAS_WIDTH, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(video, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          ctx.restore();
        }
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, effect, signalsRef]);

  // ── Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className={styles.container}>
      {/* Hidden video element */}
      <video
        ref={videoRef}
        className={styles.videoHidden}
        playsInline
        muted
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
      />

      {/* Main canvas */}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
      />

      {/* ── Pre-Permission Screen (§4.1) */}
      {session === 'prePermission' && (
        <div className={styles.prePermission}>
          <div className={styles.onboardingCard}>
            <span className={styles.onboardingSub}>CALIBRATING ENGINE</span>
            
            <div className={styles.promptTitle} style={{ color: palette.primary }}>
              ⚡ {config.prompt}
            </div>

            <div className={styles.instructionBox}>
              <h3 className={styles.instructionTitle} style={{ borderBottomColor: `${palette.primary}20` }}>
                {INSTRUCTION_DETAILS[config.effect].title}
              </h3>
              <ul className={styles.instructionList}>
                {INSTRUCTION_DETAILS[config.effect].steps.map((step, i) => (
                  <li key={i} className={styles.instructionStep}>
                    <span className={styles.stepNum} style={{ color: palette.primary }}>0{i + 1}</span>
                    <span className={styles.stepText}>{step}</span>
                  </li>
                ))}
              </ul>
              <div className={styles.onboardingGestureRow} style={{ color: palette.primary }}>
                <span className={styles.gestureHeader}>GESTURES:</span>
                <span className={styles.gestureDetails}>{INSTRUCTION_DETAILS[config.effect].gesture}</span>
              </div>
            </div>

            <p className={styles.trustCopy}>
              your camera feed never leaves this device — all tracking runs in your browser
            </p>
            
            <button
              className={styles.enableButton}
              style={{ background: palette.primary, boxShadow: `0 0 30px ${palette.glow}40` }}
              onClick={requestCamera}
            >
              Enable Camera & Begin
            </button>
          </div>
        </div>
      )}

      {/* ── Permission Denied (§4.1) */}
      {session === 'permissionDenied' && (
        <div className={styles.errorScreen}>
          <div className={styles.errorIcon}>📷</div>
          <h2 className={styles.errorTitle}>Camera access is blocked</h2>
          <p className={styles.errorBody}>
            This experience is your camera. Click the 🔒 icon in the address bar → allow camera → tap retry.
            <br /><br />
            Your camera feed never leaves this device.
          </p>
          <button className={styles.retryButton} onClick={requestCamera}>
            Try again
          </button>
        </div>
      )}

      {/* ── No Camera (§4.1) */}
      {session === 'noCamera' && (
        <div className={styles.errorScreen}>
          <div className={styles.errorIcon}>🚫</div>
          <h2 className={styles.errorTitle}>No camera found</h2>
          <p className={styles.errorBody}>
            This experience needs a camera to work. Try opening it on a device with a webcam.
          </p>
          <a href="/" className={styles.retryButton} style={{ textDecoration: 'none' }}>
            Go home
          </a>
        </div>
      )}

      {/* ── Initializing / Warming Up (§4.1) */}
      {session === 'initializing' && (
        <div className={styles.warmingUp}>
          warming up hand tracking…
        </div>
      )}

      {/* ── Awaiting Hands Overlay (§4.2) */}
      {session === 'awaitingHands' && (
        <>
          <div className={styles.dimOverlay} />
          <div className={styles.awaitingOverlay}>
            <div className={styles.showHands}>✋ Show me your hands</div>
            <div className={styles.gestureHint}>{meta.gestureHint}</div>
          </div>
          <div className={styles.titleCard} style={{ color: palette.primary }}>
            {config.prompt}
          </div>
        </>
      )}

      {/* ── Live: Gesture hint (stays 4s then fades) */}
      {session === 'live' && showGestureHint && (
        <div className={styles.gestureHint} style={{
          position: 'absolute', bottom: '8%', left: '50%', transform: 'translateX(-50%)',
          zIndex: 12, pointerEvents: 'none',
        }}>
          {meta.gestureHint}
        </div>
      )}

      {/* ── Idle Overlay (§4.3) */}
      {session === 'idle' && (
        <div className={`${styles.idleOverlay} ${styles.visible}`}>
          <div className={styles.showHands}>✋ Show me your hands</div>
        </div>
      )}

      {/* ── Recording Indicator */}
      {(session === 'live' || session === 'idle') && (
        <div className={`${styles.recordingDot} ${session === 'live' ? styles.visible : ''}`}>
          REC
        </div>
      )}

      {/* ── Quality Monitor Toast (§4.5) */}
      {toastText && (
        <div className={`${styles.toast} ${styles.visible}`}>
          {toastText}
        </div>
      )}

      {/* ── Performance Overlay (§6) */}
      {showDebug && (
        <div className={styles.perfOverlay}>
          <span ref={perfFpsRef}>FPS: --</span>
          <span ref={perfHzRef}>Det: --Hz</span>
          <span ref={perfEntitiesRef}>Ent: --</span>
          <span ref={perfHandsRef}>Hands: --</span>
          <span ref={perfDroppedRef}>Drop: 0</span>
        </div>
      )}

      {/* ── Help Toggle Button */}
      {(session === 'live' || session === 'idle' || session === 'awaitingHands') && (
        <button 
          className={styles.helpToggleButton}
          onClick={() => setShowHelp(prev => !prev)}
          title="Show Gestures & Controls"
        >
          ? Controls
        </button>
      )}

      {/* ── Help Overlay Modal */}
      {showHelp && (
        <div className={styles.helpOverlayModal}>
          <div className={styles.helpOverlayBackdrop} onClick={() => setShowHelp(false)} />
          <div className={styles.helpOverlayContent}>
            <button className={styles.closeHelpButton} onClick={() => setShowHelp(false)}>×</button>
            <span className={styles.onboardingSub}>TRANSMISSION MANUAL</span>
            <h2 className={styles.helpOverlayTitle} style={{ color: palette.primary }}>
              {INSTRUCTION_DETAILS[config.effect].title}
            </h2>
            <div className={styles.helpPrompt}>
              Current Prompt: <span style={{ color: '#fff' }}>"{config.prompt}"</span>
            </div>
            
            <div className={styles.instructionBox} style={{ background: 'rgba(255,255,255,0.01)' }}>
              <ul className={styles.instructionList}>
                {INSTRUCTION_DETAILS[config.effect].steps.map((step, i) => (
                  <li key={i} className={styles.instructionStep}>
                    <span className={styles.stepNum} style={{ color: palette.primary }}>0{i + 1}</span>
                    <span className={styles.stepText}>{step}</span>
                  </li>
                ))}
              </ul>
              <div className={styles.onboardingGestureRow} style={{ color: palette.primary, background: 'rgba(255,255,255,0.03)', borderTopStyle: 'solid' }}>
                <span className={styles.gestureHeader}>GESTURES:</span>
                <span className={styles.gestureDetails}>{INSTRUCTION_DETAILS[config.effect].gesture}</span>
              </div>
            </div>

            <button 
              className={styles.closeHelpActionBtn}
              style={{ background: palette.primary }}
              onClick={() => setShowHelp(false)}
            >
              Resume Experience
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
