// Nearest subway stations + train lines for a coordinate.
// Source: MTA "Subway Entrances and Exits" (data.ny.gov, i9wp-a4ja) — has entrance
// coordinates + `daytime_routes` (the trains). Entrances give a better walk estimate
// than station centroids. We collapse entrances to distinct stations (by stop_name+routes).
import { fetchJSON, haversineMi, walkMin, round } from "./util.mjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STATIONS_URL =
  "https://data.ny.gov/resource/i9wp-a4ja.json?$select=stop_name,daytime_routes,borough,entrance_latitude,entrance_longitude&$limit=50000";

// Load entrances (cached to disk). Returns array of {name, routes:[...], lat, lon, borough}.
export async function loadEntrances(cachePath) {
  if (cachePath && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));
  const rows = await fetchJSON(STATIONS_URL, { tries: 5 });
  const ents = rows
    .filter((r) => r.entrance_latitude && r.entrance_longitude)
    .map((r) => ({
      name: r.stop_name,
      routes: (r.daytime_routes || "").trim().split(/\s+/).filter(Boolean),
      lat: parseFloat(r.entrance_latitude),
      lon: parseFloat(r.entrance_longitude),
      borough: r.borough || null,
    }));
  if (cachePath) writeFileSync(cachePath, JSON.stringify(ents));
  return ents;
}

// Return up to `top` nearest DISTINCT stations for a point.
export function nearestStations(lat, lon, entrances, top = 3) {
  if (lat == null || lon == null) return [];
  const scored = entrances.map((e) => ({ e, d: haversineMi(lat, lon, e.lat, e.lon) }));
  scored.sort((a, b) => a.d - b.d);
  const seen = new Set();
  const out = [];
  for (const { e, d } of scored) {
    const key = e.name + "|" + e.routes.join("");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      station: e.name,
      lines: e.routes,
      distance_mi: round(d, 3),
      walk_min: walkMin(d),
    });
    if (out.length >= top) break;
  }
  return out;
}
