"use client";

import React, { useState, useEffect } from 'react';
import styles from './IntroScreen.module.css';

interface IntroScreenProps {
  onStart: () => void;
  mediaPipeReady: boolean;
  customTitle?: string;
  customDescription?: string;
}

export function IntroScreen({ onStart, mediaPipeReady, customTitle, customDescription }: IntroScreenProps) {
  const [cameraGranted, setCameraGranted] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [denied, setDenied] = useState(false);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    // Animate in after a brief delay
    const timer = setTimeout(() => setShowContent(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleRequestCamera = async () => {
    setRequesting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      // Stop the stream immediately — we just needed the permission
      stream.getTracks().forEach(t => t.stop());
      setCameraGranted(true);
    } catch {
      setDenied(true);
    }
    setRequesting(false);
  };

  return (
    <div className={styles.container}>
      {/* Animated background particles */}
      <div className={styles.bgGlow} />
      <div className={styles.bgGlow2} />

      <div className={`${styles.content} ${showContent ? styles.visible : ''}`}>
        {/* Logo / Brand */}
        <div className={styles.logoMark}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="url(#grad)" strokeWidth="3" />
            <circle cx="24" cy="16" r="4" fill="#6366f1" />
            <line x1="24" y1="20" x2="24" y2="32" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="24" x2="16" y2="20" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="24" x2="32" y2="20" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="32" x2="18" y2="38" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="32" x2="30" y2="38" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="48" y2="48">
                <stop stopColor="#6366f1" />
                <stop offset="1" stopColor="#f43f5e" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <h1 className={styles.title}>{customTitle || 'Kinetics'}</h1>
        <p className={styles.tagline}>Playable Camera Game</p>

        <div className={styles.description}>
          <p>{customDescription || 'Perform physical actions to score.'}</p>
          <p>Your camera tracks your movements — no data leaves your browser.</p>
        </div>

        {/* Permission Flow */}
        <div className={styles.steps}>
          <div className={`${styles.step} ${cameraGranted ? styles.stepDone : ''}`}>
            <div className={styles.stepIcon}>{cameraGranted ? '✓' : '1'}</div>
            <span>{cameraGranted ? 'Camera enabled' : 'Enable your camera'}</span>
          </div>
          <div className={`${styles.step} ${mediaPipeReady ? styles.stepDone : ''}`}>
            <div className={styles.stepIcon}>{mediaPipeReady ? '✓' : '2'}</div>
            <span>{mediaPipeReady ? 'AI model loaded' : 'Loading AI model...'}</span>
          </div>
        </div>

        {denied && (
          <p className={styles.error}>
            Camera access was denied. Please allow camera access and refresh the page.
          </p>
        )}

        {!cameraGranted && !denied && (
          <button
            className={styles.ctaButton}
            onClick={handleRequestCamera}
            disabled={requesting}
          >
            {requesting ? 'Requesting...' : 'Enable Camera'}
          </button>
        )}

        {cameraGranted && mediaPipeReady && (
          <button className={`${styles.ctaButton} ${styles.ctaReady}`} onClick={onStart}>
            Start Experience →
          </button>
        )}

        {cameraGranted && !mediaPipeReady && (
          <div className={styles.loadingBar}>
            <div className={styles.loadingFill} />
          </div>
        )}
      </div>

      <p className={styles.footer}>
        Built with MediaPipe · Runs 100% in your browser · No data uploaded
      </p>
    </div>
  );
}
