'use strict';

// Draws Rift's own sign-in and welcome artwork (so nothing depends on third-party images):
// a spiral galaxy built from stars, split by a thin glowing rift.
// Needs Playwright (not a project dependency): NODE_PATH=$(npm root -g) node scripts/make-art.js
// Writes public/login-art.jpg and public/intro-sky.jpg (then convert to .webp if wanted).

const fs = require('node:fs');
const path = require('node:path');

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 0.58;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function galaxy({ cx, cy, rot, squash, size, stars }) {
  const warm = [255, 236, 214], blue = [150, 175, 255], violet = [196, 142, 255], pink = [255, 150, 210];
  let dots = '';
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i < stars; i++) {
      const t = Math.pow(rnd(), 0.8);
      const r = 14 + t * size;
      const a = arm * Math.PI + t * 5.4;
      const spread = 6 + t * 30;
      const x = r * Math.cos(a) + gauss() * spread, y = r * Math.sin(a) + gauss() * spread;
      const col = t < 0.35 ? mix(warm, blue, t / 0.35) : mix(blue, arm ? pink : violet, (t - 0.35) / 0.65);
      const rad = (0.7 + rnd() * rnd() * 2.6) * (1.2 - t * 0.45);
      const op = Math.max(0.12, 0.95 - t * 0.7) * (0.55 + rnd() * 0.45);
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(2)}" fill="rgb(${col})" opacity="${op.toFixed(2)}"/>`;
    }
  }
  const arm = (off, col) => {
    let d = '';
    for (let k = 0; k <= 70; k++) { const t = k / 70; const r = 14 + t * size; const a = off + t * 5.4; d += `${k ? 'L' : 'M'}${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)} `; }
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="${size * 0.16}" stroke-linecap="round" opacity=".3" filter="url(#g28)"/>`;
  };
  return `<g transform="translate(${cx} ${cy}) rotate(${rot}) scale(1 ${squash})">
    ${arm(0, '#6f7dff')}${arm(Math.PI, '#d070e8')}
    <circle r="${size * 0.3}" fill="url(#core)" opacity="1"/>${dots}</g>`;
}

// A smooth tapered tear of light between two points: thin at the ends, brightest in the middle.
function rift({ from, to, width, wobble }) {
  const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len;
  const s1 = rnd() * 6, s2 = rnd() * 6;
  const left = [], right = [];
  for (let k = 0; k <= 80; k++) {
    const t = k / 80;
    const off = wobble * (Math.sin(t * 5.1 + s1) * 0.55 + Math.sin(t * 11.7 + s2) * 0.25);
    const w = width * Math.pow(Math.sin(Math.PI * t), 0.8);
    const cx = from[0] + dx * t + nx * off, cy = from[1] + dy * t + ny * off;
    left.push([cx - nx * w, cy - ny * w]);
    right.push([cx + nx * w, cy + ny * w]);
  }
  const d = 'M' + [...left, ...right.reverse()].map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' L') + ' Z';
  return `<path d="${d}" fill="#7a5cff" opacity=".5" filter="url(#r28)"/>
  <path d="${d}" fill="#7a5cff" opacity=".5" filter="url(#r22)"/>
  <path d="${d}" fill="#38d8ff" opacity="1" filter="url(#r6)" transform="translate(0 0)"/>
  <path d="${d}" fill="#38d8ff" opacity=".8" filter="url(#r6)"/>
  <path d="${d}" fill="#fff"/>
  <path d="${d}" fill="none" stroke="#bfefff" stroke-width="1.2" opacity=".9"/>`;
}

function scene({ gal, riftSvg, vignette }) {
  let stars = '';
  for (let k = 0; k < 520; k++) {
    const r = 0.4 + rnd() * rnd() * 1.9;
    stars += `<circle cx="${(rnd() * 1920).toFixed(0)}" cy="${(rnd() * 1080).toFixed(0)}" r="${r.toFixed(1)}" fill="#fff" opacity="${(0.25 + rnd() * 0.65).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <radialGradient id="sky" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="#14185a"/><stop offset=".55" stop-color="#0a0c33"/><stop offset="1" stop-color="#03040f"/></radialGradient>
    <radialGradient id="core"><stop offset="0" stop-color="#fff6e8" stop-opacity="1"/><stop offset=".35" stop-color="#cfd6ff" stop-opacity=".55"/><stop offset="1" stop-color="#6f7dff" stop-opacity="0"/></radialGradient>
    <filter id="g28" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
    <filter id="g22" x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="g6" x="-50%" y="-20%" width="200%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="r28" filterUnits="userSpaceOnUse" x="-300" y="-300" width="2520" height="1680"><feGaussianBlur stdDeviation="28"/></filter>
    <filter id="r22" filterUnits="userSpaceOnUse" x="-300" y="-300" width="2520" height="1680"><feGaussianBlur stdDeviation="22"/></filter>
    <filter id="r6" filterUnits="userSpaceOnUse" x="-300" y="-300" width="2520" height="1680"><feGaussianBlur stdDeviation="6"/></filter>
    <radialGradient id="vig" cx="50%" cy="50%" r="75%"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${vignette}"/></radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#sky)"/>
  <ellipse cx="380" cy="230" rx="420" ry="190" fill="#3a2a9c" opacity=".28" filter="url(#g28)" transform="rotate(-20 380 230)"/>
  <ellipse cx="1560" cy="880" rx="440" ry="200" fill="#7a2f9a" opacity=".22" filter="url(#g28)" transform="rotate(-16 1560 880)"/>
  ${stars}${gal}${riftSvg}
  <rect width="1920" height="1080" fill="url(#vig)"/></svg>`;
}

(async () => {
  const { chromium } = require('playwright');
  const out = path.join(__dirname, '..', 'public');
  const b = await chromium.launch();
  const shot = async (file, svg) => {
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    await p.setContent(`<body style="margin:0;background:#03040f"><img style="display:block" width="1920" height="1080" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`);
    await p.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 82 });
    await p.close();
  };
  seed = 11;
  await shot('login-art.jpg', scene({
    gal: galaxy({ cx: 1280, cy: 520, rot: -24, squash: 0.66, size: 700, stars: 4200 }),
    riftSvg: rift({ from: [1700, -40], to: [1020, 1120], width: 11, wobble: 40 }), vignette: 0.55,
  }));
  seed = 23;
  await shot('intro-sky.jpg', scene({
    gal: galaxy({ cx: 960, cy: 540, rot: -20, squash: 0.64, size: 700, stars: 4200 }),
    riftSvg: '', vignette: 0.5, // no rift: the welcome animation draws it
  }));
  await b.close();
  console.log('Wrote login-art.jpg and intro-sky.jpg');
})();
