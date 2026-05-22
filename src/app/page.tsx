"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GameConfig, encodeGameConfig } from '../lib/schema';
import styles from './page.module.css';

const FEATURED_GAMES: GameConfig[] = [
  {
    title: "Shadowbox Lite",
    mechanic: "survival-dodge",
    primitive: "lateral-dodge",
    duration: 30,
    instructions: "Dodge left and right to survive for 30s!"
  },
  {
    title: "Squat Blitz",
    mechanic: "count-reps",
    primitive: "squat",
    duration: 20,
    instructions: "Do as many squats as you can in 20 seconds!"
  },
  {
    title: "Jump Test",
    mechanic: "count-reps",
    primitive: "jump",
    duration: 15,
    instructions: "Jump as many times as possible!"
  }
];

const PROMPT_SUGGESTIONS = [
  "A hardcore boxing game where zombie heads fall from the sky and I have to punch them to survive! (Use 🧟 emoji, red theme)",
  "A space arcade game where I have to dodge raining asteroids for 30 seconds! (Use ☄️ emoji, purple theme)",
  "A gym workout where I do as many squats as possible in 60 seconds while holding a boulder. (Use 🪨 emoji, orange theme)",
  "A yoga balance test where I hold a strict pose for 30 seconds to center my chakra. (Use 🪷 emoji, blue theme)",
  "A ninja training game where I have to punch incoming shurikens! (Use 🥷 emoji, dark grey theme)",
  "A pizza chef game where I have to catch falling pizzas with my body! (Use 🍕 emoji, yellow theme)"
];

export default function Home() {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const router = useRouter();

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      
      const data = await res.json();
      if (data.config) {
        const encoded = encodeGameConfig(data.config);
        router.push(`/play?config=${encoded}`);
      } else {
        alert("Failed to generate game.");
      }
    } catch (e) {
      console.error(e);
      alert("Error generating game.");
    } finally {
      setIsGenerating(false);
    }
  };

  const playFeatured = (config: GameConfig) => {
    const encoded = encodeGameConfig(config);
    router.push(`/play?config=${encoded}`);
  };

  return (
    <main className={styles.main}>
      <div className={styles.hero}>
        <h1 className={styles.title}>MOTIONS<span className={styles.accent}>.build</span> (Prototype)</h1>
        <p className={styles.subtitle}>Build any camera game in seconds.</p>
        
        <div className={styles.creatorInput}>
          <textarea 
            className={styles.textarea}
            placeholder="Describe a camera game... (e.g. 'A 20-second squat counting challenge')"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={isGenerating}
          />
          <button 
            className={styles.generateButton}
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
          >
            {isGenerating ? 'Compiling Engine...' : 'Generate Game'}
          </button>
        </div>

        <div className={styles.suggestionsContainer}>
          <p className={styles.suggestionsTitle}>Or try one of these prompts:</p>
          <div className={styles.suggestionsList}>
            {PROMPT_SUGGESTIONS.map((sug, i) => (
              <button key={i} className={styles.suggestionChip} onClick={() => setPrompt(sug)}>
                {sug}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.gallery}>
        <h2 className={styles.galleryTitle}>Featured Games</h2>
        <div className={styles.cardGrid}>
          {FEATURED_GAMES.map((game, i) => (
            <div key={i} className={styles.card} onClick={() => playFeatured(game)}>
              <div className={styles.cardPrimitive}>{game.primitive}</div>
              <h3 className={styles.cardTitle}>{game.title}</h3>
              <p className={styles.cardDesc}>{game.instructions}</p>
              <div className={styles.playTag}>▶ Play Now</div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
