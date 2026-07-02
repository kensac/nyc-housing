// Shared helpers: resilient fetch, disk cache, haversine, borough maps.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Borough code <-> name. StreetEasy urlPath uses "staten_island"; Socrata uses 1..5.
export const BORO_CODE = { manhattan: 1, bronx: 2, brooklyn: 3, queens: 4, staten_island: 5 };
export const BORO_NAME = { 1: "manhattan", 2: "bronx", 3: "brooklyn", 4: "queens", 5: "staten_island" };
// MTA `borough` field uses single letters.
export const MTA_BORO = { M: "manhattan", Bx: "bronx", Bk: "brooklyn", Q: "queens", SI: "staten_island" };

// Resilient JSON fetch with retry + exponential backoff. Returns parsed JSON.
export async function fetchJSON(url, { tries = 5, headers = {}, timeoutMs = 30000 } = {}) {
  const backoffs = [1000, 2500, 5000, 10000, 20000];
  let lastErr;
  for (let t = 0; t <= tries; t++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(to);
      if (res.status === 200) return await res.json();
      // 429/5xx are transient; 4xx (other) usually not, but retry a couple times anyway.
      lastErr = new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
    }
    if (t < tries) await sleep(backoffs[Math.min(t, backoffs.length - 1)]);
  }
  throw lastErr;
}

// Great-circle distance in miles.
export function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line miles -> walking minutes at ~3 mph (20 min/mi). Approximate.
export const walkMin = (mi) => Math.round(mi * 20);

// Simple JSON file cache keyed by string.
export class Cache {
  constructor(path) {
    this.path = path;
    this.map = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    this.dirty = 0;
  }
  has(k) { return Object.prototype.hasOwnProperty.call(this.map, k); }
  get(k) { return this.map[k]; }
  set(k, v) { this.map[k] = v; this.dirty++; if (this.dirty % 25 === 0) this.flush(); return v; }
  flush() { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.map)); }
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Round to n decimals.
export const round = (x, n = 2) => (x == null ? null : Math.round(x * 10 ** n) / 10 ** n);
