'use client';

import React, { useEffect, useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { EffectConfig, decodeEffectConfig } from '../../../lib/vfx-schema';
import { EffectEngine } from '../../../components/EffectEngine/EffectEngine';
import { AuraBlasterEffect } from '../../../lib/effects/auraBlaster';
import { ParticleNebulaEffect } from '../../../lib/effects/particleNebula';
import { GlitchTilesEffect } from '../../../lib/effects/glitchTiles';
import { FireMagicEffect } from '../../../lib/effects/fireMagic';
import { PlaceholderEffect } from '../../../lib/effects/placeholder';

function VfxPlayer() {
  const searchParams = useSearchParams();
  const configParam = searchParams.get('config');
  const [config, setConfig] = useState<EffectConfig | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (configParam) {
      const decoded = decodeEffectConfig(configParam);
      if (decoded) {
        setConfig(decoded);
      } else {
        setError("Invalid effect configuration link.");
      }
    } else {
      setError("No effect configuration provided.");
    }
  }, [configParam]);

  // Instantiate the correct effect based on config
  // The useMemo ensures we only create the instance once
  const effect = useMemo(() => {
    if (!config) return null;
    
    switch (config.effect) {
      case 'aura_blaster':
        return new AuraBlasterEffect();
      case 'particle_nebula':
        return new ParticleNebulaEffect(); 
      case 'glitch_tiles':
        return new GlitchTilesEffect();
      case 'fire_magic':
        return new FireMagicEffect();
      default:
        return new PlaceholderEffect();
    }
  }, [config]);

  if (error) {
    return (
      <div style={{ color: 'white', padding: '2rem', textAlign: 'center', background: '#000', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
        <h2>Error loading effect</h2>
        <p style={{ color: '#aaa' }}>{error}</p>
        <a href="/vfx" style={{ color: '#00f0ff', padding: '0.5rem 1rem', border: '1px solid #00f0ff', borderRadius: '4px', textDecoration: 'none' }}>Go back</a>
      </div>
    );
  }

  if (!config || !effect) {
    return <div style={{ color: 'white', background: '#000', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading Effect Engine...</div>;
  }

  return <EffectEngine config={config} effect={effect} />;
}

export default function VfxPlayPage() {
  return (
    <Suspense fallback={<div style={{ color: 'white', background: '#000', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Loading...</div>}>
      <VfxPlayer />
    </Suspense>
  );
}
