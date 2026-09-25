// Service worker: cachea la app para que funcione sin conexión.
// Red primero (siempre la versión más nueva si hay internet), caché si no.
const CACHE = "cuadra-shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css?v=12",
  "./js/app.js?v=12",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-64.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== AI_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// La IA (librerías de jsDelivr, modelo de MediaPipe y el de matrículas) pesa y no cambia:
// se sirve de la caché si ya está, y si no se descarga y se guarda. Así funciona sin internet.
const AI_CACHE = "cuadra-ai-v1";
const isAI = (url) => url.startsWith("https://cdn.jsdelivr.net/npm/") ||
  url.startsWith("https://storage.googleapis.com/mediapipe-models/") || url.includes("/models/");

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (isAI(event.request.url)) {
    event.respondWith(
      caches.open(AI_CACHE).then((cache) => cache.match(event.request).then((hit) => hit || fetch(event.request).then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      })))
    );
    return;
  }
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
