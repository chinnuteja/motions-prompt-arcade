"use client";

import React from 'react';
import { DemoVideo } from '../../lib/types';
import styles from './ReviewScreen.module.css';

interface ReviewScreenProps {
  video: DemoVideo;
  onAccept: () => void;
}

export function ReviewScreen({ video, onAccept }: ReviewScreenProps) {
  const pretty = (value?: string) => value || 'derived by agent';

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.header}>
          <h2 className={styles.title}>Your Generated Game Plan</h2>
          <p className={styles.subtitle}>
            We analyzed <strong>{video.title}</strong> and created this single playable camera game.
          </p>
        </div>

        <div className={styles.cardsList}>
          {video.challenges.map((challenge) => (
            <div key={challenge.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.timestamp}>
                  {Math.floor(challenge.triggerTimestamp / 60)}:
                  {(challenge.triggerTimestamp % 60).toString().padStart(2, '0')}
                </span>
                <span className={styles.agentBadge}>{challenge.challengeType || challenge.id}</span>
                <span className={styles.challengeName}>{challenge.instruction}</span>
              </div>

              <div className={styles.metaGrid}>
                <span>Primitive: {pretty(challenge.selectedPrimitive)}</span>
                <span>Signal: {pretty(challenge.inputSignal)}</span>
                <span>Win: {pretty(challenge.winCondition)}</span>
                <span>Difficulty: {pretty(challenge.difficulty)}</span>
              </div>

              {challenge.rationale && (
                <div className={styles.rationale}>
                  <span className={styles.reasoningLabel}>Agent reasoning:</span>
                  {challenge.rationale}
                </div>
              )}

              {challenge.viralMoment && <p className={styles.viral}>Viral moment: {challenge.viralMoment}</p>}
            </div>
          ))}
        </div>

        <div className={styles.actions}>
          <button className={styles.primaryButton} onClick={onAccept}>
            Launch This Game →
          </button>
        </div>
      </div>
    </div>
  );
}
