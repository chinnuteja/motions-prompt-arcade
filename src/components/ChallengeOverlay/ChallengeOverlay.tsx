"use client";

import React from 'react';
import styles from './ChallengeOverlay.module.css';

interface ChallengeOverlayProps {
  state: 'CHALLENGE_INTRO' | 'CHALLENGE_ACTIVE' | 'CHALLENGE_SUCCESS';
  instruction: string;
  challengeType?: string;
  confidence: number;
  countdown: number; // 3, 2, 1 during intro
}

function getHint(challengeType?: string) {
  if (!challengeType) return 'Hold the pose...';
  if (challengeType.includes('punch')) return 'Snap fast punches for impact...';
  if (challengeType.includes('movement')) return 'Keep your body moving continuously...';
  return 'Hold the pose...';
}

export function ChallengeOverlay({ state, instruction, challengeType, confidence, countdown }: ChallengeOverlayProps) {
  // SVG ring parameters
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (confidence * circumference);
  const variantClass = challengeType?.includes('punch') ? styles.punch : challengeType?.includes('movement') ? styles.movement : '';

  return (
    <div className={`${styles.overlay} ${variantClass} ${state === 'CHALLENGE_SUCCESS' ? styles.success : ''}`}>
      <div className={styles.content}>
        
        {/* INTRO: Show countdown */}
        {state === 'CHALLENGE_INTRO' && (
          <div className={styles.introBox}>
            <p className={styles.getReady}>Get Ready!</p>
            <div className={styles.countdownNumber}>{countdown}</div>
            <p className={styles.instruction}>{instruction}</p>
          </div>
        )}

        {/* ACTIVE: Show progress ring */}
        {state === 'CHALLENGE_ACTIVE' && (
          <div className={styles.activeBox}>
            <div className={styles.ringContainer}>
              <svg className={styles.ringSvg} viewBox="0 0 120 120">
                {/* Background ring */}
                <circle
                  cx="60" cy="60" r={radius}
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="6"
                />
                {/* Progress ring */}
                <circle
                  cx="60" cy="60" r={radius}
                  fill="none"
                  stroke="url(#progressGrad)"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  className={styles.progressCircle}
                  transform="rotate(-90 60 60)"
                />
                <defs>
                  <linearGradient id="progressGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#6366f1" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                </defs>
              </svg>
              <div className={styles.ringCenter}>
                <span className={styles.confidencePercent}>{Math.round(confidence * 100)}%</span>
              </div>
            </div>
            <p className={styles.instruction}>{instruction}</p>
            <p className={styles.hint}>{getHint(challengeType)}</p>
          </div>
        )}

        {/* SUCCESS: Celebration */}
        {state === 'CHALLENGE_SUCCESS' && (
          <div className={styles.successBox}>
            <div className={styles.checkmark}>✓</div>
            <h2 className={styles.greatJob}>Great Job! 🎉</h2>
          </div>
        )}
      </div>
    </div>
  );
}
