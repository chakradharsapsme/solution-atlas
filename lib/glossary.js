// Rule-based glossary harvesting. No AI: acronym patterns, definition sentences, <dl>, bold leads, glossary tables.
const CONNECT = new Set(["of", "and", "for", "to", "the", "in", "on", "&", "a", "an", "with", "by"]);
const BAD_SUBJECT = /^(this|that|these|those|it|there|here|you|we|they|he|she|which|what|who|the following|each|every|some|all|any|one|note|example|if|when|for|in|on|as|sap|figure|table|step|see)\b/i;

const CATS = [
  ["Integration", /integrat|gateway|\bapi\b|idoc|odata|interface|network|middleware|cig|cpi|connect|synchroni|replicat/i],
  ["Process", /order|requisition|approv|invoice|receipt|payment|sourcing|event|auction|quote|contract|workflow|process|request/i],
  ["Master data", /supplier|vendor|material|commodity|catalog|master|unspsc|price|currency|unit of measure|plant|company code/i],
  ["Admin", /parameter|configur|setting|role|group|permission|user|admin|authori|site|template|rule/i],
  ["Technology", /cloud|btp|hana|server|database|sso|saml|security|mobile|platform|analytic|report/i],
  ["Commercial", /licen|subscription|pricing|edition|fee|spend|saving/i],
];
export const categorise = s => (CATS.find(([, re]) => re.test(s)) || ["General"])[0];

const sentencesOf = text => String(text || "").split(/\s*\n\s*|(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map(s => s.trim()).filter(s => s.length > 20 && s.length < 400);
const tidy = s => s.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
const cap = (s, n = 260) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

// "Cloud Integration Gateway (CIG)" -> {term, abbr}
export function acronyms(sentence) {
  const out = [];
  const re = /\(([A-Z][A-Za-z0-9&/-]{1,9})\)/g; let m;
  while ((m = re.exec(sentence))) {
    const abbr = m[1].replace(/s$/, "");
    const letters = abbr.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (letters.length < 2 || letters.length > 8 || !/[A-Z]{2}/.test(abbr)) continue;
    const before = sentence.slice(0, m.index).trim().split(/\s+/).slice(-12);
    const picked = []; let need = letters.length;
    for (let i = before.length - 1; i >= 0 && need > 0; i--) {
      const w = before[i].replace(/[^\w&/-]/g, "");
      if (!w) break;
      picked.unshift(w);
      if (!CONNECT.has(w.toLowerCase())) need -= Math.max(1, (w.match(/[A-Z]/g) || []).length > 1 && w === w.toUpperCase() ? w.length : 1);
    }
    while (picked.length && CONNECT.has(picked[0].toLowerCase())) picked.shift();
    if (!picked.length) continue;
    const initials = picked.filter(w => !CONNECT.has(w.toLowerCase())).map(w => w[0].toUpperCase()).join("");
    if (initials[0] !== letters[0]) continue;
    const common = [...letters].filter(c => initials.includes(c)).length;
    if (common / letters.length < 0.6) continue;
    out.push({ term: picked.join(" "), abbr });
  }
  return out;
}

// "Guided buying is a simplified ..." -> {term, definition}
export function isADefinition(sentence) {
  const m = sentence.match(/^([A-Z][\w-]*(?:\s+(?:[A-Za-z][\w-]*|&|of|and|for)){0,4}?)\s+(?:\([^)]{1,15}\)\s+)?(is|are|refers to|means)\s+(an?|the|to|you|users|a set of)?\b/);
  if (!m) return null;
  const term = m[1].trim();
  if (BAD_SUBJECT.test(term) || term.split(" ").length > 5 || term.length < 3) return null;
  const tw = term.toLowerCase().split(" "); if (new Set(tw).size < tw.length) return null;
  if (/^(after|before|once|until|while|since|because|although|configure|configuring|select|choose|click|enter|use|using|comments?|documents?|fields?|full|high-level|these|those|such|users?|customers?|requests?|items?|values?|steps?|following|other|another|both|either|more|most|many|several|only|also|then|now|currently|by default)\b/i.test(term)) return null;
  if (/\b(that|which|who|whom|whose|there|this|these|those|what|how|where|when|why)$/i.test(term)) return null;
  return { term, definition: sentence };
}

export function harvest(docs, { query = "", limit = 40 } = {}) {
  const map = new Map();
  const add = (t, how, weight, url) => {
    let term = tidy(t.term).replace(/[:.,;]+$/, "").replace(/^(a|an|the)\s+/i, "");
    if (!term || term.length > 60 || /^\d+$/.test(term)) return;
    const key = term.toLowerCase();
    const cur = map.get(key) || { term, abbr: "", definition: "", score: 0, url: "", hows: new Set() };
    cur.score += weight; cur.hows.add(how);
    if (t.abbr && !cur.abbr) cur.abbr = t.abbr;
    const d = tidy(t.definition || "");
    if (d && (!cur.definition || (how !== "isa" && cur.hows.size === 1) || (d.length > cur.definition.length && d.length < 300))) { cur.definition = cap(d); cur.url = url || cur.url; }
    if (!cur.url) cur.url = url || "";
    map.set(key, cur);
  };

  const corpus = [];
  for (const d of docs) {
    const url = d.url;
    for (const x of d.defs || []) add(x, x.how, { table: 6, dl: 6, bold: 3, abbr: 3 }[x.how] || 2, url);
    for (const x of d.terms || []) add({ term: x.term, definition: x.definition || "" }, "toc", 3.5, x.url || url);
    for (const s of sentencesOf(d.text)) {
      corpus.push(s);
      for (const a of acronyms(s)) add({ ...a, definition: s }, "acronym", 4, url);
      const isa = isADefinition(s); if (isa) add(isa, "isa", 2, url);
    }
    for (const s of sentencesOf(d.snippet)) {
      corpus.push(s);
      for (const a of acronyms(s)) add({ ...a, definition: s }, "acronym", 3, url);
      const isa = isADefinition(s); if (isa) add(isa, "isa", 1.5, url);
    }
  }

  // Frequency boost: terms used often across the sources are more central.
  const all = corpus.join(" ").toLowerCase();
  const q = query.toLowerCase();
  for (const t of map.values()) {
    const needle = t.term.toLowerCase();
    let n = 0, i = -1; while ((i = all.indexOf(needle, i + 1)) !== -1 && n < 30) n++;
    if (t.abbr) { const re = new RegExp("\\b" + t.abbr.replace(/[^\w]/g, "") + "\\b", "g"); n += Math.min(20, (corpus.join(" ").match(re) || []).length); }
    t.score += Math.log2(1 + n); t.freq = n;
    if (needle === q) t.score += 3;
    if (!t.definition) t.score -= 2;
  }

  return [...map.values()]
    .filter(t => t.score > 2.5 && !(t.hows.size === 1 && t.hows.has("isa") && (!t.term.includes(" ") || t.freq < 2)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(t => ({ term: t.term[0].toUpperCase() + t.term.slice(1), abbr: t.abbr, definition: t.definition, category: categorise(t.term + " " + t.definition), url: t.url, evidence: [...t.hows] }));
}
