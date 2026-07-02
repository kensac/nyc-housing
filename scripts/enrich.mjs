// Enrich harvested StreetEasy listings with BBL/BIN, violations (detail + aggregate),
// and nearest subway + train lines. Emits per-listing JSON + flat CSVs.
//
//   node scripts/enrich.mjs
//
// Reads : data/raw/listings_raw.jsonl
// Writes: data/listings/<bbl>-<unit>.json, data/listings.csv, data/violations.csv,
//         data/dataset_meta.json  (+ caches under data/_cache, data/stations)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Cache, round, sleep } from "./lib/util.mjs";
import { resolveAddress } from "./lib/geosearch.mjs";
import { fetchAllViolations } from "./lib/violations.mjs";
import { loadEntrances, nearestStations } from "./lib/subway.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const D = (p) => join(ROOT, p);
const SCHEMA_VERSION = "2.0";
const GENERATED_AT = process.env.GENERATED_AT || "2026-07-02T00:00:00Z";

const log = (...a) => console.log(...a);
const buildingSlug = (urlPath) => (urlPath?.match(/\/building\/([^/]+)/)?.[1]) || null;
const unitSlug = (u) => (u || "na").toString().toLowerCase().replace(/[^a-z0-9]+/g, "") || "na";
const csvCell = (v) => {
  if (v == null) return "";
  const s = Array.isArray(v) ? v.join("|") : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvRow = (cells) => cells.map(csvCell).join(",");

async function main() {
  const rawPath = process.env.RAW_PATH ? process.env.RAW_PATH : D("data/raw/listings_raw.jsonl");
  let raw = readFileSync(rawPath, "utf8").trim().split("\n").map(JSON.parse);
  if (process.env.LIMIT) raw = raw.slice(0, parseInt(process.env.LIMIT, 10));
  log(`Loaded ${raw.length} raw listings.`);

  // 1) Resolve address -> bbl/bin/coords, deduped by building.
  const geoCache = new Cache(D("data/_cache/geosearch.json"));
  const slugGeo = new Map(); // building slug -> geo result
  let gi = 0;
  for (const l of raw) {
    const slug = buildingSlug(l.urlPath);
    const cacheKey = slug || `${l.street}|${l.__borough}`;
    if (!slugGeo.has(cacheKey)) {
      const g = await resolveAddress(l.street, l.__borough, geoCache);
      slugGeo.set(cacheKey, g);
      if (++gi % 100 === 0) log(`  geosearch ${gi} buildings...`);
    }
  }
  geoCache.flush();
  log(`Geocoded ${slugGeo.size} distinct buildings.`);

  // attach geo to each listing
  for (const l of raw) {
    const slug = buildingSlug(l.urlPath);
    l.__geo = slugGeo.get(slug || `${l.street}|${l.__borough}`) || {};
    l.__lat = l.__geo.lat ?? l.geoPoint?.latitude ?? null;
    l.__lon = l.__geo.lon ?? l.geoPoint?.longitude ?? null;
  }

  // 2) Violations (batched) for distinct buildings with a bbl.
  const buildings = [...new Map(raw.filter((l) => l.__geo.bbl)
    .map((l) => [l.__geo.bbl, { bbl: l.__geo.bbl, bin: l.__geo.bin }])).values()];
  log(`Fetching violations for ${buildings.length} distinct BBLs...`);
  const viol = await fetchAllViolations(buildings, log);

  // 3) Subway entrances (cached once).
  const entrances = await loadEntrances(D("data/stations/mta_subway_entrances.json"));
  log(`Loaded ${entrances.length} subway entrances.`);

  // 4) Build per-listing records + CSV rows.
  // wipe previously generated per-listing files (fresh run)
  mkdirSync(D("data/listings"), { recursive: true });
  for (const f of readdirSync(D("data/listings"))) if (f.endsWith(".json")) unlinkSync(D(`data/listings/${f}`));

  const listingCols = ["listing_id","borough","neighborhood","address","unit","zip","rent","net_effective_rent","gross_over_3000","no_fee","beds","baths","sqft","building_type","status","available_date","price_changed_at","latitude","longitude","bbl","bin","nearest_station","nearest_lines","nearest_dist_mi","nearest_walk_min","all_nearby_lines","hpd_total","hpd_open","hpd_open_class_c","hpd_rent_impairing_open","ecb_total","ecb_active","ecb_penalty_total","ecb_balance_due","dob_total","dob_open","source_url"];
  const violCols = ["listing_id","bbl","bin","address","unit","source","violation_id","class_or_severity","status","is_open","date","penalty_imposed","balance_due","apartment","description"];
  const listingRows = [listingCols.join(",")];
  const violRows = [violCols.join(",")];

  let written = 0, noBbl = 0;
  const usedNames = new Set();
  for (const l of raw) {
    const g = l.__geo;
    const near = nearestStations(l.__lat, l.__lon, entrances, 3);
    const v = (g.bbl && viol.get(g.bbl)) || { hpd: [], ecb: [], dob: [], summary: {} };
    const s = v.summary || {};
    const baths = (l.fullBathroomCount || 0) + 0.5 * (l.halfBathroomCount || 0);
    const sqft = l.livingAreaSize && l.livingAreaSize > 0 ? l.livingAreaSize : null;
    const allLines = [...new Set(near.flatMap((n) => n.lines))];
    const sourceUrl = `https://streeteasy.com${l.urlPath || ""}`;

    const rec = {
      schema_version: SCHEMA_VERSION,
      generated_at: GENERATED_AT,
      listing_id: l.id,
      source: "streeteasy",
      source_url: sourceUrl,
      borough: l.__borough,
      neighborhood: l.areaName || null,
      address: l.street,
      unit: l.unit || null,
      zip: g.zip || null,
      bbl: g.bbl || null,
      bin: g.bin || null,
      geocode_match: g.matched || null,
      latitude: l.__lat,
      longitude: l.__lon,
      // pricing
      rent: l.price,                          // gross monthly asking
      net_effective_rent: l.netEffectivePrice ?? null,
      gross_over_3000: l.price > 3000,        // leaked in via net-effective filter
      no_fee: !!l.noFee,
      months_free: l.monthsFree ?? null,
      lease_term_months: l.leaseTermMonths ?? null,
      price_delta: l.priceDelta ?? null,
      price_changed_at: l.priceChangedAt || null,
      // unit
      beds: l.bedroomCount,
      unit_type: l.bedroomCount === 0 ? "studio" : `${l.bedroomCount}BR`,
      baths,
      sqft,
      building_type: l.buildingType || null,
      status: l.status || null,
      available_date: l.availableAt || null,
      // transit
      transit: {
        nearest_station: near[0]?.station || null,
        nearest_lines: near[0]?.lines || [],
        nearest_distance_mi: near[0]?.distance_mi ?? null,
        nearest_walk_min: near[0]?.walk_min ?? null,
        all_nearby_lines: allLines,
        stations: near,
        note: "Distances are straight-line miles from the building to the nearest entrance of each station; walk_min ≈ 20 min/mi.",
      },
      // violations
      violations: {
        summary: s,
        hpd: v.hpd,
        ecb: v.ecb,
        dob: v.dob,
      },
      data_sources: {
        listing: "StreetEasy GraphQL (api-v6)",
        geocode_bbl_bin: "NYC Planning GeoSearch v2",
        hpd: "NYC OpenData wvxf-dwi5",
        ecb: "NYC OpenData 6bgk-3dad",
        dob: "NYC OpenData 3h2n-5cm9",
        subway: "MTA i9wp-a4ja (Subway Entrances and Exits)",
      },
    };

    let fname = g.bbl ? `${g.bbl}-${unitSlug(l.unit)}.json` : `nobbl-se${l.id}.json`;
    if (usedNames.has(fname)) fname = fname.replace(/\.json$/, `-se${l.id}.json`); // disambiguate collisions
    usedNames.add(fname);
    rec.file = fname;
    if (!g.bbl) noBbl++;
    writeFileSync(D(`data/listings/${fname}`), JSON.stringify(rec, null, 2));
    written++;

    listingRows.push(csvRow([
      l.id, l.__borough, l.areaName, l.street, l.unit, g.zip, l.price, l.netEffectivePrice,
      l.price > 3000, l.noFee, l.bedroomCount, baths, sqft, l.buildingType, l.status, l.availableAt,
      l.priceChangedAt, l.__lat, l.__lon, g.bbl, g.bin,
      near[0]?.station, near[0]?.lines, near[0]?.distance_mi, near[0]?.walk_min, allLines,
      s.hpd_total ?? 0, s.hpd_open ?? 0, s.hpd_open_class_c ?? 0, s.hpd_rent_impairing_open ?? 0,
      s.ecb_total ?? 0, s.ecb_active ?? 0, s.ecb_penalty_total ?? 0, s.ecb_balance_due ?? 0,
      s.dob_total ?? 0, s.dob_open ?? 0, sourceUrl,
    ]));

    for (const hv of v.hpd) violRows.push(csvRow([l.id, g.bbl, g.bin, l.street, l.unit, "HPD", hv.violation_id, hv.class, hv.status, hv.is_open, hv.inspection_date, "", "", hv.apartment, hv.description]));
    for (const ev of v.ecb) violRows.push(csvRow([l.id, g.bbl, g.bin, l.street, l.unit, "ECB", ev.violation_id, ev.severity, ev.status, ev.is_open, ev.issue_date, ev.penalty_imposed, ev.balance_due, "", ev.description || ev.violation_type]));
    for (const dv of v.dob) violRows.push(csvRow([l.id, g.bbl, g.bin, l.street, l.unit, "DOB", dv.violation_id, "", dv.category, dv.is_open, dv.issue_date, "", "", "", dv.description || dv.violation_type]));
  }

  writeFileSync(D("data/listings.csv"), listingRows.join("\n") + "\n");
  writeFileSync(D("data/violations.csv"), violRows.join("\n") + "\n");

  const withBbl = raw.filter((l) => l.__geo.bbl).length;
  const meta = {
    schema_version: SCHEMA_VERSION,
    generated_at: GENERATED_AT,
    query: { platform: "StreetEasy", status: "ACTIVE", price_upper_bound_net_effective: 3000, bedrooms: "studio or 1BR (0-1)", areas: "all 5 NYC boroughs" },
    counts: {
      listings: raw.length,
      listings_with_bbl: withBbl,
      listings_without_bbl: raw.length - withBbl,
      distinct_buildings: buildings.length,
      gross_over_3000: raw.filter((l) => l.price > 3000).length,
      violation_rows: violRows.length - 1,
    },
    sources: { hpd: "wvxf-dwi5", ecb: "6bgk-3dad", dob: "3h2n-5cm9", geocode: "planninglabs geosearch v2", subway: "i9wp-a4ja" },
  };
  writeFileSync(D("data/dataset_meta.json"), JSON.stringify(meta, null, 2));
  log(`\nWrote ${written} listing files (${noBbl} without BBL).`);
  log(`listings.csv rows=${listingRows.length - 1}, violations.csv rows=${violRows.length - 1}`);
  log(JSON.stringify(meta.counts, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
