// Free SAP Help Portal access: the same search and content feeds the help.sap.com website itself uses.
// No API key. Light use only: one search per keyword and a few page reads, spaced out.
import { politeGet } from "./http.js";
import { readHtml } from "./extract.js";

const BASE = "https://help.sap.com";
const decode = s => String(s || "").replace(/<[^>]+>/g, "").replace(/&hellip;/g, "…").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const json = async url => JSON.parse((await politeGet(url, { accept: "application/json" }, { userInitiated: true })).buf.toString("utf8"));

export async function helpSearch(q, count = 25) {
  const url = `${BASE}/http.svc/elasticsearch?q=${encodeURIComponent(q)}&area=content&state=PRODUCTION&format=standard,html,pdf,others&to=${count}&language=en-US&excludeNotSearchable=1`;
  const d = await json(url);
  return (d?.data?.results || []).filter(r => r.url).map(r => ({
    title: decode(r.title),
    url: BASE + r.url.replace(/[?&](state=PRODUCTION)/, ""),
    snippet: decode(r.snippet || r.description),
    guide: decode(r.deliverableTitle),
    product: decode(r.product),
    whatsNew: /\.wn$/.test(r.transtype || "") || /^what's new/i.test(r.deliverableTitle || ""),
    date: r.date || "",
  }));
}

// /docs/<product>/<deliverable>/<topic>[.html]?version=...  ->  parts for the metadata call
export function parseDocsUrl(u) {
  try {
    const x = new URL(u);
    if (!/(^|\.)help\.sap\.com$/.test(x.hostname)) return null;
    const m = x.pathname.match(/^\/docs\/([^/]+)\/([^/]+)(?:\/([^/?#]+))?/);
    if (!m) return null;
    return { product: m[1], deliverable: m[2], topic: m[3] || "", version: x.searchParams.get("version") || "LATEST", locale: x.searchParams.get("locale") || "en-US" };
  } catch { return null; }
}

export async function helpTopic(u) {
  const p = parseDocsUrl(u);
  if (!p) throw new Error("Not a help.sap.com/docs link: " + u);
  const meta = await json(`${BASE}/http.svc/deliverableMetadata?product_url=${encodeURIComponent(p.product)}&deliverable_url=${encodeURIComponent(p.deliverable)}&topic_url=${encodeURIComponent(p.topic)}&version=${encodeURIComponent(p.version)}&loadlandingpageontopicnotfound=true&locale=${p.locale}`);
  const dl = meta?.data?.deliverable;
  if (!dl?.id) throw new Error("SAP Help could not find that page.");
  const file = meta?.data?.filePath || (p.topic && /\.html?$/.test(p.topic) ? p.topic : "");
  const pc = await json(`${BASE}/http.svc/pagecontent?deliverableInfo=1&deliverable_id=${dl.id}&buildNo=${dl.buildNo}&file_path=${encodeURIComponent(file)}`);
  const data = pc?.data || {};
  const doc = readHtml(Buffer.from(`<html><head><title>${data.currentPage?.t || data.deliverable?.title || ""}</title></head><body><main>${data.body || ""}</main></body></html>`), u);
  const guide = data.deliverable || {};
  const docBase = `${BASE}/docs/${p.product}/${p.deliverable}/`;
  const toc = convToc(guide.fullToc || [], docBase, p.version);
  const terms = [];
  const walk = items => items.forEach(n => {
    const m = n.text.match(/^(?:about|what is|what are|understanding|introduction to|overview of)\s+(?:the\s+)?(.+?)\??$/i);
    if (m && m[1].length < 50 && !/^(this|these|guided buying administration)$/i.test(m[1])) terms.push({ term: m[1], url: n.url });
    walk(n.items);
  });
  walk(toc);
  // A definition for the page we actually read: its heading's first sentence
  const lead = (doc.text.match(/^.{0,120}?[.!?]\s+(.{20,260}?[.!?])(\s|$)/) || [])[1] || "";
  for (const t of terms) if (doc.title && doc.title.toLowerCase().includes(t.term.toLowerCase())) t.definition = lead;
  return { ...doc, terms, title: doc.title || guide.title, guideTitle: guide.title || "", guideDesc: decode(guide.shortdesc), guideUrl: docBase + (guide.landingPage || "") + `?version=${p.version}`, toc, version: guide.version || p.version };
}

function convToc(items, base, version, depth = 1) {
  return items.slice(0, 40).map(i => ({ text: decode(i.t), url: i.u ? `${base}${i.u}?version=${version}` : "", items: depth < 4 ? convToc(i.c || [], base, version, depth + 1) : [] })).filter(i => i.text);
}
