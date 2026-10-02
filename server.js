// School Calendar API — zero dependencies, Node 18+
// Run:  ADMIN_TOKEN=your-secret node server.js
// Parents read (GET, public). Admin writes (POST/PUT/DELETE, needs x-admin-token header).

const http = require("http");
try { // load private settings from .env (KEY=value per line)
  require("fs").readFileSync(require("path").join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch {}
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "events.json");
const BOT_TOKEN = process.env.BOT_TOKEN, CHAT_ID = process.env.CHAT_ID, PUBLIC_URL = process.env.PUBLIC_URL || "";
const TG = (process.env.TG_API || "https://api.telegram.org") + "/bot" + BOT_TOKEN;
const CATEGORIES = ["Exams", "Holidays", "Events", "Sports", "Parent meetings", "Deadlines"];

if (!ADMIN_TOKEN) {
  console.error("Set ADMIN_TOKEN before starting, e.g. ADMIN_TOKEN=mysecret node server.js");
  process.exit(1);
}

const load = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; }
};
const save = (events) => {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic write
};

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function clean(b) {
  const title = String(b.title || "").trim().slice(0, 120);
  if (!title) return { error: "title is required" };
  if (!isDate(b.date)) return { error: "date must be YYYY-MM-DD" };
  if (!CATEGORIES.includes(b.category)) return { error: "category must be one of: " + CATEGORIES.join(", ") };
  const endDate = b.endDate || "";
  if (endDate && (!isDate(endDate) || endDate < b.date)) return { error: "endDate must be YYYY-MM-DD and not before date" };
  const time = b.time || "", endTime = b.endTime || "";
  if ((time && !isTime(time)) || (endTime && !isTime(endTime))) return { error: "time must be HH:MM" };
  return { value: { title, date: b.date, endDate, time, endTime, category: b.category, note: String(b.note || "").slice(0, 1000) } };
}

const isAdmin = (req) => {
  const t = req.headers["x-admin-token"] || "";
  const a = Buffer.from(t), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const send = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-token",
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 20000) { reject(new Error("too large")); req.destroy(); } });
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("invalid JSON")); } });
});

