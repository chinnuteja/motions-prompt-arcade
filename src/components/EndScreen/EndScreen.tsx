"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DemoVideo } from '../../lib/types';
import styles from './EndScreen.module.css';

interface EndScreenProps {
  recordedBlob: Blob | null;
  video: DemoVideo | null;
  customTitle?: string;
}

export function EndScreen({ recordedBlob, video, customTitle }: EndScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const videoUrl = useMemo(() => {
    if (!recordedBlob) return null;
    return URL.createObjectURL(recordedBlob);
  }, [recordedBlob]);

  const challengeCount = video?.challenges.length || 0;
  const mechanics = Array.from(new Set((video?.challenges || []).map((c) => c.challengeType || c.id)));
  const primitives = Array.from(new Set((video?.challenges || []).map((c) => c.selectedPrimitive || c.challengeType || c.id)));

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  const handleMetadata = () => {
    if (videoRef.current) {
      // Start playback 10 seconds before the end
      const vid = videoRef.current;
      vid.currentTime = Math.max(0, vid.duration - 10);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const vid = videoRef.current;
      
      // Loop the last 10 seconds manually
      if (vid.currentTime >= vid.duration - 0.2) {
        vid.currentTime = Math.max(0, vid.duration - 10);
        setIsZoomed(false); // Reset zoom on loop
      }
      
      // Trigger the zoom effect 3 seconds into the 10-second clip
      if (vid.duration > 10) {
        if (!isZoomed && vid.currentTime > vid.duration - 7 && vid.currentTime < vid.duration - 1) {
          setIsZoomed(true);
        }
      } else {
         // Fallback if video is shorter than 10s
         if (!isZoomed && vid.currentTime > vid.duration * 0.5) setIsZoomed(true);
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        <h1 className={styles.title}>{customTitle || "Here's your clip"}</h1>
        <p className={styles.subtitle}>
          Generated product → Playable camera moment → Shareable output.
        </p>

        <div className={styles.buildReceipt}>
          <h3 className={styles.receiptTitle}>Build Receipt</h3>
          <div className={styles.receiptRow}><span>Source</span><strong>{video?.title || 'YouTube Video'}</strong></div>
          <div className={styles.receiptRow}><span>Mechanics</span><strong>{challengeCount}</strong></div>
          <div className={styles.receiptRow}><span>Challenge Types</span><strong>{mechanics.slice(0, 3).join(', ') || 'pose'}</strong></div>
          <div className={styles.receiptRow}><span>CV Primitives</span><strong>{primitives.slice(0, 3).join(', ') || 'pose-tracking'}</strong></div>
          <div className={styles.receiptRow}><span>Processing</span><strong>Browser-local MediaPipe</strong></div>
          <div className={styles.receiptRow}><span>Scope</span><strong>Narrated/instructional v1</strong></div>
          <div className={styles.receiptRow}><span>Created</span><strong>~30s</strong></div>
        </div>
        
        <div className={styles.actions}>
          <button className={styles.primaryButton}>
            Download Clip ↓
          </button>
          <button className={styles.secondaryButton}>
            Copy Link 🔗
          </button>
        </div>
      </div>

      <div className={styles.phonePreview}>
        <div className={`${styles.phoneFrame} ${isZoomed ? styles.zoomed : ''}`}>
          {videoUrl ? (
            <video 
              ref={videoRef}
              src={videoUrl} 
              className={styles.videoPlayer}
              autoPlay 
              muted 
              playsInline
              onLoadedMetadata={handleMetadata}
              onTimeUpdate={handleTimeUpdate}
            />
          ) : (
            <div className={styles.emptyVideo}>No recording found</div>
          )}
          
          {/* Vibe UI overlays to make it look like a real vertical video */}
          <div className={styles.caption}>
            wait this is actually genius for screen time 😭
          </div>
          <div className={styles.watermark}>
            KINETICS
          </div>
        </div>
      </div>
    </div>
  );
}
