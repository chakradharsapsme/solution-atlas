// Search providers. Each returns [{title, url, snippet}] restricted to the domain asked for.
import fs from "node:fs";
import path from "node:path";
import { config, hostOf } from "./config.js";
import { getJSON } from "./http.js";

export const stripTags = s => String(s || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const onDomain = (u, d) => { const h = hostOf(u); return h === d || h.endsWith("." + d) || (d.startsWith("www.") && h === d.slice(4)); };

// ---------- Brave Search API (paid, includes monthly free credit) ----------
async function brave(query, domain, count) {
  const q = `${query} site:${domain}`;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(20, count)}&extra_snippets=true&safesearch=off`;
  const data = await getJSON(url, { headers: { "X-Subscription-Token": config.braveKey } });
  return (data?.web?.results || []).map(r => ({
    title: stripTags(r.title), url: r.url,
    snippet: stripTags([r.description, ...(r.extra_snippets || [])].join(" ")),
  }));
}

// ---------- SearXNG (free, self-hosted metasearch; enable JSON in settings.yml) ----------
async function searxng(query, domain, count) {
  const url = `${config.searxngUrl}/search?q=${encodeURIComponent(`${query} site:${domain}`)}&format=json&language=en`;
  const data = await getJSON(url);
  return (data?.results || []).slice(0, count).map(r => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.content) }));
}

// ---------- Offline fixtures (tests / UI work without network) ----------
function fixtures(query, domain) {
  const f = path.resolve(process.cwd(), "test/fixtures/search.json");
  const all = JSON.parse(fs.readFileSync(f, "utf8"));
  return all.filter(r => onDomain(r.url, domain));
}

export function activeProvider() {
  if (config.provider === "fixtures") return "fixtures";
  if (config.provider === "brave" || (config.provider === "auto" && config.braveKey)) return "brave";
  if (config.provider === "searxng" || (config.provider === "auto" && config.searxngUrl)) return "searxng";
  return "none";
}

export async function searchDomain(query, domain, count = config.resultsPerDomain) {
  const p = activeProvider();
  let rows = [];
  if (p === "brave") rows = await brave(query, domain, count);
  else if (p === "searxng") rows = await searxng(query, domain, count);
  else if (p === "fixtures") rows = fixtures(query, domain);
  // Belt and braces: keep only results that really are on the requested domain.
  return rows.filter(r => r.url && onDomain(r.url, domain)).slice(0, count);
}

// ---------- Wikipedia (free, no key) ----------
const WP = "https://en.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*";

export async function wikiSearch(q, limit = 5) {
  if (config.provider === "fixtures") return JSON.parse(fs.readFileSync(path.resolve("test/fixtures/wiki-search.json"), "utf8"));
  const d = await getJSON(`${WP}&action=query&list=search&srlimit=${limit}&srsearch=${encodeURIComponent(q)}`);
  return (d?.query?.search || []).map(s => ({ title: s.title, snippet: stripTags(s.snippet) }));
}

export async function wikiParse(title) {
  if (config.provider === "fixtures") return JSON.parse(fs.readFileSync(path.resolve("test/fixtures/wiki-parse.json"), "utf8"));
  const d = await getJSON(`${WP}&action=parse&redirects=1&prop=sections|text|links&page=${encodeURIComponent(title)}`);
  if (!d?.parse) throw new Error("Wikipedia page not found: " + title);
  return { title: d.parse.title, sections: d.parse.sections || [], html: d.parse.text || "", links: (d.parse.links || []).filter(l => l.ns === 0 && l.exists).map(l => l.title) };
}

// Short definitions for up to N titles (first sentence of each article).
export async function wikiDefine(titles) {
  if (config.provider === "fixtures") return {};
  const out = {};
  for (let i = 0; i < titles.length; i += 20) {
    const batch = titles.slice(i, i + 20);
    const d = await getJSON(`${WP}&action=query&redirects=1&prop=extracts|description&exintro=1&explaintext=1&exsentences=1&exlimit=20&titles=${encodeURIComponent(batch.join("|"))}`);
    for (const p of d?.query?.pages || []) if (!p.missing) out[p.title] = { extract: p.extract || "", description: p.description || "" };
  }
  return out;
}

export async function wikiSummary(term) {
  const d = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, "_"))}`);
  return { title: d.title, extract: d.extract, url: d?.content_urls?.desktop?.page };
}
