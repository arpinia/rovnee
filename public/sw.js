// Офлайн-кэш + ежедневные напоминания.
const CACHE = "rovnee-v3";
const FILES = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сначала сеть (чтобы обновления приходили сразу), при офлайне — кэш.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Запросы к серверу друзей не кэшируем
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("/")))
  );
});

// Напоминание приходит без текста — текст выбираем здесь.
const MESSAGES = [
  "Пара минут для себя: отметь квесты и дневник 🌿",
  "Ты сегодня ещё не заходил(а). Хотя бы один квест? ✨",
  "Маленький шаг сегодня — уже засчитанный день 💛",
  "Загляни в «Ровнее»: дневник и квесты ждут 🙂",
];
self.addEventListener("push", e => {
  const body = MESSAGES[new Date().getDate() % MESSAGES.length];
  e.waitUntil(self.registration.showNotification("Ровнее", {
    body, icon: "/icon-192.png", badge: "/icon-192.png", tag: "daily", renotify: true,
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) if ("focus" in c) return c.focus();
      return clients.openWindow("/");
    })
  );
});
