// Herdr Web service worker: makes the app installable and keeps the shell (HTML, JS, CSS,
// fonts, icons) for a flaky connection. Never touches /api or /ws: data and auth always go to
// the network, so nothing private is cached.
const CACHE = "herdr-web-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  // hashed build assets never change: cache first
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      })),
    );
    return;
  }

  // the page and the rest: network first, the cached copy when offline
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request.mode === "navigate" ? "/" : request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request.mode === "navigate" ? "/" : request).then((hit) => hit ?? Response.error())),
  );
});

// push notifications: the server sends { title, body, url, tag, kind }, encrypted end to end
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* not JSON: the generic text below */
  }
  const title = data.title || "Herdr";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      // one notification per session: a newer notice replaces the older one, and still alerts
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

// a tap opens the session: in the app's window when one is open, otherwise in a new one
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // the app routes by hash: it switches session itself, without reloading
      open.postMessage({ type: "open", url });
      return open.focus();
    }),
  );
});
