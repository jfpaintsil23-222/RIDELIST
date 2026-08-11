self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = {};
  }

  const title = payload.title || "RIDELIST";
  const options = {
    body: payload.body || "Your pickup list was updated. Open your route review.",
    icon: "assets/app-icon-192.png",
    badge: "assets/app-icon-192.png",
    tag: payload.tag || "ridelist-route-update",
    data: {
      url: payload.url || "./",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./", self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === new URL(targetUrl).origin);
    if (existing) {
      await existing.focus();
      if ("navigate" in existing) return existing.navigate(targetUrl);
      return existing;
    }
    return clients.openWindow(targetUrl);
  })());
});
