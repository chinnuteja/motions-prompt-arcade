"use client";

import React, { useEffect, useRef, useState } from 'react';
import styles from './UrlInputScreen.module.css';

interface UrlInputScreenProps {
  onSubmit: (url: string) => void;
}

export function UrlInputScreen({ onSubmit }: UrlInputScreenProps) {
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizeUrlInput = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('://')) {
      return `https${trimmed}`;
    }

    if (trimmed.startsWith('www.') || trimmed.startsWith('youtube.com') || trimmed.startsWith('youtu.be')) {
      return `https://${trimmed}`;
    }

    return trimmed;
  };

  useEffect(() => {
    const syncAutofillValue = () => {
      const domValue = inputRef.current?.value ?? '';
      if (domValue.trim().length > 0) {
        setUrl(domValue);
      }
    };

    const raf = requestAnimationFrame(syncAutofillValue);
    const timer = window.setTimeout(syncAutofillValue, 200);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const candidate = normalizeUrlInput(inputRef.current?.value ?? url);
    if (!candidate) {
      return;
    }

    setUrl(candidate);
    onSubmit(candidate);
  };

  return (
    <div className={styles.container}>
      <div className={styles.bgGlow} />
      
      <div className={styles.content}>
        <div className={styles.logoMark}>
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="url(#grad)" strokeWidth="3" />
            <circle cx="24" cy="16" r="4" fill="#6366f1" />
            <line x1="24" y1="20" x2="24" y2="32" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="24" x2="16" y2="20" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="24" x2="32" y2="20" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="32" x2="18" y2="38" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="24" y1="32" x2="30" y2="38" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" />
            <defs>
              <linearGradient id="grad" x1="0" y1="0" x2="48" y2="48">
                <stop stopColor="#6366f1" />
                <stop offset="1" stopColor="#f43f5e" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        <h1 className={styles.title}>Kinetics</h1>
        <p className={styles.tagline}>Turn any video into a camera-native game</p>
        <p className={styles.scope}>Best with narrated or instructional videos: education, fitness, dance, boxing tutorials.</p>

        <div className={styles.examples}>
          <span className={styles.exampleLabel}>Try:</span>
          <span className={styles.example}>Boxing tutorial → punch-speed challenge</span>
          <span className={styles.example}>Dance tutorial → movement challenge</span>
          <span className={styles.example}>Kids lesson → wave-along camera game</span>
        </div>

        <div className={styles.pipeline}>
          <span>Video</span>
          <span className={styles.arrow}>→</span>
          <span>Camera Game</span>
          <span className={styles.arrow}>→</span>
          <span>Share Clip</span>
        </div>

        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.inputWrapper}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Paste a YouTube URL to begin..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              className={styles.input}
            />
          </div>
          <button type="submit" className={styles.button}>
            Generate Experience ✨
          </button>
        </form>
      </div>
    </div>
  );
}
