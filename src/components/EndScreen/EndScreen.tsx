"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GameConfig, encodeGameConfig } from '../../lib/schema';
import styles from './EndScreen.module.css';

interface EndScreenProps {
  recordedBlob: Blob | null;
  config: GameConfig;
  score: number;
}

export function EndScreen({ recordedBlob, config, score }: EndScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);
  const videoUrl = useMemo(() => {
    if (!recordedBlob) return null;
    return URL.createObjectURL(recordedBlob);
  }, [recordedBlob]);

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleDownload = () => {
    if (!recordedBlob) return;
    const url = URL.createObjectURL(recordedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompt-arcade-${config.title.replace(/\s+/g, '-').toLowerCase()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleShareLink = async () => {
    const encoded = encodeGameConfig(config);
    const shareUrl = `${window.location.origin}/play?config=${encoded}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const handlePlayAgain = () => {
    window.location.reload();
  };

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <h1 className={styles.title}>
          {score > 0 ? `${score} Points!` : "Game Over"}
        </h1>
        <p className={styles.subtitle}>
          {config.title} — powered by AI prompt compilation and real-time body tracking.
        </p>

        <div className={styles.buildReceipt}>
          <h3 className={styles.receiptTitle}>Game Receipt</h3>
          <div className={styles.receiptRow}><span>Game</span><strong>{config.title}</strong></div>
          <div className={styles.receiptRow}><span>Mechanic</span><strong>{config.mechanic}</strong></div>
          <div className={styles.receiptRow}><span>Primitive</span><strong>{config.primitive}</strong></div>
          <div className={styles.receiptRow}><span>Duration</span><strong>{config.duration}s</strong></div>
          <div className={styles.receiptRow}><span>Final Score</span><strong>{score}</strong></div>
          <div className={styles.receiptRow}><span>Processing</span><strong>Browser-local MediaPipe</strong></div>
        </div>
        
        <div className={styles.actions}>
          {recordedBlob && (
            <button className={styles.primaryButton} onClick={handleDownload}>
              Download Clip ↓
            </button>
          )}
          <button className={`${styles.secondaryButton} ${copied ? styles.copiedFlash : ''}`} onClick={handleShareLink}>
            {copied ? 'Copied to Clipboard! ✅' : 'Share Game Link 🔗'}
          </button>
          <button className={styles.tertiaryButton} onClick={handlePlayAgain}>
            Play Again ↻
          </button>
        </div>
      </div>

      <div className={styles.phonePreview}>
        <div className={styles.phoneFrame}>
          {videoUrl ? (
            <video 
              ref={videoRef}
              src={videoUrl} 
              className={styles.videoPlayer}
              autoPlay 
              muted 
              loop
              playsInline
            />
          ) : (
            <div className={styles.emptyVideo}>
              <div className={styles.emptyIcon}>🎮</div>
              <p>No recording captured</p>
            </div>
          )}
          
          {/* Branded overlays */}
          <div className={styles.watermark}>
            PROMPT.arcade
          </div>
          <div className={styles.caption}>
            {config.threatEmoji || '🎯'} {config.title} — Score: {score}
          </div>
        </div>
      </div>
    </div>
  );
}
