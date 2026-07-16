const SW_VERSION = "v5";

self.addEventListener("install", (event) => {
  console.log("NEW SW INSTALLED:", SW_VERSION);

  self.skipWaiting();

  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
});

self.addEventListener("activate", (event) => {
  console.log("NEW SW ACTIVATED:", SW_VERSION);

  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys.map((key) => caches.delete(key))
      );

      await self.clients.claim();

      const clients = await self.clients.matchAll({
        type: "window"
      });

      clients.forEach((client) => {
        client.navigate(client.url);
      });
    })()
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
  );
});