'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { encodeEffectConfig } from '../../lib/vfx-schema';
import styles from './page.module.css';

export default function VfxLandingPage() {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isGenerating) return;

    setIsGenerating(true);
    setError(null);

    try {
      const res = await fetch('/api/generate-vfx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      if (!res.ok) {
        throw new Error('Failed to generate effect. Please try again.');
      }

      const data = await res.json();
      
      if (data.config) {
        const encoded = encodeEffectConfig(data.config);
        router.push(`/vfx/play?config=${encoded}`);
      } else {
        throw new Error('Invalid response from AI.');
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
      setIsGenerating(false);
    }
  };

  const SUGGESTIONS = [
    "Shatter my camera into glitching glass shards that I can grab and throw",
    "Make a neon galaxy orbit my fist and explode when I open my hand",
    "Draw acid smoke trails in the air with my fingertips",
    "A chaotic vortex that tears the screen apart when I pinch"
  ];

  return (
    <main className={styles.container}>
      <div className={styles.backgroundGlow} />
      
      <div className={styles.content}>
        <h1 className={styles.title}>
          Hand<span className={styles.titleAccent}>VFX</span>
        </h1>
        
        <p className={styles.subtitle}>
          Type a prompt. The AI compiles it into a high-performance, real-time physics engine driven by your hands.
        </p>

        <form onSubmit={handleGenerate} className={styles.form}>
          <div className={styles.inputWrapper}>
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Draw neon lightning with my fingers..."
              disabled={isGenerating}
              className={styles.input}
              autoFocus
            />
          </div>
          
          <button 
            type="submit" 
            disabled={!prompt.trim() || isGenerating}
            className={styles.button}
          >
            {isGenerating ? (
              <><span className={styles.spinner}>↻</span> Compiling Engine...</>
            ) : 'Generate Effect'}
          </button>

          {error && <div className={styles.error}>{error}</div>}
        </form>

        <div className={styles.suggestions}>
          <span className={styles.suggestionsLabel}>Try these specific effects</span>
          <div className={styles.chips}>
            {SUGGESTIONS.map(ex => (
              <button
                key={ex}
                onClick={() => setPrompt(ex)}
                className={styles.chip}
                type="button"
              >
                "{ex}"
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
