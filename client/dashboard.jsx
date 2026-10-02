// Everything the dashboard adds on top of the server-rendered page: the dark mode switch and
// the animated GhostFibers background (React Bits) behind the dashboard. The background follows
// the light/dark switch: glowing fibers on dark, soft ink-on-light fibers on light.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './theme-switch.jsx';
import GhostFibers from './GhostFibers';

const root = document.documentElement;
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : systemDark());

function Background() {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const update = () => setDark(isDark());
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', update);
    return () => { observer.disconnect(); query.removeEventListener('change', update); };
  }, []);
  return (
    <GhostFibers
      lineColor={dark ? '#140E35' : '#1115ee'}
      glowColor="#1115ee"
      lightMode={!dark}
      speed={0.2}
      scale={2}
      rotation={0}
      rotationSpeed={0.25}
      layers={4}
      waveAmplitude={0.015}
      waveFrequency={3}
      waveSpeed={0.15}
      layerSpeed={0.08}
      twist={0.1}
      twistFrequency={5}
      twistSpeed={1.2}
      lineFrequency={5}
      lineSpacing={2}
      lineSharpness={16}
      glowFalloff={10}
      glowIntensity={1.6}
      brightness={1}
      blueBoost={1.25}
      vignette={0.8}
      grain={0.05}
      dpr={1}
      fps={30}
    />
  );
}

const bg = document.getElementById('dashboard-bg');
if (bg) createRoot(bg).render(<Background />);
