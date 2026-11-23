// Ровнее — маленький сервер для обмена прогрессом по коду.
// Всё остальное (страница, иконка и т.д.) отдаётся как статические файлы из public/.
//
// API:
//   POST /api/register              → { code, token }   новый код для устройства
//   PUT  /api/profile/:code         → сохранить свой прогресс (нужен токен)
//   GET  /api/profile/:code         → посмотреть прогресс по коду
//   POST /api/cheer/:code           → подбодрить друга

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_BODY = 12_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function randomString(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cleanCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const clip = (s, n) => String(s ?? "").slice(0, n);

// Оставляем только то, что разрешено показывать друзьям.
function sanitizePublic(p) {
  const days = {};
  if (p && typeof p.days === "object") {
    for (const [k, v] of Object.entries(p.days).slice(-21)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v)) {
        days[k] = [Math.max(0, Math.min(99, +v[0] || 0)), Math.max(0, Math.min(99, +v[1] || 0))];
      }
    }
  }
  return {
    name: clip(p?.name, 30) || "Без имени",
    program: ["jaw", "back"].includes(p?.program) ? p.program : "jaw",
    level: Math.max(1, Math.min(999, +p?.level || 1)),
    xp: Math.max(0, Math.min(1e7, +p?.xp || 0)),
    activeDays: Math.max(0, Math.min(1e5, +p?.activeDays || 0)),
    badges: Array.isArray(p?.badges) ? p.badges.slice(0, 40).map((b) => clip(b, 20)) : [],
    chaptersDone: Math.max(0, Math.min(50, +p?.chaptersDone || 0)),
    chaptersTotal: Math.max(0, Math.min(50, +p?.chaptersTotal || 0)),
    days,
  };
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("too_large");
  return text ? JSON.parse(text) : {};
}

async function handleApi(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const route = parts[1];
  const code = cleanCode(parts[2]);

  if (route === "register" && request.method === "POST") {
    for (let i = 0; i < 5; i++) {
      const newCode = randomString(CODE_ALPHABET, 6);
      if (await env.DB.get("p:" + newCode)) continue;
      const token = randomString("abcdefghijklmnopqrstuvwxyz0123456789", 32);
      await env.DB.put("p:" + newCode, JSON.stringify({ tokenHash: await sha256(token), pub: null, updatedAt: Date.now() }));
      return json({ code: newCode, token });
    }
    return json({ error: "try_again" }, 503);
  }

  if (route === "profile" && code) {
    const raw = await env.DB.get("p:" + code);
    if (!raw) return json({ error: "not_found" }, 404);
    const rec = JSON.parse(raw);

    if (request.method === "GET") {
      if (!rec.pub) return json({ error: "empty" }, 404);
      const cheers = JSON.parse((await env.DB.get("c:" + code)) || '{"count":0,"recent":[]}');
      return json({ ...rec.pub, updatedAt: rec.updatedAt, cheers });
    }

    if (request.method === "PUT") {
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token || (await sha256(token)) !== rec.tokenHash) return json({ error: "forbidden" }, 403);
      let body;
      try { body = await readBody(request); } catch { return json({ error: "bad_request" }, 400); }
      rec.pub = sanitizePublic(body);
      rec.updatedAt = Date.now();
      await env.DB.put("p:" + code, JSON.stringify(rec));
      return json({ ok: true });
    }
  }

  if (route === "cheer" && code && request.method === "POST") {
    if (!(await env.DB.get("p:" + code))) return json({ error: "not_found" }, 404);
    let body = {};
    try { body = await readBody(request); } catch {}
    const key = "c:" + code;
    const c = JSON.parse((await env.DB.get(key)) || '{"count":0,"recent":[]}');
    c.count += 1;
    c.recent = [{ from: clip(body.from, 30) || "Друг", at: Date.now() }, ...c.recent].slice(0, 10);
    await env.DB.put(key, JSON.stringify(c));
    return json({ ok: true, count: c.count });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: "server_error" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
