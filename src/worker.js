// Ровнее — маленький сервер для обмена прогрессом по коду.
// Всё остальное (страница, иконка и т.д.) отдаётся как статические файлы из public/.
//
// API:
//   POST /api/register              → { code, token }   новый код для устройства
//   PUT  /api/profile/:code         → сохранить свой прогресс (нужен токен)
//   GET  /api/profile/:code         → посмотреть прогресс по коду
//   POST /api/cheer/:code           → подбодрить друга
//   PUT  /api/push/:code            → включить ежедневное напоминание (нужен токен)
//   DELETE /api/push/:code          → выключить напоминание
//   POST /api/push/:code/test       → прислать пробное напоминание сейчас
//
// Раз в час (cron) воркер присылает напоминание тем, у кого сейчас выбранный час
// и кто сегодня ещё ничего не отметил.

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

// ---------- Web Push (без содержимого: текст показывает sw.js) ----------
const VAPID_PUBLIC = "BPVdLvnBBBopp_dxljU3vwpxo2EutkvYbpueBuB304iyJ2D7wkH5LCcod_upZtH05RI_iwVTHrIdKUWXzsnbihA";
const VAPID_SUBJECT = "https://rovnee.arpi-apps.workers.dev";
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (str) => b64url(new TextEncoder().encode(str));
let vapidKey;
async function vapidJWT(env, endpoint) {
  vapidKey ||= await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64urlStr(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64urlStr(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapidKey, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64url(sig);
}
async function sendPush(env, endpoint) {
  const jwt = await vapidJWT(env, endpoint);
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { TTL: "43200", Urgency: "normal", Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC}`, "Content-Length": "0" },
  });
  return r.status;
}
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour };
}
async function authed(request, env, code) {
  const raw = await env.DB.get("p:" + code);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return token && (await sha256(token)) === rec.tokenHash ? rec : null;
}
async function dailyReminders(env) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "s:", cursor });
    for (const k of page.keys) {
      const sub = JSON.parse((await env.DB.get(k.name)) || "null");
      if (!sub) continue;
      let now;
      try { now = localNow(sub.tz || "Europe/Moscow"); } catch { now = localNow("Europe/Moscow"); }
      if (now.hour !== sub.hour || sub.lastSent === now.date) continue;
      sub.lastSent = now.date;
      const prof = JSON.parse((await env.DB.get("p:" + k.name.slice(2))) || "null");
      const today = prof?.pub?.days?.[now.date];
      if (!(today && today[0] > 0)) {
        const status = await sendPush(env, sub.endpoint).catch(() => 0);
        if (status === 404 || status === 410) { await env.DB.delete(k.name); continue; }
      }
      await env.DB.put(k.name, JSON.stringify(sub));
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
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

  if (route === "push" && code) {
    const rec = await authed(request, env, code);
    if (!rec) return json({ error: "forbidden" }, 403);
    if (request.method === "PUT") {
      let b; try { b = await readBody(request); } catch { return json({ error: "bad_request" }, 400); }
      const endpoint = String(b?.endpoint || "");
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return json({ error: "bad_request" }, 400);
      const hour = Number.isFinite(+b.hour) && b.hour !== "" && b.hour !== null ? Math.max(0, Math.min(23, Math.floor(+b.hour))) : 21;
      let tz = clip(b.tz, 60) || "Europe/Moscow";
      try { localNow(tz); } catch { tz = "Europe/Moscow"; }
      const prev = JSON.parse((await env.DB.get("s:" + code)) || "{}");
      await env.DB.put("s:" + code, JSON.stringify({ endpoint, hour, tz, lastSent: prev.endpoint === endpoint ? prev.lastSent || "" : "" }));
      return json({ ok: true });
    }
    if (request.method === "DELETE") { await env.DB.delete("s:" + code); return json({ ok: true }); }
    if (request.method === "POST" && parts[3] === "test") {
      const sub = JSON.parse((await env.DB.get("s:" + code)) || "null");
      if (!sub) return json({ error: "no_subscription" }, 404);
      const status = await sendPush(env, sub.endpoint).catch(() => 0);
      return json({ ok: status >= 200 && status < 300, status });
    }
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReminders(env));
  },

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
