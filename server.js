// Solution Atlas — keyword → sourced mind map + glossary, without any AI model.
import express from "express";
import path from "node:path";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { config, isOfficial, sourceType } from "./lib/config.js";
import { politeGet, pool } from "./lib/http.js";
import { cached } from "./lib/cache.js";
import { activeProvider, searchDomain, wikiSearch, wikiParse, wikiDefine, wikiSummary } from "./lib/providers.js";
import { readAny } from "./lib/extract.js";
import { helpSearch, helpTopic, parseDocsUrl } from "./lib/sapHelp.js";
import { harvest, categorise } from "./lib/glossary.js";
import { buildFromSearch, buildFromDocument, buildFromWikipedia } from "./lib/mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1); // correct visitor IPs behind a hosting provider's proxy
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- simple per-IP rate limit (protects your search credits) ----
const hits = new Map();
app.use("/api", (req, res, next) => {
  const ip = req.ip || "x"; const now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 60e3); h.push(now); hits.set(ip, h);
  if (h.length > 30) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  next();
});

const normUrl = u => { try { const x = new URL(u); x.hash = ""; return x.toString(); } catch { return u; } };

// ---------------- SAP mode: SAP Help Portal's own search (free) + optional Brave/SearXNG for other SAP sites ----------------
function tocBranch(guide) {
  let items = guide.toc || [];
  while (items.length && items[0].text.toLowerCase() === (guide.guideTitle || "").toLowerCase() && !items[0].items.length) items = items.slice(1);
  if (!items.length) return null;
  const conv = (n, d) => ({ label: n.text.slice(0, 52), desc: "", source: { title: `${guide.guideTitle} — ${n.text}`, url: n.url || guide.guideUrl }, children: d < 3 ? n.items.slice(0, 8).map(c => conv(c, d + 1)) : [] });
  guide.guideTitle = String(guide.guideTitle || "").replace(/\s+/g, " ").trim();
  return { label: ("Guide: " + guide.guideTitle).slice(0, 52), desc: guide.guideDesc || "Chapters of the main SAP guide for this topic.", source: { title: guide.guideTitle, url: guide.guideUrl }, children: items.slice(0, 12).map(n => conv(n, 2)) };
}

async function sapMap(q) {
  const provider = activeProvider();
  const warnings = [];
  let results = [];
  const docs = new Map();
  let guide = null;

  if (provider === "fixtures") {
    const perDomain = await pool(config.sapDomains, 2, d => searchDomain(q, d));
    const seen = new Set();
    for (const l of perDomain) for (const r of Array.isArray(l) ? l : []) { const u = normUrl(r.url); if (!seen.has(u)) { seen.add(u); results.push({ ...r, url: u }); } }
    const read = await pool(results.slice(0, config.pagesToRead), 4, async r => readAny(await politeGet(r.url, { accept: "text/html,application/pdf" })));
    read.forEach((d, i) => { if (d && !d.error) docs.set(results[i].url, d); });
  } else {
    // 1) SAP Help Portal search (no key needed)
    let help = [];
    try { help = await helpSearch(q, 25); } catch (e) { warnings.push("SAP Help search: " + e.message); }
    help.sort((a, b) => (a.whatsNew - b.whatsNew));
    results.push(...help.slice(0, 20));
    // 2) Optional: other SAP sites through a search key
    if (provider === "brave" || provider === "searxng") {
      const others = config.sapDomains.filter(d => d !== "help.sap.com");
      const per = await pool(others, 2, d => searchDomain(q, d, 6));
      per.forEach((l, i) => Array.isArray(l) ? results.push(...l) : warnings.push(`${others[i]}: ${l?.error}`));
    }
    if (!results.length) { const e = new Error(`SAP Help Portal has no results for "${q}". Check the spelling or try a broader keyword.`); e.status = 404; throw e; }

    // 3) Read the best SAP Help topics (content + the guide's table of contents)
    const guideCount = {};
    help.filter(h => !h.whatsNew).slice(0, 10).forEach(h => { guideCount[h.guide] = (guideCount[h.guide] || 0) + 1; });
    const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 2 && w !== "sap");
    const guideScore = g => (guideCount[g] || 0) + 2 * qWords.filter(w => g.toLowerCase().includes(w)).length;
    const mainGuide = Object.keys(guideCount).sort((a, b) => guideScore(b) - guideScore(a))[0] || "";
    const helpToRead = [...help.filter(h => h.guide === mainGuide && !h.whatsNew).slice(0, 1), ...help.filter(h => !h.whatsNew)].filter((h, i, arr) => arr.findIndex(x => x.url === h.url) === i).slice(0, 6);
    const read = await pool(helpToRead, 2, h => helpTopic(h.url));
    read.forEach((d, i) => { if (d && !d.error) { docs.set(helpToRead[i].url, d); if (!guide && helpToRead[i].guide === mainGuide && d.toc?.length) guide = d; } else warnings.push(`${helpToRead[i].title}: ${d?.error}`); });
    // Other sites' pages: automatic reading follows each site's robots.txt
    const otherToRead = results.filter(r => !/help\.sap\.com/.test(r.url)).slice(0, 3);
    const read2 = await pool(otherToRead, 2, async r => readAny(await politeGet(r.url, { accept: "text/html,application/pdf" })));
    read2.forEach((d, i) => { if (d && !d.error) docs.set(otherToRead[i].url, d); else warnings.push(`${otherToRead[i].url}: ${d?.error}`); });
  }

  const map = buildFromSearch(q, results, docs);
  if (guide) {
    const tb = tocBranch(guide);
    if (tb) map.branches.unshift(tb);
    if (guide.guideDesc) map.summary = guide.guideDesc;
    map.sources.unshift({ title: guide.guideTitle + " (SAP Help Portal)", url: guide.guideUrl, type: "official", why: "Main SAP guide for this topic.", official: true });
  }
  const glossary = harvest([...docs.values(), ...results.map(r => ({ url: r.url, snippet: r.title + ". " + r.snippet }))], { query: q, limit: 40 });
  return { ...map, glossary, meta: { mode: "sap", provider: provider === "none" ? "sap-help" : "sap-help+" + provider, results: results.length, pagesRead: docs.size, warnings } };
}

