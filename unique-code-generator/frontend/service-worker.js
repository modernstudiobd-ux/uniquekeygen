"use strict";

// Bump this on every deploy that changes any cached file — it's what
// forces old clients to pick up the new shell.
const CACHE_VERSION = "v1";
const CACHE_NAME = `unique-code-generator-${CACHE_VERSION}`;

// The app shell: everything needed to open the app, view the UI, edit
// settings, and browse local history while offline. Deliberately does
// NOT include anything from the Worker API — global code generation is
// never allowed to work offline (see app.js's navigator.onLine gate).
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-192.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Anything under /api/ — whether same-origin or the Cloudflare Worker's
  // own origin — must always hit the network. Never intercept, never
  // cache, never serve a stale or offline-fabricated response for this:
  // that would silently violate the global-uniqueness guarantee.
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch non-GET (e.g. POST /api/generate)

  const url = new URL(request.url);

  if (isApiRequest(url)) {
    // Network only. Let it fail naturally offline — app.js already
    // blocks generation attempts before this point via navigator.onLine,
    // and shows the required offline message.
    event.respondWith(fetch(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    // Third-party assets (e.g. web fonts): try network, fall back to
    // cache if previously fetched, otherwise just fail quietly.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Same-origin app shell: cache-first for instant offline loads, with
  // a network refresh in the background so updates still propagate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
