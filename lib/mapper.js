// Build mind-map trees from search results, document outlines, or Wikipedia sections. Pure rules, no AI.
import * as cheerio from "cheerio";
import { sourceType, isOfficial } from "./config.js";
import { cleanTitle } from "./extract.js";

const STOP = new Set(("a an and are as at be by can for from has have how in into is it its of on or that the this to was what when where which with you your we our not use using used new all any about more most also via per between within without over under than then there these those their other may will should must only such each both do does done get set out up one two three guide help overview documentation portal topic topics learn learning community blog blogs question questions answer answers sap version release latest info information introduction features feature details detail see read list lists support how-to ariba s/4hana hana cloud configuring configure creating create setting enabling enable managing manage tips tip working work option options step steps creates create created allows allow enables enable supports support includes include provides provide requires require displays display shows show lets adds add added now can users user customers customer administrators administrator new changes change changed feature features reference number products product details technical title description release version note notes tip caution example examples prerequisites prerequisite procedure context result results").split(" "));
const TYPE_WEIGHT = { official: 3, learning: 2, api: 2, roadmap: 1.5, product: 1.5, community: 1, reference: 1 };
const TYPE_LABEL = { official: "Official documentation", learning: "Learning", community: "Community discussions", api: "APIs & integration", roadmap: "Roadmap & release", product: "Product pages", reference: "Reference" };

const words = s => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s/&+-]/gu, " ").split(/\s+/).filter(Boolean);
const titleCase = s => s.replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).replace(/\b(And|Of|For|To|In|On|With|The|A)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase());
const cap = (s, n) => (s && s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s || "");
const firstSentence = s => (String(s || "").match(/^.{20,260}?[.!?](\s|$)/) || [cap(s, 220)])[0].trim();