// ---------------- General mode: Wikipedia article structure + linked-term definitions ----------------
async function generalMap(q, site) {
  const found = await wikiSearch(q, 5);
  if (!found.length) { const e = new Error(`Wikipedia has no article for "${q}".`); e.status = 404; throw e; }
  const page = await wikiParse(found[0].title);
  const w = buildFromWikipedia(page);
  const articleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`;

  // Glossary part 1: patterns in the article text
  const harvested = harvest([{ url: articleUrl, text: w.text }], { query: q, limit: 30 });
  // Part 2: the most-used linked concepts, defined by their own Wikipedia lead sentence
  const lower = w.text.toLowerCase();
  const linkRank = page.links.map(t => { const n = lower.split(t.toLowerCase()).length - 1; return { t, n }; })
    .filter(x => x.n >= 2 && !/^(list of|\d)/i.test(x.t)).sort((a, b) => b.n - a.n).slice(0, 30).map(x => x.t);
  const defs = await wikiDefine(linkRank).catch(() => ({}));
  const have = new Set(harvested.map(h => h.term.toLowerCase()));
  const linked = Object.entries(defs).filter(([t]) => !have.has(t.toLowerCase())).map(([t, d]) => ({
    term: t, abbr: "", definition: d.extract || d.description, category: categorise(t + " " + (d.description || "")),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`, evidence: ["wikilink"],
  })).filter(g => g.definition);

  const sources = [{ title: `${page.title} — Wikipedia`, url: articleUrl, type: "reference", why: "Article this map is built from.", official: true },
    ...found.slice(1).map(f => ({ title: f.title + " — Wikipedia", url: `https://en.wikipedia.org/wiki/${encodeURIComponent(f.title.replace(/ /g, "_"))}`, type: "reference", why: f.snippet.slice(0, 110), official: true }))];

  // Optional: official site results for the same keyword
  if (site && activeProvider() !== "none") {
    const extra = await searchDomain(q, site, 8).catch(() => []);
    for (const r of extra) sources.push({ title: r.title, url: r.url, type: "official", why: r.snippet.slice(0, 110), official: true });
    if (extra.length) w.branches.push({ label: `On ${site}`, desc: `Pages about ${q} on the official site.`, source: { title: extra[0].title, url: extra[0].url },
      children: extra.slice(0, 6).map(r => ({ label: r.title.slice(0, 48), desc: r.snippet.slice(0, 260), source: { title: r.title, url: r.url }, children: [] })) });
  }
  return { topic: w.topic, summary: w.summary, branches: w.branches, glossary: [...harvested, ...linked].slice(0, 45), sources,
    meta: { mode: "general", provider: "wikipedia", results: found.length, pagesRead: 1, warnings: [] } };
}

