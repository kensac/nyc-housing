// Resolve a NYC street address -> { bbl, bin, lat, lon, zip } via NYC Planning GeoSearch.
// Docs: https://geosearch.planninglabs.nyc  (free, no key). We cache by address key.
import { fetchJSON, sleep } from "./util.mjs";

const BOROUGH_LABEL = {
  manhattan: "Manhattan", bronx: "Bronx", brooklyn: "Brooklyn",
  queens: "Queens", staten_island: "Staten Island",
};

export async function resolveAddress(street, borough, cache) {
  const key = `${street}||${borough}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const text = `${street}, ${BOROUGH_LABEL[borough] || ""}`.trim();
  const url = `https://geosearch.planninglabs.nyc/v2/search?size=1&text=${encodeURIComponent(text)}`;
  let result = { bbl: null, bin: null, lat: null, lon: null, zip: null, matched: null };
  try {
    const j = await fetchJSON(url, { tries: 4 });
    const f = j?.features?.[0];
    if (f) {
      const p = f.properties || {};
      const pad = p.addendum?.pad || {};
      result = {
        bbl: pad.bbl || null,
        bin: pad.bin && pad.bin !== "0000000" ? pad.bin : null,
        lat: f.geometry?.coordinates?.[1] ?? null,
        lon: f.geometry?.coordinates?.[0] ?? null,
        zip: p.postalcode || null,
        matched: p.label || null,
      };
    }
  } catch (e) {
    result.error = String(e.message || e).slice(0, 120);
  }
  cache.set(key, result);
  await sleep(120); // be polite to geosearch
  return result;
}
