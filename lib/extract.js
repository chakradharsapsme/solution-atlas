// Turn fetched HTML or PDF into structure (headings / outline) and plain text.
import * as cheerio from "cheerio";

const clean = s => String(s || "").replace(/\s+/g, " ").replace(/[¶#]\s*$/, "").trim();
const TITLE_SUFFIX = /\s*[|–—-]\s*(SAP Help Portal|SAP Community|SAP Learning|SAP Business Accelerator Hub|SAP|Wikipedia)\s*$/i;
export const cleanTitle = t => clean(t).replace(TITLE_SUFFIX, "").replace(TITLE_SUFFIX, "");

export function readHtml(buf, url = "") {
  const $ = cheerio.load(buf.toString("utf8"));
  $("script,style,noscript,svg,nav,header,footer,aside,form,iframe,[role=navigation],[aria-hidden=true],.breadcrumb,.cookie,#cookie").remove();
  const title = cleanTitle($("meta[property='og:title']").attr("content") || $("title").first().text() || $("h1").first().text());
  const description = clean($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "");
  const root = $("main").length ? $("main").first() : $("article").length ? $("article").first() : $("body");

  const headings = [];
  root.find("h1,h2,h3,h4").each((_, el) => {
    const text = clean($(el).text());
    if (text && text.length <= 90 && !/^(contents|table of contents|related|see also|references|feedback|share|on this page|in this article)$/i.test(text))
      headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  const defs = [];
  root.find("dl").each((_, dl) => {
    $(dl).find("dt").each((__, dt) => {
      const dd = $(dt).nextAll("dd").first();
      const term = clean($(dt).text()), def = clean(dd.text());
      if (term && def && term.length < 60) defs.push({ term, definition: def, how: "dl" });
    });
  });
  root.find("abbr[title]").each((_, a) => {
    const abbr = clean($(a).text()), full = clean($(a).attr("title"));
    if (abbr && full && abbr.length <= 10) defs.push({ term: full, abbr, definition: "", how: "abbr" });
  });
  // "**Term**: definition" and "**Term** – definition" patterns in lists and paragraphs
  root.find("li,p").each((_, el) => {
    const lead = $(el).children("strong,b").first();
    if (!lead.length) return;
    const term = clean(lead.text());
    const rest = clean($(el).text()).slice(term.length).replace(/^\s*[:–—-]\s*/, "");
    const hadSep = /^\s*[:–—-]/.test(clean($(el).text()).slice(term.length));
    if (hadSep && term.length > 1 && term.length < 60 && rest.length > 15) defs.push({ term, definition: rest, how: "bold" });
  });
  // Glossary-style tables: first column term, second column definition
  root.find("table").each((_, tb) => {
    const head = clean($(tb).find("tr").first().text()).toLowerCase();
    if (!/term|glossary|abbreviation|definition|meaning/.test(head)) return;
    $(tb).find("tr").slice(1).each((__, tr) => {
      const c = $(tr).find("td"); if (c.length < 2) return;
      const term = clean($(c[0]).text()), def = clean($(c[1]).text());
      if (term && def && term.length < 60) defs.push({ term, definition: def, how: "table" });
    });
  });

  // Keep block boundaries so sentences and headings don't run together.
  root.find("br").replaceWith(" ");
  root.find("h1,h2,h3,h4,h5,h6,dt,th,td,li").each((_, e) => { const t = $(e).text().trim(); if (t && !/[.!?:]$/.test(t)) $(e).append(". "); else $(e).append(" "); });
  root.find("p,div,section,dd,tr,ul,ol,table").each((_, e) => { $(e).prepend(" "); $(e).append(" "); });
  const text = clean(root.text()).replace(/\.\s*\./g, ".").slice(0, 200000);
  return { kind: "html", url, title, description, headings, defs, text };
}

// ---- PDF: outline (bookmarks) is the best mind map an official guide can give us ----
let pdfjs = null;
export async function readPdf(buf, url = "", { maxPages = 80 } = {}) {
  pdfjs ||= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const title = clean(meta?.info?.Title || "");
  const outlineRaw = (await doc.getOutline().catch(() => null)) || [];
  const conv = (items, depth) => items.slice(0, 40).map(i => ({ text: clean(i.title), depth, items: depth < 4 ? conv(i.items || [], depth + 1) : [] })).filter(i => i.text);
  const outline = conv(outlineRaw, 1);
  let text = "";
  const n = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    text += " " + tc.items.map(i => i.str + (i.hasEOL ? "\n" : "")).join(" ");
    if (text.length > 300000) break;
  }
  await doc.destroy();
  return { kind: "pdf", url, title, description: "", outline, headings: [], defs: [], text: text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim(), pages: doc.numPages };
}

export async function readAny(res) {
  const head = res.buf.slice(0, 1024).toString("latin1");
  if (head.includes("%PDF-")) return readPdf(res.buf, res.url);
  if (res.type.includes("pdf") || /\.pdf($|\?)/i.test(res.url)) {
    const snippet = head.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw Object.assign(new Error(`The site sent back a web page instead of the PDF (${res.buf.length} bytes, "${res.type}"): ${snippet}`), { status: 502 });
  }
  return readHtml(res.buf, res.url);
}