const wrap = fn => async (req, res) => {
  const t0 = Date.now();
  try { const out = await fn(req); res.json({ ...out, meta: { ...(out.meta || {}), tookMs: Date.now() - t0, cached: !!out.cached } }); }
  catch (e) { console.error("[error]", req.method, req.originalUrl, "-", e.message); res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong while gathering sources: " + e.message }); }
};

// ---------------- Document mode: one official URL (HTML or PDF), or an uploaded file ----------------
function mapDocument(doc, officialUrl) {
  const map = buildFromDocument(doc);
  if (!map.branches.length) { const e = new Error("That document has no headings or bookmarks to map. Try the PDF version of the guide."); e.status = 422; throw e; }
  const glossary = harvest([doc], { query: map.topic, limit: 45 });
  return { ...map, glossary, meta: { mode: "document", provider: "direct", results: 1, pagesRead: 1, warnings: officialUrl && isOfficial(officialUrl) ? [] : ["This document is not linked to an official domain."] } };
}
async function assertPublicHost(hostname) {
  const bad = () => { const e = new Error("That link points to a private or local address, which isn't allowed."); e.status = 400; throw e; };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) bad();
  let addrs = [];
  try { addrs = await dns.lookup(hostname, { all: true }); } catch { const e = new Error("That website couldn't be found."); e.status = 400; throw e; }
  for (const { address } of addrs) {
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address) || /^(::1|::|fc|fd|fe80)/i.test(address) || /^::ffff:(127|10|192\.168)\./i.test(address)) bad();
  }
}
async function documentMap(url) {
  let u; try { u = new URL(url); } catch { const e = new Error("That isn't a valid URL."); e.status = 400; throw e; }
  if (!/^https?:$/.test(u.protocol)) { const e = new Error("Only http and https links are supported."); e.status = 400; throw e; }
  await assertPublicHost(u.hostname);
  if (parseDocsUrl(u.toString())) {
    const t = await helpTopic(u.toString());
    const doc = { kind: "html", url: t.guideUrl, title: t.guideTitle || t.title, description: t.guideDesc, outline: t.toc.map(function conv(n) { return { text: n.text, url: n.url, items: n.items.map(conv) }; }), headings: [], defs: t.defs, text: t.text };
    return mapDocument(doc, u.toString());
  }
  let res;
  try { res = await politeGet(u.toString(), { accept: "text/html,application/pdf" }, { userInitiated: true }); }
  catch (err) {
    if (/robots\.txt/.test(err.message)) { const e = new Error(`${u.hostname} doesn't allow automated tools to download its pages. Open the link in your browser, save the PDF, then click "Upload PDF".`); e.status = 403; throw e; }
    throw err;
  }
  return mapDocument(await readAny(res), u.toString());
}

app.post("/api/upload", express.raw({ type: () => true, limit: "60mb" }), wrap(async req => {
  const buf = req.body;
  if (!buf || !buf.length) { const e = new Error("The file was empty."); e.status = 400; throw e; }
  const name = String(req.query.name || "Uploaded document").slice(0, 200);
  let source = String(req.query.source || "").trim();
  try { if (!/^https?:$/.test(new URL(source).protocol)) source = ""; } catch { source = ""; }
  const doc = await readAny({ buf, type: String(req.headers["content-type"] || ""), url: source || name });
  if (!doc.title) doc.title = name.replace(/\.(pdf|html?)$/i, "");
  doc.url = source || doc.url;
  const out = mapDocument(doc, source);
  if (!source) out.sources = [{ title: doc.title, url: "", type: "official", why: "Uploaded file: " + name, official: false }];
  return out;
}));


app.get("/api/map", wrap(req => {
  const q = String(req.query.q || "").trim().slice(0, 120);
  const mode = req.query.mode === "general" ? "general" : "sap";
  const site = String(req.query.site || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!q) { const e = new Error("Type a keyword or application name."); e.status = 400; throw e; }
  const key = `map:${mode}:${site}:${q.toLowerCase()}`;
  return req.query.fresh ? (mode === "sap" ? sapMap(q) : generalMap(q, site)) : cached(key, () => (mode === "sap" ? sapMap(q) : generalMap(q, site)));
}));

app.post("/api/document", wrap(req => {
  const url = String(req.body?.url || "").trim();
  return cached(`doc:${url}`, () => documentMap(url));
}));

app.get("/api/define", wrap(async req => {
  const term = String(req.query.term || "").trim().slice(0, 100);
  return cached(`def:${term.toLowerCase()}`, () => wikiSummary(term));
}));

app.get("/api/status", (req, res) => res.json({ provider: activeProvider() === "none" ? "sap-help" : activeProvider(), sapDomains: config.sapDomains, officialDomains: config.officialDomains }));

// Start listening. If an older copy of the app still holds the port (common after an update on Windows),
// stop that old Node process and take over, so a double-click always gives the newest version.
import { execSync } from "node:child_process";
function stopOldCopy(port) {
  if (process.platform !== "win32") return false;
  let stopped = false;
  try {
    const lines = execSync("netstat -ano -p tcp").toString().split(/\r?\n/);
    const pids = [...new Set(lines.filter(l => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l)).map(l => l.trim().split(/\s+/).pop()))]
      .filter(pid => pid && pid !== String(process.pid) && pid !== String(process.ppid));
    for (const pid of pids) {
      const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).toString();
      if (/node\.exe/i.test(info)) { execSync(`taskkill /PID ${pid} /F`); console.log(`Closed an older copy of Solution Atlas (process ${pid}).`); stopped = true; }
    }
  } catch { /* best effort */ }
  return stopped;
}
function start(retry = true) {
  const srv = app.listen(config.port, () => console.log(`Solution Atlas is running on http://localhost:${config.port}  (search provider: ${activeProvider()})`));
  srv.on("error", e => {
    if (e.code === "EADDRINUSE" && retry && stopOldCopy(config.port)) return setTimeout(() => start(false), 1500);
    if (e.code === "EADDRINUSE") console.error(`\nPort ${config.port} is already used by another program. Close it, or set PORT=3001 in the .env file, then start again.`);
    else console.error(e);
  });
}
if (process.env.NODE_ENV !== "test") start();
export default app;
