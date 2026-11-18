/* ============================================================
   Mnemos — Service Worker
   Cached der App-Shell (HTML/CSS/JS/Icons) für Offline-Start &
   ein natives "Add to Home Screen"-Gefühl. Alles andere (API-Calls,
   Meta/ScrapeCreators/Supabase, Netlify Functions) läuft immer live
   über das Netz — nichts davon wird gecacht.
   ============================================================ */
'use strict';

const VERSION = 'v2';
const SHELL_CACHE = `mnemos-shell-${VERSION}`;

// Relative zum SW-Scope — funktioniert unabhängig davon, ob die App
// auf der netlify.app-Domain oder unter einem Unterpfad (Proxy) läuft.
const SHELL_URLS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './supabase-config.js',
    './supabase-sync.js',
    './manifest.json',
    './favicon.png',
    './favicon-32.png',
    './favicon-16.png',
    './favicon.svg',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png',
    './apple-touch-icon.png'
];

// Diese Requests niemals abfangen/cachen — immer live vom Netz.
const NEVER_CACHE = [
    '/api/', 'graph.facebook.com', 'scrapecreators.com', 'supabase.co',
    'facebook.com/ads', 'fbcdn.net', 'cdninstagram.com'
];

function shouldBypass(url) {
    return NEVER_CACHE.some(fragment => url.includes(fragment));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // Einzeln statt addAll(): ein einzelner 404 (z. B. Icon fehlt lokal)
        // soll die Installation nicht komplett scheitern lassen.
        await Promise.all(SHELL_URLS.map(async (url) => {
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (res && res.ok) await cache.put(url, res);
            } catch (e) { /* offline beim Install — kein Problem, wird beim nächsten Fetch nachgeholt */ }
        }));
        self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('mnemos-shell-') && n !== SHELL_CACHE)
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (shouldBypass(req.url)) return; // API/Daten: nie aus dem Cache

    // Navigation (App-Start): Network-first, Offline-Fallback auf gecachtes Shell-HTML.
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(req);
                const cache = await caches.open(SHELL_CACHE);
                cache.put('./index.html', fresh.clone());
                return fresh;
            } catch (e) {
                const cache = await caches.open(SHELL_CACHE);
                return (await cache.match('./index.html')) || (await cache.match('./'))
                    || new Response('Offline — keine Verbindung.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
            }
        })());
        return;
    }

    // Statische Shell-Assets (CSS/JS/Icons, auch von der CDN-Domain via absoluter URL):
    // Stale-while-revalidate — sofort aus dem Cache, im Hintergrund aktualisieren.
    if (['style', 'script', 'image', 'font'].includes(req.destination) || SHELL_URLS.some(u => req.url.endsWith(u.replace('./', '/')))) {
        event.respondWith((async () => {
            const cache = await caches.open(SHELL_CACHE);
            const cached = await cache.match(req);
            const networkFetch = fetch(req).then((res) => {
                if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
                return res;
            }).catch(() => null);
            return cached || (await networkFetch) || new Response('', { status: 504 });
        })());
    }
});
