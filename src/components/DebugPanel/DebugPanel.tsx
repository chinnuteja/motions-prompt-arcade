"use client";

import React, { useEffect, useRef } from 'react';
import { NormalizedLandmark } from '@mediapipe/tasks-vision';
import styles from './DebugPanel.module.css';

interface DebugPanelProps {
  landmarks: NormalizedLandmark[] | null;
  videoElement?: HTMLVideoElement | null;
}

// MediaPipe pose connections for drawing the skeleton
const POSE_CONNECTIONS = [
  [11, 12], // Shoulders
  [11, 13], [13, 15], // Left arm
  [12, 14], [14, 16], // Right arm
  [11, 23], [12, 24], [23, 24], // Torso
];

export function DebugPanel({ landmarks, videoElement }: DebugPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    if (videoElement && videoElement.videoWidth) {
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
    } else {
      canvas.width = 640;
      canvas.height = 480;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!landmarks) return;

    // Draw connections — glowing lines
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.7)';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#6366f1';
    ctx.shadowBlur = 6;
    
    POSE_CONNECTIONS.forEach(([startIdx, endIdx]) => {
      const start = landmarks[startIdx];
      const end = landmarks[endIdx];
      
      if (start && end) {
        ctx.beginPath();
        ctx.moveTo(start.x * canvas.width, start.y * canvas.height);
        ctx.lineTo(end.x * canvas.width, end.y * canvas.height);
        ctx.stroke();
      }
    });

    // Draw keypoints — small glowing dots
    ctx.shadowColor = '#f43f5e';
    ctx.shadowBlur = 4;
    ctx.fillStyle = 'rgba(244, 63, 94, 0.8)';
    
    // Only draw key joints (shoulders, elbows, wrists, hips)
    const keyJoints = [11, 12, 13, 14, 15, 16, 23, 24];
    keyJoints.forEach((idx) => {
      const landmark = landmarks[idx];
      if (landmark) {
        ctx.beginPath();
        ctx.arc(landmark.x * canvas.width, landmark.y * canvas.height, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    
  }, [landmarks, videoElement]);

  return (
    <div className={styles.container}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
      />
    </div>
  );
}
