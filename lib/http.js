// Polite HTTP fetching: timeout, size cap, user agent, robots.txt, small concurrency pool.
import { config, hostOf } from "./config.js";

export async function get(url, { accept = "*/*", headers = {}, timeoutMs = config.fetchTimeoutMs } = {}) {
  if (config.provider === "fixtures") return fixtureGet(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": config.userAgent, Accept: accept, "Accept-Language": "en", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > config.maxBytes) throw new Error(`Too large (${len} bytes): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > config.maxBytes) throw new Error(`Too large: ${url}`);
    return { url: res.url || url, status: res.status, type: (res.headers.get("content-type") || "").toLowerCase(), buf };
  } finally {
    clearTimeout(t);
  }
}

// Offline mode: serve pages from test/fixtures/pages.json ({url: file}).
async function fixtureGet(url) {
  const fs = await import("node:fs"); const path = await import("node:path");
  const idx = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/pages.json"), "utf8"));
  const f = idx[url];
  if (!f) { if (url.endsWith("/robots.txt")) return { url, status: 200, type: "text/plain", buf: Buffer.from("User-agent: *\nDisallow: /private/\n") }; throw new Error("HTTP 404 for " + url); }
  const buf = fs.readFileSync(path.resolve("test/fixtures", f));
  return { url, status: 200, type: f.endsWith(".pdf") ? "application/pdf" : "text/html", buf };
}

export async function getJSON(url, opts = {}) {
  const r = await get(url, { accept: "application/json", ...opts });
  return JSON.parse(r.buf.toString("utf8"));
}

// ---- robots.txt (User-agent: * group only; good enough for polite crawling) ----
const robotsCache = new Map();
async function rulesFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules = [];
  try {
    const r = await get(origin + "/robots.txt", { accept: "text/plain", timeoutMs: 5000 });
    rules = parseRobots(r.buf.toString("utf8"));
  } catch { rules = []; }
  robotsCache.set(origin, rules);
  return rules;
}
export function parseRobots(txt) {
  const rules = []; let applies = false, inGroup = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const [k, ...rest] = line.split(":"); const key = k.trim().toLowerCase(); const val = rest.join(":").trim();
    if (key === "user-agent") { if (!inGroup) applies = false; inGroup = true; if (val === "*") applies = true; continue; }
    inGroup = false;
    if (!applies) continue;
    if (key === "disallow" && val) rules.push({ allow: false, path: val });
    if (key === "allow" && val) rules.push({ allow: true, path: val });
  }
  return rules;
}
export function robotsAllows(rules, pathname) {
  let best = null;
  for (const r of rules) {
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(pathname) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}
export async function allowed(url) {
  if (!config.respectRobots) return true;
  try {
    const u = new URL(url);
    return robotsAllows(await rulesFor(u.origin), u.pathname + u.search);
  } catch { return false; }
}

// ---- tiny concurrency pool ----
export async function pool(items, size, fn) {
  const out = new Array(items.length); let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e.message || e) }; } }
  });
  await Promise.all(workers);
  return out;
}

// Per-host spacing so we never hammer one site.
const lastHit = new Map();
// userInitiated: the person pasted or clicked this exact link (like opening it in a browser).
// Automatic crawling (search mode) always honours robots.txt.
export async function politeGet(url, opts, { userInitiated = false } = {}) {
  const h = hostOf(url);
  const wait = Math.max(0, (lastHit.get(h) || 0) + 400 - Date.now());
  lastHit.set(h, Date.now() + wait);
  if (wait) await new Promise(r => setTimeout(r, wait));
  if (!userInitiated && !(await allowed(url))) throw new Error("Blocked by robots.txt: " + url);
  return get(url, opts);
}