// ---------- Telegram ----------
const h = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const when = (e) => {
  const f = (d) => new Date(d + "T00:00").toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" });
  return f(e.date) + (e.endDate ? " – " + f(e.endDate) : "") + (e.time ? ", " + e.time + (e.endTime ? "–" + e.endTime : "") : "");
};
const line = (e) => `<b>${h(e.title)}</b> (${h(e.category)})\n${h(when(e))}${e.note ? "\n" + h(e.note) : ""}`;
async function tg(method, body) {
  if (!BOT_TOKEN) return;
  try {
    const r = await fetch(`${TG}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) { console.error("Telegram error:", e.message); }
}
const SUBS_FILE = process.env.SUBS_FILE || path.join(__dirname, "subscribers.json");
const subs = () => { try { return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8")); } catch { return []; } };
const saveSubs = (l) => fs.writeFileSync(SUBS_FILE, JSON.stringify(l, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function notify(text) { // one private message per parent, plus the optional group
  const targets = subs().map((s) => s.chatId);
  if (CHAT_ID) targets.push(CHAT_ID);
  for (const id of targets) {
    const r = await tg("sendMessage", { chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true });
    if (r && r.ok === false && [403, 400].includes(r.error_code) && id !== CHAT_ID) // parent blocked the bot
      saveSubs(subs().filter((s) => s.chatId !== id));
    await sleep(60); // stay under Telegram's rate limit
  }
}
const upcoming = () => { const t = new Date().toISOString().slice(0, 10); return load().filter((e) => (e.endDate || e.date) >= t).sort((a, b) => a.date.localeCompare(b.date)); };

async function poll(offset = 0) {
  const r = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
  let next = offset;
  for (const u of (r && r.result) || []) {
    next = u.update_id + 1;
    const m = u.message;
    if (!m || !m.text) continue;
    const priv = m.chat.type === "private", cmd = (m.text.match(/^\/(\w+)/) || [])[1];
    const reply = (text) => tg("sendMessage", { chat_id: m.chat.id, text, parse_mode: "HTML", disable_web_page_preview: true });
    if (cmd === "stop" && priv) {
      saveSubs(subs().filter((x) => x.chatId !== m.chat.id));
      reply("You're unsubscribed. Send /start any time to get school updates again.");
    } else if (cmd === "start" || cmd === "calendar") {
      let intro = "";
      if (cmd === "start" && priv) {
        const l = subs();
        if (!l.some((x) => x.chatId === m.chat.id)) { l.push({ chatId: m.chat.id, name: (m.from && m.from.first_name) || "", joinedAt: new Date().toISOString() }); saveSubs(l); }
        intro = "✅ You'll now get school calendar updates here. Send /stop to unsubscribe.\n\n";
      }
      const ev = upcoming().slice(0, 8);
      reply(intro + (ev.length ? "<b>Upcoming school events</b>\n\n" + ev.map(line).join("\n\n") : "No upcoming events right now."));
    }
  }
  setTimeout(() => poll(next), r && r.ok ? 0 : 5000);
}
if (BOT_TOKEN) {
  if (PUBLIC_URL.startsWith("https://"))
    tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Calendar", web_app: { url: PUBLIC_URL } } });
  tg("setMyCommands", { commands: [{ command: "calendar", description: "Show upcoming school events" }, { command: "stop", description: "Stop getting updates" }] });
  poll();
  console.log("Telegram bot connected" + (CHAT_ID ? "" : " (no CHAT_ID: group announcements off)"));
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/calendar.html")) {
    try { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(path.join(__dirname, "calendar.html"))); }
    catch { return send(res, 404, { error: "calendar.html not found next to server.js" }); }
  }
  const m = url.pathname.match(/^\/api\/calendar(?:\/([\w-]+))?\/?$/);
  if (!m) return send(res, 404, { error: "not found" });
  const id = m[1];

  try {
    if (req.method === "GET" && !id) {
      const events = load().sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
      return send(res, 200, events);
    }
    if (req.method === "GET" && url.pathname.endsWith("/check")) return send(res, 200, { admin: isAdmin(req) });

    if (req.method === "GET" && id === "subscribers") return isAdmin(req) ? send(res, 200, { count: subs().length }) : send(res, 401, { error: "admin token required" });
    if (!isAdmin(req)) return send(res, 401, { error: "admin token required" });

    if (req.method === "POST" && !id) {
      const { error, value } = clean(await readBody(req));
      if (error) return send(res, 400, { error });
      const events = load();
      const ev = { id: crypto.randomUUID(), ...value, createdAt: new Date().toISOString() };
      events.push(ev); save(events);
      notify("📅 <b>New event</b>\n\n" + line(ev));
      return send(res, 201, ev);
    }
    if (req.method === "PUT" && id) {
      const { error, value } = clean(await readBody(req));
      if (error) return send(res, 400, { error });
      const events = load(), i = events.findIndex((e) => e.id === id);
      if (i < 0) return send(res, 404, { error: "event not found" });
      events[i] = { ...events[i], ...value, updatedAt: new Date().toISOString() }; save(events);
      notify("✏️ <b>Event updated</b>\n\n" + line(events[i]));
      return send(res, 200, events[i]);
    }
    if (req.method === "DELETE" && id) {
      const events = load(), gone = events.find((e) => e.id === id), next = events.filter((e) => e.id !== id);
      if (!gone) return send(res, 404, { error: "event not found" });
      notify("❌ <b>Event cancelled</b>\n\n" + line(gone));
      save(next);
      return send(res, 200, { deleted: id });
    }
    send(res, 405, { error: "method not allowed" });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, () => console.log(`Calendar API on :${PORT}`));
