// The dashboard's dark mode switch. The chosen theme is saved to the signed-in person's
// account, so every page (rendered with data-theme on <html>) follows it on any device.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SquishSwitch from './SquishSwitch';

const root = document.documentElement;
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : systemDark());

function ThemeSwitch({ csrf }) {
  const [dark, setDark] = useState(isDark);
  const change = (next) => {
    setDark(next);
    root.dataset.theme = next ? 'dark' : 'light';
    const body = new URLSearchParams({ _csrf: csrf, theme: next ? 'dark' : 'light' });
    fetch('/app/theme', { method: 'POST', body, credentials: 'same-origin', headers: { 'X-Autosave': '1' } }).catch(() => {});
  };
  return (
    <SquishSwitch
      checked={dark}
      onChange={change}
      label="Dark mode"
      trackColor="#c3c9d2"
      trackOnColor="#1f5eff"
      thumbColor="#ffffff"
      thumbOnColor="#ffffff"
      width={56}
      height={30}
      radius={15}
      speed={50}
      stretch={36}
      hoverScale={1.035}
      colorDuration={320}
    />
  );
}

const mount = document.getElementById('theme-switch');
if (mount) createRoot(mount).render(<ThemeSwitch csrf={mount.dataset.csrf || ''} />);
