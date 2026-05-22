import { useEffect, useRef, useState, useCallback } from 'react';
import { FilesetResolver, PoseLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';

export function usePoseDetection(
  videoElement: HTMLVideoElement | null,
  isRunning: boolean
) {
  const [isReady, setIsReady] = useState(false);
  const landmarksRef = useRef<NormalizedLandmark[] | null>(null);
  
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const requestRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef<number>(-1);
  const detectPoseRef = useRef<() => void>(() => {});

  // Initialize PoseLandmarker once
  useEffect(() => {
    let isMounted = true;

    const initMediaPipe = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        );
        
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/mediapipe/pose_landmarker_lite.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });

        if (isMounted) {
          landmarkerRef.current = landmarker;
          setIsReady(true);
        }
      } catch (error) {
        console.error("Failed to initialize MediaPipe Pose Landmarker:", error);
      }
    };

    initMediaPipe();

    return () => {
      isMounted = false;
      if (landmarkerRef.current) {
        landmarkerRef.current.close();
      }
    };
  }, []);

  // Frame detection loop
  useEffect(() => {
    let animationFrameId: number;

    const loop = () => {
      if (!videoElement || !landmarkerRef.current || !isRunning) return;
      if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) {
        if (isRunning) {
          animationFrameId = requestAnimationFrame(loop);
        }
        return;
      }
      
      const startTimeMs = performance.now();
      if (videoElement.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = videoElement.currentTime;
        const results = landmarkerRef.current.detectForVideo(videoElement, startTimeMs);
        if (results.landmarks && results.landmarks.length > 0) {
          landmarksRef.current = results.landmarks[0];
        } else {
          landmarksRef.current = null;
        }
      }
      
      if (isRunning) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };

    if (isRunning && isReady && videoElement) {
      animationFrameId = requestAnimationFrame(loop);
    } else {
      landmarksRef.current = null;
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isRunning, isReady, videoElement]);

  return { landmarksRef, isReady };
}
