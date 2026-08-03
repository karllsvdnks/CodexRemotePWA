const CACHE = "remote-codex-shell-v10";
const SHELL = ["/", "/index.html", "/styles.css?v=10", "/app.js?v=10", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request)
    .then((response) => {
      if (response.ok && event.request.method === "GET") caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    })
    .catch(() => caches.match(event.request)));
});
