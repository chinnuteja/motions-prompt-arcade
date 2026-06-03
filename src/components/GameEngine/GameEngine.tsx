"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameConfig } from '../../lib/schema';
import { useGameReducer } from '../../hooks/useGameReducer';
import { usePoseDetection } from '../../hooks/usePoseDetection';
import { useClipRecorder } from '../../hooks/useClipRecorder';
import { WebcamFeed } from '../WebcamFeed/WebcamFeed';
import { DebugPanel } from '../DebugPanel/DebugPanel';
import { EndScreen } from '../EndScreen/EndScreen';
import { IntroScreen } from '../IntroScreen/IntroScreen';
import { getEvaluatorForPrimitive } from '../../lib/evaluators';
import { NormalizedLandmark } from '@mediapipe/tasks-vision';
import styles from './GameEngine.module.css';
import confetti from 'canvas-confetti';

function drawSkeleton(ctx: CanvasRenderingContext2D, landmarks: NormalizedLandmark[], width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  
  const POSE_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
    [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
    [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
    [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
    [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32]
  ];

  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 255, 150, 0.8)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';

  for (const connection of POSE_CONNECTIONS) {
    const from = landmarks[connection[0]];
    const to = landmarks[connection[1]];
    if (from && to) {
      // visibility might be undefined depending on model, but usually present
      const visFrom = from.visibility ?? 1;
      const visTo = to.visibility ?? 1;
      if (visFrom > 0.5 && visTo > 0.5) {
        ctx.beginPath();
        // 1 - x to account for mirrored video feed
        ctx.moveTo((1 - from.x) * width, from.y * height);
        ctx.lineTo((1 - to.x) * width, to.y * height);
        ctx.stroke();
      }
    }
  }

  for (let i = 0; i < landmarks.length; i++) {
    const landmark = landmarks[i];
    const vis = landmark.visibility ?? 1;
    if (vis > 0.5) {
      ctx.beginPath();
      ctx.arc((1 - landmark.x) * width, landmark.y * height, 6, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

interface GameEngineProps {
  config: GameConfig;
}

export function GameEngine({ config }: GameEngineProps) {
  const [gameState, dispatch] = useGameReducer();
  const [webcamVideo, setWebcamVideo] = useState<HTMLVideoElement | null>(null);
  
  // Game mechanic states
  const [threats, setThreats] = useState<{ id: number; lane: number }[]>([]);
  // Keep threats in sync with ref for composite drawing
  useEffect(() => { threatsRef.current = threats; }, [threats]);
  const threatIdCounter = useRef(0);
  const lastThreatTime = useRef(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const { startRecording, stopRecording } = useClipRecorder();
  
  // Only run pose detection when we are in countdown or playing
  const isDetectionActive = gameState.status === 'COUNTDOWN' || gameState.status === 'PLAYING';
  const { landmarksRef, isReady } = usePoseDetection(webcamVideo, isDetectionActive);

  const evaluator = useRef(getEvaluatorForPrimitive(config.primitive));
  
  const scoreLockRef = useRef(false);
  const holdFramesRef = useRef(0);

  // DOM Refs for direct 60fps manipulation
  const repCircleRef = useRef<HTMLDivElement>(null);
  const laneIndicatorRef = useRef<HTMLDivElement>(null);
  const poseSilhouetteRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Composite recording canvas (hidden, off-screen)
  const compositeCanvasRef = useRef<HTMLCanvasElement>(null);
  const threatsRef = useRef<{ id: number; lane: number }[]>([]);

  useEffect(() => {
    // Resize canvas to match screen
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    handleResize(); // Initial set
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    // Refresh evaluator if primitive changes
    evaluator.current = getEvaluatorForPrimitive(config.primitive);
  }, [config.primitive]);

  // Handle stream ready
  const handleWebcamReady = useCallback((videoElement: HTMLVideoElement) => {
    setWebcamVideo(videoElement);
  }, []);

  // Handle start button
  const handleStart = () => {
    // Use the composite canvas stream for recording (webcam + skeleton + emojis + HUD)
    if (compositeCanvasRef.current) {
      const compositeStream = compositeCanvasRef.current.captureStream(30);
      startRecording(compositeStream);
    } else if (webcamVideo?.srcObject) {
      // Fallback to raw webcam if composite canvas isn't ready
      startRecording(webcamVideo.srcObject as MediaStream);
    }
    dispatch({ type: 'START_COUNTDOWN' });
  };

  // Countdown timer
  useEffect(() => {
    if (gameState.status === 'COUNTDOWN') {
      const timer1 = setTimeout(() => dispatch({ type: 'TICK_COUNTDOWN', newCount: 2 }), 1000);
      const timer2 = setTimeout(() => dispatch({ type: 'TICK_COUNTDOWN', newCount: 1 }), 2000);
      const timer3 = setTimeout(() => dispatch({ type: 'START_PLAYING', initialTime: config.duration }), 3000);
      return () => { clearTimeout(timer1); clearTimeout(timer2); clearTimeout(timer3); };
    }
  }, [gameState.status, dispatch, config.duration]);

  // Play timer
  useEffect(() => {
    let interval: number;
    if (gameState.status === 'PLAYING') {
      interval = window.setInterval(() => {
        dispatch({ type: 'TICK_TIME', timeLeft: gameState.timeLeft - 1 });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [gameState.status, gameState.timeLeft, dispatch]);

  // Finish experience hook
  useEffect(() => {
    if (gameState.status === 'GAME_OVER') {
      stopRecording().then((blob: Blob | null) => setRecordedBlob(blob));
    }
  }, [gameState.status, stopRecording]);

  // ==========================================
  // TRUE 60FPS GAME LOOP (Bypasses React Render)
  // ==========================================
  const statusRef = useRef(gameState.status);
  statusRef.current = gameState.status;

  useEffect(() => {
    if (gameState.status !== 'PLAYING') return;

    let animationFrameId: number;

    const gameLoop = () => {
      // 1. Evaluate Current Frame
      const currentLandmarks = landmarksRef.current;
      let conf = 0; // Default center/zero
      if (currentLandmarks) {
         conf = evaluator.current(currentLandmarks);
      }

      // 1.5 Draw Skeleton on visible canvas
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
          if (currentLandmarks) {
             drawSkeleton(ctx, currentLandmarks, canvasRef.current.width, canvasRef.current.height);
          } else {
             ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          }
        }
      }

      // 1.6 Draw Composite Frame for recording (webcam + skeleton + HUD)
      if (compositeCanvasRef.current && webcamVideo) {
        const cc = compositeCanvasRef.current;
        const cctx = cc.getContext('2d');
        if (cctx) {
          // Set composite canvas size to match webcam
          if (cc.width !== 640) cc.width = 640;
          if (cc.height !== 480) cc.height = 480;

          // Draw mirrored webcam feed
          cctx.save();
          cctx.translate(cc.width, 0);
          cctx.scale(-1, 1);
          cctx.drawImage(webcamVideo, 0, 0, cc.width, cc.height);
          cctx.restore();

          // Draw skeleton overlay
          if (currentLandmarks) {
            drawSkeleton(cctx, currentLandmarks, cc.width, cc.height);
          }

          // Draw falling emoji threats
          const currentThreats = threatsRef.current;
          if (currentThreats.length > 0 && config.threatEmoji) {
            cctx.font = '48px serif';
            cctx.textAlign = 'center';
            for (const threat of currentThreats) {
              const x = (0.2 + threat.lane * 0.3) * cc.width;
              cctx.fillText(config.threatEmoji, x, cc.height * 0.3);
            }
          }

          // Draw HUD: Score + Time
          cctx.fillStyle = 'rgba(0,0,0,0.5)';
          cctx.fillRect(10, 10, 100, 50);
          cctx.fillRect(cc.width - 110, 10, 100, 50);
          cctx.fillStyle = '#fff';
          cctx.font = 'bold 24px Inter, sans-serif';
          cctx.textAlign = 'left';
          cctx.fillText(`${gameState.score}`, 30, 45);
          cctx.textAlign = 'right';
          cctx.fillText(`${gameState.timeLeft}s`, cc.width - 30, 45);
          cctx.font = '10px Inter, sans-serif';
          cctx.fillStyle = '#a1a1aa';
          cctx.textAlign = 'left';
          cctx.fillText('SCORE', 30, 25);
          cctx.textAlign = 'right';
          cctx.fillText('TIME', cc.width - 30, 25);

          // Draw game instructions
          cctx.fillStyle = config.themeColor || '#fff';
          cctx.font = 'bold 16px Inter, sans-serif';
          cctx.textAlign = 'center';
          cctx.fillText(config.instructions.toUpperCase(), cc.width / 2, cc.height - 20);
        }
      }

      // 2. Direct DOM Manipulation for 60fps Visuals
      if (config.mechanic === 'count-reps' && repCircleRef.current) {
         repCircleRef.current.style.transform = `scale(${0.5 + conf * 0.5})`;
         repCircleRef.current.style.opacity = `${0.2 + conf * 0.8}`;
      } else if (config.mechanic === 'survival-dodge' && laneIndicatorRef.current) {
         // conf for dodge is 0 (left), 1 (center), 2 (right)
         laneIndicatorRef.current.style.left = `${20 + Math.round(conf) * 30}%`;
      } else if (config.mechanic === 'pose-match' && poseSilhouetteRef.current) {
         poseSilhouetteRef.current.style.opacity = conf > 0.8 ? '0.8' : '0.3';
      }

      // 3. High-Frequency Logic (Reps & Pose Matching)
      if (config.mechanic === 'count-reps') {
         if (conf > 0.8 && !scoreLockRef.current) {
           dispatch({ type: 'INCREMENT_SCORE' });
           scoreLockRef.current = true;
           confetti({ particleCount: 30, spread: 50, origin: { y: 0.8 }, zIndex: 10000 });
         } else if (conf < 0.4) {
           scoreLockRef.current = false;
         }
      } 
      else if (config.mechanic === 'pose-match') {
         if (conf > 0.8) {
           holdFramesRef.current += 1;
           if (holdFramesRef.current > 15) { 
             dispatch({ type: 'INCREMENT_SCORE' });
             holdFramesRef.current = 0;
             confetti({ particleCount: 50, spread: 70, origin: { y: 0.6 }, zIndex: 10000 });
           }
         } else {
           holdFramesRef.current = 0;
         }
      }

      // Keep looping
      animationFrameId = requestAnimationFrame(gameLoop);
    };

    animationFrameId = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [gameState.status, config.mechanic, dispatch, landmarksRef]);

  // ==========================================
  // HIGH-INTENSITY THREAT SPAWNER (Survival Dodge & Strike Targets)
  // ==========================================
  useEffect(() => {
    if (gameState.status !== 'PLAYING' || (config.mechanic !== 'survival-dodge' && config.mechanic !== 'strike-targets')) return;
    
    const now = Date.now();
    // Spawn threats faster (1.2 seconds) to make it highly competitive
    if (now - lastThreatTime.current > 1200) {
      lastThreatTime.current = now;
      
      let targetLane = 1; // default center
      if (config.mechanic === 'survival-dodge') {
         // Target the player! 70% chance to drop exactly where they are standing to force a dodge.
         if (landmarksRef.current) {
           targetLane = Math.round(evaluator.current(landmarksRef.current));
         }
         // 30% chance to drop somewhere else to keep them guessing
         if (Math.random() > 0.7) {
           const otherLanes = [0, 1, 2].filter(l => l !== targetLane);
           targetLane = otherLanes[Math.floor(Math.random() * otherLanes.length)];
         }
      } else {
         // For strike targets, randomize the lane so they have to aim punches
         targetLane = Math.floor(Math.random() * 3);
      }

      const threatId = threatIdCounter.current++;
      setThreats(prev => [...prev, { id: threatId, lane: targetLane }]);
      
      // Collision occurs when the ball hits the bottom (around 1.3s depending on CSS)
      setTimeout(() => {
        if (statusRef.current === 'PLAYING') {
           if (config.mechanic === 'strike-targets') {
              // Punch collision! You need high velocity (conf > 0.5) to destroy the target
              let isPunching = false;
              if (landmarksRef.current) {
                isPunching = evaluator.current(landmarksRef.current) > 0.5;
              }
              if (isPunching) {
                 dispatch({ type: 'INCREMENT_SCORE' });
                 confetti({ particleCount: 30, spread: 50, origin: { y: 0.8 }, zIndex: 10000 });
              } else {
                 dispatch({ type: 'END_GAME' });
              }
           } else {
              // Exact position at moment of impact for dodging
              let impactLane = 1;
              if (landmarksRef.current) {
                impactLane = Math.round(evaluator.current(landmarksRef.current));
              }

              if (impactLane === targetLane) {
                 dispatch({ type: 'END_GAME' });
              } else {
                 dispatch({ type: 'INCREMENT_SCORE' });
              }
           }
        }
      }, 1300); // 1.3s is when it hits the physical body area

      // Remove visual from DOM slightly later so it falls off screen naturally
      setTimeout(() => {
         setThreats(prev => prev.filter(t => t.id !== threatId));
      }, 1500);
    }
  }, [gameState.status, config.mechanic, gameState.timeLeft, dispatch, landmarksRef]);


  if (gameState.status === 'GAME_OVER') {
    return <EndScreen recordedBlob={recordedBlob} config={config} score={gameState.score} />;
  }

  if (gameState.status === 'SETUP') {
    return <IntroScreen onStart={handleStart} mediaPipeReady={isReady} customTitle={config.title} customDescription={config.instructions} />;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.scoreBoard}>
          <div className={styles.scoreLabel}>{config.mechanic === 'survival-dodge' ? 'SURVIVED' : 'SCORE'}</div>
          <div className={styles.scoreValue}>{gameState.score}</div>
        </div>
        <div className={styles.timerBoard}>
          <div className={styles.timerLabel}>TIME</div>
          <div className={`${styles.timerValue} ${gameState.timeLeft <= 5 ? styles.urgent : ''}`}>
            {gameState.timeLeft}s
          </div>
        </div>
      </div>

      <div className={styles.gameArea}>
        <WebcamFeed isActive={true} onStreamReady={handleWebcamReady} fullscreen={true}>
          {/* Debug panel removed to prevent React render lag */}
          
          {gameState.status === 'COUNTDOWN' && (
            <div className={styles.overlay}>
              <div className={styles.countdown}>{gameState.countdown}</div>
              <div className={styles.instruction}>{config.instructions}</div>
            </div>
          )}

          {gameState.status === 'PLAYING' && (
            <div className={styles.playingOverlay}>
               {/* Skeleton Canvas Overlay */}
               <canvas ref={canvasRef} className={styles.skeletonCanvas} />
               {/* Hidden composite canvas for recording */}
               <canvas ref={compositeCanvasRef} style={{ display: 'none' }} />
              
              {/* Massive Game Instructions */}
              <div className={styles.gameInstructionBanner} style={{ color: config.themeColor || '#fff', textShadow: `0 4px 30px rgba(0,0,0,0.8), 0 0 20px ${config.themeColor || '#6366f1'}` }}>
                {config.instructions.toUpperCase()}
              </div>

              {(config.mechanic === 'survival-dodge' || config.mechanic === 'strike-targets') && (
                 <>
                   {threats.map(threat => (
                     <div 
                       key={threat.id} 
                       className={config.threatEmoji ? styles.emojiObstacle : styles.obstacle} 
                       style={{ left: `${20 + threat.lane * 30}%` }}
                     >
                        {config.threatEmoji}
                     </div>
                   ))}
                   
                   {/* User's body is the controller, no need for a confusing green surface */}
                   {config.mechanic === 'survival-dodge' && (
                     <div ref={laneIndicatorRef} className={styles.playerGlow} style={{ left: '50%' }} />
                   )}
                 </>
              )}
              {config.mechanic === 'count-reps' && (
                 <div className={styles.repIndicator}>
                    <div ref={repCircleRef} className={styles.repCircle} style={{ transform: 'scale(0.5)', opacity: 0.2 }}></div>
                 </div>
              )}
              {config.mechanic === 'pose-match' && (
                 <div className={styles.poseIndicator}>
                    <div ref={poseSilhouetteRef} className={styles.poseSilhouette} style={{ opacity: 0.3 }}>🧍</div>
                 </div>
              )}
            </div>
          )}
        </WebcamFeed>
      </div>
    </div>
  );
}
