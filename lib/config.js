// Central configuration. Everything can be overridden with environment variables (see .env.example).
import fs from "node:fs";
import path from "node:path";

// Minimal .env loader so the app runs without extra dependencies.
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const list = (v, d) => (v ? v.split(",").map(s => s.trim()).filter(Boolean) : d);

export const config = {
  port: Number(process.env.PORT || 3000),

  // Search providers (use one or both). Wikipedia is always available and free.
  braveKey: process.env.BRAVE_API_KEY || "",
  searxngUrl: (process.env.SEARXNG_URL || "").replace(/\/$/, ""),
  // "fixtures" = offline demo data, used by the tests and for UI work without network.
  provider: process.env.PROVIDER || "auto",

  // Official SAP domains. Search is restricted to these; anything else is marked unverified.
  sapDomains: list(process.env.SAP_DOMAINS, [
    "help.sap.com", "learning.sap.com", "community.sap.com", "api.sap.com", "www.sap.com",
  ]),
  officialDomains: list(process.env.OFFICIAL_DOMAINS, [
    "help.sap.com", "sap.com", "community.sap.com", "learning.sap.com", "api.sap.com", "support.sap.com",
    "me.sap.com", "developers.sap.com", "discovery-center.cloud.sap", "roadmaps.sap.com", "news.sap.com",
    "wikipedia.org",
  ]),

  // Crawling limits
  resultsPerDomain: Number(process.env.RESULTS_PER_DOMAIN || 10),
  pagesToRead: Number(process.env.PAGES_TO_READ || 8),
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS || 9000),
  maxBytes: Number(process.env.MAX_BYTES || 8 * 1024 * 1024),
  userAgent: process.env.USER_AGENT || "SolutionAtlas/1.0 (+https://example.com/solution-atlas; knowledge mind-map tool)",
  respectRobots: process.env.RESPECT_ROBOTS !== "false",

  // Cache
  cacheDir: process.env.CACHE_DIR || path.resolve(process.cwd(), ".cache"),
  cacheTtlHours: Number(process.env.CACHE_TTL_HOURS || 168),
};

export function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ""; }
}
export function isOfficial(u) {
  const h = hostOf(u);
  return !!h && config.officialDomains.some(d => h === d || h.endsWith("." + d));
}
export function sourceType(u) {
  const h = hostOf(u);
  if (h.startsWith("help.") || h.startsWith("support.") || h.startsWith("me.")) return "official";
  if (h.startsWith("learning.") || h.startsWith("developers.") || h.startsWith("training.")) return "learning";
  if (h.startsWith("community.") || h.startsWith("blogs.")) return "community";
  if (h.startsWith("api.") || h.includes("discovery-center")) return "api";
  if (h.startsWith("roadmaps.") || h.startsWith("news.")) return "roadmap";
  if (h.endsWith("wikipedia.org")) return "reference";
  return "product";
}
