"use client";

import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import styles from './VideoPlayer.module.css';

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo?: (time: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

interface VideoPlayerProps {
  src: string;
  onTimeUpdate?: (time: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, onTimeUpdate, onPlayingChange }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
      if (videoRef.current && videoRef.current.readyState >= 3) {
        setIsLoaded(true);
      }
    }, []);

    useImperativeHandle(ref, () => ({
      play: () => {
        videoRef.current?.play();
      },
      pause: () => {
        videoRef.current?.pause();
      },
      seekTo: (time: number) => {
        if (videoRef.current) {
          videoRef.current.currentTime = time;
        }
      },
      getCurrentTime: () => {
        return videoRef.current?.currentTime || 0;
      },
      getDuration: () => {
        return videoRef.current?.duration || 0;
      }
    }));

    // We still use timeupdate for general UI updates, but rely on rAF for game logic externally
    const handleTimeUpdate = () => {
      if (videoRef.current && onTimeUpdate) {
        onTimeUpdate(videoRef.current.currentTime);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      onPlayingChange?.(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
      onPlayingChange?.(false);
    };

    return (
      <div className={styles.playerContainer}>
        {!isLoaded && <div className={styles.loadingSkeleton}>Loading video...</div>}
        <video
          ref={videoRef}
          src={src}
          className={`${styles.video} ${isLoaded ? styles.loaded : ''}`}
          onTimeUpdate={handleTimeUpdate}
          onPlay={handlePlay}
          onPause={handlePause}
          onCanPlay={() => setIsLoaded(true)}
          onLoadedData={() => setIsLoaded(true)}
          playsInline
        />
        
        {/* Simple MVP controls if not playing */}
        {!isPlaying && isLoaded && (
          <button 
            className={styles.playOverlay}
            onClick={() => videoRef.current?.play()}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>
            </svg>
          </button>
        )}
      </div>
    );
  }
);

VideoPlayer.displayName = 'VideoPlayer';
