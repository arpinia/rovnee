// Офлайн-кэш + ежедневные напоминания.
const CACHE = "rovnee-v4";
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

// Напоминание приходит без текста — текст спрашиваем у сервера (он знает, первое это или второе).
const FALLBACK = "Загляни в «Ровнее»: квесты ждут 🙂";
async function hashHex(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function getMessage(){
  try{
    const sub = await self.registration.pushManager.getSubscription();
    if(!sub) return {title:"Ровнее", body:FALLBACK};
    const r = await fetch("/api/push-msg?e=" + await hashHex(sub.endpoint), {cache:"no-store"});
    if(!r.ok) throw 0;
    return await r.json();
  }catch(e){ return {title:"Ровнее", body:FALLBACK}; }
}
self.addEventListener("push", e => {
  e.waitUntil(getMessage().then(m => self.registration.showNotification(m.title || "Ровнее", {
    body: m.body || FALLBACK, icon: "/icon-192.png", badge: "/icon-192.png", tag: "daily", renotify: true,
  })));
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
