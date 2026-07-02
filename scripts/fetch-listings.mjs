// Harvest active StreetEasy studio/1BR rentals <= $3000 across all 5 NYC boroughs.
// StreetEasy sits behind PerimeterX, so a browser session cookie is REQUIRED.
// Provide it via env STREETEASY_COOKIE, or a `cookie.txt` file at repo root.
//
//   STREETEASY_COOKIE="$(cat cookie.txt)" node scripts/fetch-listings.mjs
//
// Writes data/raw/listings_raw.jsonl (one JSON listing node per line, deduped by id).
import { buildSearchRentalsQuery } from "streeteasy-api/dist/queries.js";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data/raw/listings_raw.jsonl");
const COOKIE = process.env.STREETEASY_COOKIE
  || (existsSync(join(ROOT, "cookie.txt")) && readFileSync(join(ROOT, "cookie.txt"), "utf8").trim());
if (!COOKIE) { console.error("Missing STREETEASY_COOKIE (or cookie.txt). See DATASET.md."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = {
  "Content-Type": "application/json", Origin: "https://streeteasy.com", Referer: "https://streeteasy.com/",
  "Apollographql-Client-Name": "srp-frontend-service",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  Cookie: COOKIE,
};

async function search(filters, page, perPage) {
  const query = buildSearchRentalsQuery({
    sorting: { attribute: "LISTED_AT", direction: "DESCENDING" }, adStrategy: "NONE",
    filters, perPage, page, userSearchToken: "00000000-0000-4000-8000-000000000000",
  });
  const backoffs = [3000, 6000, 12000, 20000, 30000, 45000];
  for (let t = 0; t <= backoffs.length; t++) {
    try {
      const res = await fetch("https://api-v6.streeteasy.com/", { method: "POST", headers: HEADERS, body: JSON.stringify({ query }) });
      if (res.status === 200) { const j = await res.json(); if (!j.errors) return j.data.searchRentals; if (t === backoffs.length) throw new Error(JSON.stringify(j.errors).slice(0, 150)); }
      else if (t === backoffs.length) throw new Error("HTTP " + res.status + " (session/cookie expired?)");
    } catch (e) { if (t === backoffs.length) throw e; }
    process.stdout.write(` [retry ${t + 1}] `);
    await sleep(backoffs[t]);
  }
}

const BOROS = [["staten_island", 500], ["bronx", 200], ["manhattan", 100], ["queens", 400], ["brooklyn", 300]];
const base = { rentalStatus: "ACTIVE", price: { lowerBound: null, upperBound: 3000 }, bedrooms: { lowerBound: 0, upperBound: 1 } };
const PER = 200;

const seen = new Set();
writeFileSync(OUT, "");
let grand = 0;
for (const [name, code] of BOROS) {
  const first = await search({ ...base, areas: [code] }, 1, PER);
  const pages = Math.min(Math.ceil(first.totalCount / PER) + 1, 30);
  for (let p = 1; p <= pages; p++) {
    const r = p === 1 ? first : await search({ ...base, areas: [code] }, p, PER);
    const edges = r.edges || [];
    let added = 0;
    for (const e of edges) {
      const n = e.node;
      if (n && !seen.has(n.id)) { seen.add(n.id); n.__borough = name; n.__edgeType = e.__typename; appendFileSync(OUT, JSON.stringify(n) + "\n"); added++; grand++; }
    }
    process.stdout.write(`\r${name} p${p}/${pages} +${added} | total=${grand}        `);
    if (edges.length < PER) break;
    await sleep(1200 + Math.floor(Math.random() * 1000));
  }
  console.log(`\n${name}: totalCount=${first.totalCount}`);
  await sleep(1500);
}
console.log(`\nDONE. ${grand} unique listings -> ${OUT}`);
