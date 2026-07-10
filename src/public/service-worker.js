// Bump this version when urlsToCache entries are added or removed.
// Content changes to existing files are handled by the network-first fetch strategy.
const CACHE_NAME = 'ai-or-die-v13';
const urlsToCache = [
  '/',
  '/index.html',
  '/fonts.css',
  // Only pre-cache the default font (MesloLGS). Other Nerd Font families
  // are cached on-demand via the network-first fetch handler when selected.
  '/fonts/MesloLGSNerdFont-Regular.woff2',
  '/fonts/MesloLGSNerdFont-Bold.woff2',
  '/fonts/MesloLGSNerdFont-Italic.woff2',
  '/fonts/MesloLGSNerdFont-BoldItalic.woff2',
  '/tokens.css',
  '/base.css',
  '/components/tabs.css',
  '/components/terminal.css',
  '/components/buttons.css',
  '/components/modals.css',
  '/components/controls.css',
  '/components/cards.css',
  '/components/menus.css',
  '/components/notifications.css',
  '/components/bottom-nav.css',
  '/mobile.css',
  '/style.css',
  '/app.js',
  '/app-identity.js',
  '/command-palette.js',
  '/clipboard-handler.js',
  '/session-manager.js',
  '/plan-detector.js',
  '/splits.js',
  '/icons.js',
  '/components/extra-keys.css',
  '/components/file-browser.css',
  '/components/banner-base.css',
  '/components/vscode-tunnel.css',
  '/components/feedback.css',
  '/components/voice-input.css',
  '/components/input-overlay.css',
  '/extra-keys.js',
  '/key-encoder.js',
  '/keys-panel.js',
  '/terminal-copy.js',
  '/components/keys-panel.css',
  '/file-browser.js',
  '/file-editor.js',
  '/voice-handler.js',
  '/image-handler.js',
  '/input-overlay.js',
  '/feedback-manager.js',
  '/terminal-wheel.js'
  // xterm.js is self-hosted under /vendor/xterm/ (served locally, fast) but is
  // intentionally NOT precached on install: ~900KB of addons would bloat the
  // install step (it churns on every fresh page load, and is pathologically slow
  // under the WebKit-on-Windows CI runner). The runtime fetch handler caches it
  // on first load, so offline still works after the first online visit.
];

// Install event - cache resources
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        console.log('Opened cache');
        // Use individual cache.add() calls so one failure doesn't block the rest
        const results = await Promise.allSettled(
          urlsToCache.map(url => cache.add(url))
        );
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          console.warn(`Failed to cache ${failed.length} of ${urlsToCache.length} resources`);
        }
      })
      .catch(err => {
        console.error('Failed to open cache:', err);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Take control of all pages immediately
  self.clients.claim();
});

// Fetch event - serve from cache when offline, network first for API calls
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // For API calls and WebSocket connections, always use network. The PWA
  // manifest is also network-only: it is built per-machine on the server and
  // must never be served stale from cache.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws') ||
      url.pathname === '/auth-status' ||
      url.pathname === '/manifest.json' ||
      request.url.includes('socket.io')) {
    event.respondWith(
      fetch(request)
        .catch(() => {
          // Return a offline response for API calls
          return new Response(
            JSON.stringify({ error: 'Offline - please check your connection' }), 
            {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        })
    );
    return;
  }

  // Cache-first for versioned CDN assets (immutable, pinned to specific versions)
  const knownCDNs = ['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
  if (knownCDNs.some(cdn => url.hostname.includes(cdn))) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // For static assets, try network first, fall back to cache
  event.respondWith(
    fetch(request)
      .then(response => {
        // If we got a valid response, update the cache
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(request, responseToCache);
            });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try to get from cache
        return caches.match(request)
          .then(response => {
            if (response) {
              return response;
            }
            // If not in cache and offline, return offline page for navigation requests
            if (request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            // Return 404 for other requests
            return new Response('Resource not available offline', { status: 404 });
          });
      })
  );
});

// Handle messages from the client
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Handle notification clicks (for Windows Notification Center / Action Center)
self.addEventListener('notificationclick', event => {
  const data = event.notification.data || {};
  const sessionId = data.sessionId;
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Try to focus an existing window
        for (const client of clientList) {
          if ('focus' in client) {
            client.focus();
            client.postMessage({
              type: 'NOTIFICATION_CLICK',
              sessionId,
            });
            return;
          }
        }
        // No existing window — open a new one
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
  );
});