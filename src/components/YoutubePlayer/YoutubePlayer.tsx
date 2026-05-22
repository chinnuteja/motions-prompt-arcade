"use client";

import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import YouTube, { YouTubeProps } from 'react-youtube';
import styles from './YoutubePlayer.module.css';

interface YoutubePlayerApi {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo?: (time: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
}

interface YoutubePlayerProps {
  videoId: string;
  onPlayingChange?: (playing: boolean) => void;
}

export const YoutubePlayer = forwardRef<VideoPlayerHandle, YoutubePlayerProps>(
  ({ videoId, onPlayingChange }, ref) => {
    const playerRef = useRef<YoutubePlayerApi | null>(null);
    const [isReady, setIsReady] = useState(false);

    useImperativeHandle(ref, () => ({
      play: () => {
        if (isReady && playerRef.current) {
          playerRef.current.playVideo();
        }
      },
      pause: () => {
        if (isReady && playerRef.current) {
          playerRef.current.pauseVideo();
        }
      },
      seekTo: (time: number) => {
        if (isReady && playerRef.current) {
          playerRef.current.seekTo(Math.max(0, time), true);
        }
      },
      getCurrentTime: () => {
        if (isReady && playerRef.current) {
          return playerRef.current.getCurrentTime() || 0;
        }
        return 0;
      },
      getDuration: () => {
        if (isReady && playerRef.current) {
          return playerRef.current.getDuration() || 0;
        }
        return 0;
      }
    }));

    const onPlayerReady: YouTubeProps['onReady'] = (event) => {
      playerRef.current = event.target;
      setIsReady(true);
    };

    const onStateChange: YouTubeProps['onStateChange'] = (event) => {
      // YouTube.PlayerState.PLAYING = 1
      // YouTube.PlayerState.PAUSED = 2
      if (event.data === 1) {
        onPlayingChange?.(true);
      } else if (event.data === 2) {
        onPlayingChange?.(false);
      }
    };

    const opts: YouTubeProps['opts'] = {
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0, // Hide native controls
        modestbranding: 1,
        rel: 0,
        fs: 0,
        disablekb: 1,
      },
    };

    return (
      <div className={styles.container}>
        <YouTube
          videoId={videoId}
          opts={opts}
          onReady={onPlayerReady}
          onStateChange={onStateChange}
          className={styles.youtubeWrapper}
          iframeClassName={styles.iframe}
        />
        {/* Transparent overlay to prevent users from clicking the video directly */}
        <div className={styles.clickShield} />
      </div>
    );
  }
);

YoutubePlayer.displayName = 'YoutubePlayer';
