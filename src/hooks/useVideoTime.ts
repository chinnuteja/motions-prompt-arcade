import { useState, useEffect, useRef } from 'react';

/**
 * Custom hook to accurately poll a video's currentTime using requestAnimationFrame.
 * This is necessary because the native 'timeupdate' event only fires at ~4Hz.
 */
export function useVideoTime(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  isPlaying: boolean
) {
  const [currentTime, setCurrentTime] = useState(0);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying || !videoRef.current) return;

    const updateTime = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
      frameRef.current = requestAnimationFrame(updateTime);
    };

    frameRef.current = requestAnimationFrame(updateTime);

    return () => {
      cancelAnimationFrame(frameRef.current);
    };
  }, [isPlaying, videoRef]);

  return currentTime;
}
