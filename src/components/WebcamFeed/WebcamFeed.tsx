"use client";

import React, { useEffect, useRef, useState } from 'react';
import styles from './WebcamFeed.module.css';

interface WebcamFeedProps {
  isActive: boolean;
  onStreamReady?: (videoElement: HTMLVideoElement) => void;
  children?: React.ReactNode;
  fullscreen?: boolean;
}

export function WebcamFeed({ isActive, onStreamReady, children, fullscreen = false }: WebcamFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        });
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setHasPermission(true);
          
          // Wait for video to actually start playing before passing ref
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play();
            if (videoRef.current && onStreamReady) {
              onStreamReady(videoRef.current);
            }
          };
        }
      } catch (err) {
        console.error("Error accessing webcam:", err);
        setHasPermission(false);
      }
    };

    startCamera();

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [onStreamReady]);

  return (
    <div className={`${styles.container} ${isActive ? styles.active : ''} ${fullscreen ? styles.fullscreen : ''}`}>
      {hasPermission === false && (
        <div className={styles.error}>Camera access denied</div>
      )}
      <video
        ref={videoRef}
        className={styles.video}
        playsInline
        muted
      />
      {children}
    </div>
  );
}
