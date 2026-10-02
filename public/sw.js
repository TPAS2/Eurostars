'use strict';

// Makes Rift installable. It deliberately stores nothing: pages hold real people's details, so
// nothing is kept on the device. If the connection drops, a plain "offline" page is shown.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.clients.claim();
  })());
});

const OFFLINE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline · Rift</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef0f4;color:#111;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
main{max-width:360px}h1{margin:0 0 8px}p{margin:0 0 20px;color:#444}
button{font:inherit;font-weight:600;padding:12px 22px;border:0;border-radius:10px;background:#1f5eff;color:#fff}</style></head>
<body><main><h1>You're offline</h1><p>Rift needs an internet connection so your details stay safely on the server and nothing is kept on this device. Check your connection and try again.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, {
    status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })));
});
