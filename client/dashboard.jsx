// Everything the dashboard adds on top of the server-rendered page: the dark mode switch and
// the animated MicroSlats background (React Bits) behind the dashboard.
import { createRoot } from 'react-dom/client';
import './theme-switch.jsx';
import MicroSlats from './MicroSlats';

const bg = document.getElementById('dashboard-bg');
if (bg) {
  createRoot(bg).render(
    <MicroSlats
      preset="swell"
      color="#1f5eff"
      glintColor="#ffffff"
      backgroundColor="transparent"
      slatWidth={10}
      slatHeight={25}
      gap={3}
      roundness={0.75}
      interactive
      cursorStrength={1}
      cursorSize={40}
      swirl={0}
      trail={1.4}
      lean={0}
      intro
    />
  );
}
