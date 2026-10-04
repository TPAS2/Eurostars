// The dashboard's animated GhostFibers background (React Bits). The same glowing fibers are drawn in
// both themes; in light mode the page's CSS turns them into blue ink on a light background
// (see .dashboard-bg in public/style.css), so they show clearly behind the cards.
import { createRoot } from 'react-dom/client';
import GhostFibers from './GhostFibers';

const bg = document.getElementById('dashboard-bg');
if (bg) {
  createRoot(bg).render(
    <GhostFibers
      lineColor="#140E35"
      glowColor="#1115ee"
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
