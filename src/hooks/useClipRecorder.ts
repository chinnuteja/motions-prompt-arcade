"use client";

import { useRef, useCallback, useState } from 'react';
import { ClipSegment } from '../lib/types';

interface UseClipRecorderReturn {
  startRecording: (stream: MediaStream) => void;
  stopRecording: () => Promise<Blob | null>;
  markSegment: (label: string) => void;
  endSegment: () => void;
  isRecording: boolean;
  segments: ClipSegment[];
}

/**
 * Records the webcam stream using MediaRecorder.
 * Tracks challenge segments for highlight reel generation.
 */
export function useClipRecorder(): UseClipRecorderReturn {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const currentSegmentRef = useRef<{ startTime: number; label: string } | null>(null);
  const [segments, setSegments] = useState<ClipSegment[]>([]);
  const [isRecording, setIsRecording] = useState(false);

  const startRecording = useCallback((stream: MediaStream) => {
    // Determine best supported mime type
    const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
      ? 'video/webm; codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : 'video/mp4';

    try {
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.start(500); // Collect data every 500ms
      startTimeRef.current = Date.now();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, []);

  const markSegment = useCallback((label: string) => {
    const elapsed = Date.now() - startTimeRef.current;
    currentSegmentRef.current = { startTime: elapsed, label };
  }, []);

  const endSegment = useCallback(() => {
    if (currentSegmentRef.current) {
      const elapsed = Date.now() - startTimeRef.current;
      const newSegment: ClipSegment = {
        startTime: currentSegmentRef.current.startTime,
        endTime: elapsed,
        label: currentSegmentRef.current.label,
      };
      setSegments(prev => [...prev, newSegment]);
      currentSegmentRef.current = null;
    }
  }, []);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(null);
        return;
      }

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { 
          type: recorder.mimeType || 'video/webm' 
        });
        setIsRecording(false);
        resolve(blob);
      };

      recorder.stop();
    });
  }, []);

  return {
    startRecording,
    stopRecording,
    markSegment,
    endSegment,
    isRecording,
    segments,
  };
}
