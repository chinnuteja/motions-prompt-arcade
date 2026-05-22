"use client";

import React, { useEffect, useState } from 'react';
import styles from './GeneratingScreen.module.css';

const STAGES = [
  "Analyzing video frames...",
  "Transcribing audio...",
  "Finding interaction points...",
  "Synthesizing challenge logic..."
];

export function GeneratingScreen() {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    // Just cycle through the text while we wait for the real API
    const timer1 = setTimeout(() => setStageIndex(1), 2000);
    const timer2 = setTimeout(() => setStageIndex(2), 4000);
    const timer3 = setTimeout(() => setStageIndex(3), 6000);

    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.spinner}>
        <div className={styles.circle} />
        <div className={styles.circleInner} />
      </div>
      <h2 className={styles.title}>AI Agent Working</h2>
      <p className={styles.statusText} key={stageIndex}>{STAGES[stageIndex]}</p>
    </div>
  );
}
