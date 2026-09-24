// Disk + memory cache so the same keyword never costs a second search.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const mem = new Map();
// Bump when the map/glossary rules change so old cached maps are rebuilt.
const VERSION = "v7|";
const keyFile = k => path.join(config.cacheDir, crypto.createHash("sha1").update(k).digest("hex") + ".json");

export function cacheGet(key) {
  key = VERSION + key;
  const ttl = config.cacheTtlHours * 3600e3;
  const m = mem.get(key);
  if (m && Date.now() - m.at < ttl) return m.value;
  try {
    const f = keyFile(key);
    const { at, value } = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Date.now() - at < ttl) { mem.set(key, { at, value }); return value; }
  } catch { /* miss */ }
  return null;
}

export function cacheSet(key, value) {
  key = VERSION + key;
  const rec = { at: Date.now(), value };
  mem.set(key, rec);
  if (mem.size > 500) mem.delete(mem.keys().next().value);
  try {
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(keyFile(key), JSON.stringify(rec));
  } catch { /* cache is best effort */ }
}

export async function cached(key, fn) {
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const v = await fn();
  cacheSet(key, v);
  return v;
}
