'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { encodeEffectConfig } from '../../lib/vfx-schema';
import styles from './page.module.css';

export default function VfxLandingPage() {
  const [prompt, setPrompt] = useState('');
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const typingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (typingIntervalRef.current) {
        clearInterval(typingIntervalRef.current);
      }
    };
  }, []);

  const handleSelectEngine = (id: string, presetPrompt: string) => {
    setSelectedEngine(id);
    
    if (typingIntervalRef.current) {
      clearInterval(typingIntervalRef.current);
    }
    
    let index = 0;
    setPrompt('');
    
    const interval = setInterval(() => {
      index++;
      if (index <= presetPrompt.length) {
        setPrompt(presetPrompt.slice(0, index));
      } else {
        clearInterval(interval);
      }
    }, 12);
    
    typingIntervalRef.current = interval;
  };

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

  const ENGINES = [
    {
      id: "fire_magic",
      title: "Fire Magic",
      description: "Fluid plasma physics with hand-contour mapping, twist shear, and explosive eruptions.",
      prompt: "Give me blue ghost fire I can charge in my fist and blast like a flamethrower",
      gradient: "linear-gradient(135deg, #ff4e00, #ec9f05)"
    },
    {
      id: "particle_nebula",
      title: "Particle Nebula",
      description: "Cosmic swarms using symplectic Euler springs. Form black holes, constellations, and galaxies.",
      prompt: "I want an ocean blue galaxy of stars that swarm around my hands and explode when I open them",
      gradient: "linear-gradient(135deg, #00f0ff, #7000ff)"
    },
    {
      id: "glitch_tiles",
      title: "Glitch Tiles",
      description: "Glass physics that shatters reality into geometry. Magnetically snap into 3D orbs and cinematic portals.",
      prompt: "Shatter reality into high contrast black and white mirror shards that I can grab",
      gradient: "linear-gradient(135deg, #ffffff, #555555)"
    },
    {
      id: "light_ribbons",
      title: "Light Ribbons",
      description: "Draw volumetric 3D ribbons of neon light. Close the loop to spawn mathematical holographic Rune Rings.",
      prompt: "Let me draw with hot pink and cyan neon lightning",
      gradient: "linear-gradient(135deg, #ff00ea, #00f0ff)"
    }
  ];

  return (
    <main className={styles.container}>
      <div className={styles.backgroundGlow} />
      
      <div className={styles.content}>
        <div className={styles.layoutGrid}>
          
          {/* Left Column: Compiler Console */}
          <div className={styles.consoleColumn}>
            <div className={styles.header}>
              <h1 className={styles.title}>
                Hand<span className={styles.titleAccent}>VFX</span>
              </h1>
              <p className={styles.subtitle}>
                Compile your custom generative physics engine via prompt, or select one of the presets to load it.
              </p>
            </div>

            <form onSubmit={handleGenerate} className={styles.form}>
              <div className={styles.consoleTitleRow}>
                <div className={styles.consolePulse} />
                <span className={styles.consoleTitle}>PROMPT COMPILER CONSOLE</span>
              </div>
              
              <div className={styles.inputWrapper}>
                <textarea
                  value={prompt}
                  onChange={(e) => {
                    if (typingIntervalRef.current) {
                      clearInterval(typingIntervalRef.current);
                    }
                    const val = e.target.value;
                    setPrompt(val);
                    const matched = ENGINES.find(eng => eng.prompt === val);
                    setSelectedEngine(matched ? matched.id : null);
                  }}
                  placeholder="e.g. Draw neon lightning with my fingers..."
                  disabled={isGenerating}
                  className={styles.input}
                  rows={4}
                  autoFocus
                />
              </div>
              
              <button 
                type="submit" 
                disabled={!prompt.trim() || isGenerating}
                className={styles.button}
              >
                {isGenerating ? (
                  <>
                    <span className={styles.spinner}>↻</span>
                    <span>Compiling Engine...</span>
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.btnIcon}>
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>Initialize System</span>
                  </>
                )}
              </button>

              {error && <div className={styles.error}>{error}</div>}
            </form>
          </div>

          {/* Right Column: Presets Dashboard */}
          <div className={styles.presetsColumn}>
            <div className={styles.presetsHeader}>
              <span className={styles.presetsSub}>PRE-CONFIGURED VIRTUAL ENGINES</span>
              <h2 className={styles.presetsTitle}>System Presets</h2>
            </div>

            <div className={styles.cardsGrid}>
              {ENGINES.map((engine) => {
                const isSelected = selectedEngine === engine.id;
                const glowColor = 
                  engine.id === 'fire_magic' ? '#ff6a00' :
                  engine.id === 'particle_nebula' ? '#00f0ff' :
                  engine.id === 'glitch_tiles' ? '#a0a0a0' :
                  '#ff00ea';
                return (
                  <button 
                    key={engine.id}
                    type="button"
                    className={`${styles.engineCard} ${isSelected ? styles.selectedCard : ''}`}
                    style={{ 
                      '--glow-color': glowColor,
                      '--gradient-glow': engine.gradient
                    } as React.CSSProperties}
                    onClick={() => handleSelectEngine(engine.id, engine.prompt)}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.iconContainer}>
                        {engine.id === 'fire_magic' && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.cardIcon}>
                            <path d="M12 2c0 0-4 4.5-4 8.5C8 13.5 10 16 12 16s4-2.5 4-5.5C16 6.5 12 2 12 2z" />
                            <path d="M12 10c0 0-2 2-2 4s2 3 2 3 2-1 2-3-2-4-2-4z" opacity="0.7" />
                          </svg>
                        )}
                        {engine.id === 'particle_nebula' && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.cardIcon}>
                            <ellipse cx="12" cy="12" rx="3" ry="9" transform="rotate(45 12 12)" />
                            <ellipse cx="12" cy="12" rx="3" ry="9" transform="rotate(-45 12 12)" />
                            <circle cx="12" cy="12" r="2" fill="currentColor" />
                          </svg>
                        )}
                        {engine.id === 'glitch_tiles' && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.cardIcon}>
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                            <line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                        )}
                        {engine.id === 'light_ribbons' && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.cardIcon}>
                            <path d="M4 12c0-4.4 3.6-8 8-8s8 3.6 8 8-3.6 8-8 8-8-3.6-8-8z" />
                            <path d="M12 2a10 10 0 0 1 10 10M12 22A10 10 0 0 1 2 12" opacity="0.5" />
                            <path d="M12 8a4 4 0 0 1 4 4M12 16a4 4 0 0 1-4-4" />
                          </svg>
                        )}
                      </div>
                      <span className={`${styles.engineTag} ${isSelected ? styles.activeTag : ''}`}>
                        {isSelected ? 'LOADED' : 'LOAD PRESET'}
                      </span>
                    </div>
                    <h3 className={styles.cardTitle}>{engine.title}</h3>
                    <p className={styles.cardDescription}>{engine.description}</p>
                    <div className={styles.cardGlowEffect} />
                  </button>
                );
              })}
            </div>
          </div>

        </div>
      </div>
    </main>
  );
}
