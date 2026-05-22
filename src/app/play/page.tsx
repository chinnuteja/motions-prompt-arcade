"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { GameConfig, decodeGameConfig } from '../../lib/schema';
import { GameEngine } from '../../components/GameEngine/GameEngine';

function PlayGame() {
  const searchParams = useSearchParams();
  const configParam = searchParams.get('config');
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (configParam) {
      const decoded = decodeGameConfig(configParam);
      if (decoded) {
        setConfig(decoded);
      } else {
        setError("Invalid game configuration link.");
      }
    } else {
      setError("No game configuration provided.");
    }
  }, [configParam]);

  if (error) {
    return (
      <div style={{ color: 'white', padding: '2rem', textAlign: 'center', background: '#000', height: '100vh' }}>
        <h2>Error loading game</h2>
        <p>{error}</p>
        <a href="/" style={{ color: '#6366f1' }}>Go back home</a>
      </div>
    );
  }

  if (!config) {
    return <div style={{ color: 'white', background: '#000', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading Game Engine...</div>;
  }

  return <GameEngine config={config} />;
}

export default function PlayPage() {
  return (
    <Suspense fallback={<div style={{ color: 'white', background: '#000', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading Game Engine...</div>}>
      <PlayGame />
    </Suspense>
  );
}