function phrases(text, queryWords) {
  const out = new Set();
  const runs = String(text || "").toLowerCase().split(/[.,;:!?()[\]{}"“”|/\\—–]+/);
  for (const run of runs) {
    const w = words(run);
    let seq = [];
    const flush = () => {
      for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= seq.length; i++) {
        const g = seq.slice(i, i + n);
        if (g.every(x => queryWords.has(x))) continue;
        if (n === 1 && (g[0].length < 4 || queryWords.has(g[0]))) continue;
        if (/^\d/.test(g[0])) continue;
        if (g.some(x => x.length < 3)) continue;
        out.add(g.join(" "));
      }
      seq = [];
    };
    for (const x of w) { if (STOP.has(x) || x.length < 2) flush(); else seq.push(x); }
    flush();
  }
  return out;
}

function shortLabel(title) {
  const parts = cleanTitle(title).split(/\s+[|–—]\s+/);
  const t = (parts[0].split(/\s+/).length >= 2 ? parts[0] : parts.join(" – ")).replace(/^[^\p{L}\p{N}]+/u, "");
  return cap(t, 48);
}

export function buildFromSearch(query, results, docs, { wiki = null } = {}) {
  const qw = new Set(words(query));
  const docOf = u => docs.get(u);
  const items = results.map((r, idx) => {
    const d = docOf(r.url);
    const type = sourceType(r.url);
    const heads = (d?.headings || []).map(h => h.text).join(". ");
    return { ...r, idx, type, doc: d, weight: TYPE_WEIGHT[type] || 1,
      titleP: phrases(r.title, qw), bodyP: phrases(r.snippet + ". " + heads + ". " + (d?.description || ""), qw) };
  });

  // Score phrases by weighted document frequency.
  const score = new Map(), df = new Map();
  for (const it of items) {
    const seen = new Set([...it.titleP, ...it.bodyP]);
    for (const p of seen) {
      const n = p.split(" ").length;
      const s = it.weight * (it.titleP.has(p) ? 2 : 1) * (n === 2 ? 1.6 : n === 3 ? 1.25 : 0.6);
      score.set(p, (score.get(p) || 0) + s);
      df.set(p, (df.get(p) || 0) + 1);
    }
  }
  const ranked = [...score.entries()].filter(([p]) => df.get(p) >= 2).sort((a, b) => b[1] - a[1]);
  const chosen = [];
  for (const [p] of ranked) {
    const stem = w => w.slice(0, 5);
    const pw = new Set(p.split(" ").map(stem));
    const clash = chosen.some(c => {
      const cw = new Set(c.split(" ").map(stem));
      const inter = [...pw].filter(x => cw.has(x)).length;
      return c.includes(p) || p.includes(c) || inter / Math.min(pw.size, cw.size) >= 0.5;
    });
    if (!clash) chosen.push(p);
    if (chosen.length >= 7) break;
  }

  // Assign each result to its best branch.
  const branches = chosen.map(p => ({ phrase: p, label: titleCase(p), items: [] }));
  const leftovers = [];
  for (const it of items) {
    let best = null, bestS = 0;
    for (const b of branches) {
      const s = (it.titleP.has(b.phrase) ? 3 : 0) + (it.bodyP.has(b.phrase) ? 1 : 0);
      const tie = s && best && s === bestS && score.get(b.phrase) > score.get(best.phrase);
      if (s > bestS || tie) { best = b; bestS = s; }
    }
    if (best && best.items.length < 6) best.items.push(it); else leftovers.push(it);
  }
  for (const it of leftovers) {
    const label = TYPE_LABEL[it.type] || "More sources";
    let b = branches.find(x => x.label === label && x.byType);
    if (!b) { b = { phrase: "", label, items: [], byType: true }; branches.push(b); }
    if (b.items.length < 6) b.items.push(it);
  }

  const corpus = items.map(i => i.snippet + " " + (i.doc?.text || "").slice(0, 20000)).join(" ");
  const sentenceWith = p => {
    const re = new RegExp(`[^.!?]{0,200}\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^.!?]{0,200}[.!?]`, "i");
    const m = corpus.match(re); return m ? m[0].trim() : "";
  };

  const out = branches.filter(b => b.items.length).map(b => {
    b.items.sort((a, c) => c.weight - a.weight || a.idx - c.idx);
    const top = b.items[0];
    return {
      label: b.label,
      desc: b.byType ? `${b.items.length} more result${b.items.length > 1 ? "s" : ""} from ${b.label.toLowerCase()}.` : (cap(sentenceWith(b.phrase), 260) || `Mentioned in ${b.items.length} official sources.`),
      source: { title: cleanTitle(top.title), url: top.url },
      children: b.items.map(it => ({
        label: shortLabel(it.title),
        desc: cap(it.snippet || it.doc?.description || "", 280),
        source: { title: cleanTitle(it.title), url: it.url },
        children: (it.doc?.headings || []).filter(h => h.level >= 2 && h.level <= 3 && h.text.toLowerCase() !== cleanTitle(it.title).toLowerCase())
          .slice(0, 6).map(h => ({ label: cap(h.text, 48), desc: "", source: { title: cleanTitle(it.title) + " — " + h.text, url: it.url }, children: [] })),
      })),
    };
  });

  const helpFirst = [...items].sort((a, b) => b.weight - a.weight).find(i => i.snippet);
  const summary = wiki?.extract ? firstSentence(wiki.extract) : helpFirst ? firstSentence(helpFirst.snippet) : "";
  const sources = items.map(i => ({ title: cleanTitle(i.title), url: i.url, type: i.type, why: cap(i.snippet, 110), official: isOfficial(i.url) }));
  return { topic: query, summary, branches: out, sources };
}

// ---------- From a document outline (PDF bookmarks or HTML headings) ----------
export function buildFromDocument(doc) {
  let tree = doc.outline?.length ? doc.outline : headingsToTree(doc.headings || []);
  // A single wrapper chapter (e.g. the guide's own title) adds nothing: descend into it.
  while (tree.length === 1 && tree[0].items.length) tree = tree[0].items;
  const skip = /^(content|contents|table of contents|document history|important disclaimers|legal|copyright|index|glossary)\b/i;
  const descFor = label => {
    const t = doc.text || ""; const l = label.slice(0, 60);
    let i = t.indexOf(l); if (i !== -1) { const j = t.indexOf(l, i + l.length); if (j !== -1) i = j; }
    if (i === -1) return "";
    const after = t.slice(i + l.length, i + l.length + 600).replace(/^[\s.\d]+/, "");
    return cap(firstSentence(after), 240);
  };
  const conv = (n, depth) => ({
    label: cap(n.text.replace(/^\d+(\.\d+)*\s+/, ""), 52),
    desc: depth <= 3 ? descFor(n.text) : "",
    source: { title: (doc.title || "Document") + " — " + n.text, url: n.url || doc.url },
    children: depth < 4 ? n.items.filter(c => !skip.test(c.text)).slice(0, 10).map(c => conv(c, depth + 1)) : [],
  });
  return {
    topic: doc.title || fileTitle(doc.url),
    summary: doc.description || (doc.kind === "pdf" ? `Mapped from the bookmarks of a ${doc.pages}-page PDF.` : "Mapped from the page's headings."),
    branches: dedupe(tree.filter(n => !skip.test(n.text))).slice(0, 12).map(n => conv(n, 1)),
    sources: [{ title: doc.title || doc.url, url: doc.url, type: sourceType(doc.url), why: "The document this map was built from.", official: isOfficial(doc.url) }],
  };
}

function fileTitle(u) {
  const name = decodeURIComponent(String(u || "").split(/[?#]/)[0].split("/").pop() || "Document").replace(/\.(pdf|html?)$/i, "");
  return name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim() || "Document";
}
function dedupe(items) { const seen = new Set(); return items.filter(n => { const k = n.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }

export function headingsToTree(headings) {
  const root = { items: [] }; const stack = [{ level: 0, node: root }];
  for (const h of headings) {
    if (h.level === 1) continue;
    const node = { text: h.text, items: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack[stack.length - 1].node.items.push(node);
    stack.push({ level: h.level, node });
  }
  return root.items;
}

// ---------- From a Wikipedia article ----------
const WIKI_SKIP = /^(see also|references|external links|notes|further reading|bibliography|sources|citations|footnotes)$/i;
export function buildFromWikipedia(page) {
  const $ = cheerio.load(page.html);
  $("sup.reference, .mw-editsection, table, .navbox, .reflist, style, .hatnote, .shortdescription, .infobox").remove();
  const firstPara = {}; let current = "__lead"; let lead = "";
  $(".mw-parser-output").children().each((_, el) => {
    const e = $(el);
    const h = e.is("h2,h3,h4") ? e : e.hasClass("mw-heading") ? e.find("h2,h3,h4").first() : null;
    if (h && h.length) { current = h.attr("id") || h.find(".mw-headline").attr("id") || h.text().trim().replace(/ /g, "_"); return; }
    if (e.is("p")) {
      const t = e.text().replace(/\s+/g, " ").trim();
      if (!t) return;
      if (current === "__lead") { if (!lead) lead = t; }
      else if (!firstPara[current]) firstPara[current] = t;
    }
  });
  const secs = page.sections.filter(s => !WIKI_SKIP.test(cheerio.load(s.line).text()));
  const tree = []; const stack = [];
  for (const s of secs) {
    const node = { label: cap(cheerio.load(s.line).text(), 52), desc: cap(firstSentence(firstPara[s.anchor] || ""), 260), source: { title: `${page.title} — ${cheerio.load(s.line).text()}`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}#${s.anchor}` }, children: [] };
    const lvl = Number(s.toclevel);
    while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
    if (!stack.length) tree.push(node); else stack[stack.length - 1].node.children.push(node);
    stack.push({ lvl, node });
  }
  const text = $(".mw-parser-output").text().replace(/\s+/g, " ");
  return { topic: page.title, summary: firstSentence(lead), branches: tree.slice(0, 12), text, lead };
}
