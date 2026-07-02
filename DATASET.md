# NYC Rentals + Violations dataset (studio / 1BR ≤ $3,000)

A snapshot of active StreetEasy studio and 1-bedroom rentals across all five NYC
boroughs at or under **$3,000/month**, enriched with building violations (HPD /
ECB / DOB) and nearest-subway data. Built to be analyzed, not just read.

## How it was built

```
StreetEasy GraphQL search  ──►  data/raw/listings_raw.jsonl   (scripts/fetch-listings.mjs)
        │  address + rent + beds + coords per listing
        ▼
NYC Planning GeoSearch      ──►  bbl + bin + coordinates       (scripts/lib/geosearch.mjs)
        ▼
Socrata violations (HPD/ECB/DOB) + MTA subway entrances        (scripts/enrich.mjs)
        ▼
data/listings/<bbl>-<unit>.json   +   data/listings.csv   +   data/violations.csv
```

- **Listings**: StreetEasy `searchRentals`, `rentalStatus: ACTIVE`, `price.upperBound = 3000`
  (StreetEasy applies this to *net-effective* rent), `bedrooms: 0–1`, all 5 borough areas.
  Paginated per borough and de-duplicated by listing id.
- **BBL/BIN**: [NYC Planning GeoSearch v2](https://geosearch.planninglabs.nyc) (free, no key),
  one lookup per building, cached in `data/_cache/geosearch.json`.
- **Violations**: NYC OpenData (Socrata). HPD joined by `bbl`; ECB & DOB joined by `bin`
  (avoids block/lot zero-padding pitfalls). Queried in batches of 50 buildings.
  - HPD Housing Maintenance Code Violations — `wvxf-dwi5`
  - ECB / OATH Violations — `6bgk-3dad`
  - DOB Violations (non-ECB) — `3h2n-5cm9`
- **Subway**: MTA "Subway Entrances and Exits" (`i9wp-a4ja`) — nearest entrance per station,
  straight-line distance, `daytime_routes` = the train lines. Cached in `data/stations/`.

## Files

| File | Grain | Use it for |
|------|-------|-----------|
| `data/listings.csv` | one row per listing | Spreadsheet / pandas: filter by rent, borough, violation counts, train lines. **Aggregates.** |
| `data/violations.csv` | one row per individual violation | Drill into specific violations (class, status, date, penalty, description). **Details.** |
| `data/listings/<bbl>-<unit>.json` | one file per listing | Full nested record: listing + transit + violation summary + every violation. |
| `data/dataset_meta.json` | — | Query parameters, counts, source dataset ids, generated timestamp. |
| `data/raw/listings_raw.jsonl` | one line per listing | Untouched StreetEasy search output (provenance). |

## `listings.csv` columns

`listing_id, borough, neighborhood, address, unit, zip, rent, net_effective_rent,
gross_over_3000, no_fee, beds, baths, sqft, building_type, status, available_date,
price_changed_at, latitude, longitude, bbl, bin, nearest_station, nearest_lines,
nearest_dist_mi, nearest_walk_min, all_nearby_lines, hpd_total, hpd_open,
hpd_open_class_c, hpd_rent_impairing_open, ecb_total, ecb_active, ecb_penalty_total,
ecb_balance_due, dob_total, dob_open, source_url`

- `rent` = gross monthly asking. `net_effective_rent` = after concessions (what StreetEasy filtered on).
- `gross_over_3000 = true` marks listings whose asking rent exceeds $3,000 but whose
  *net-effective* rent is ≤ $3,000 (they matched StreetEasy's filter).
- Multi-value fields (`nearest_lines`, `all_nearby_lines`) are `|`-separated.

## `violations.csv` columns

`listing_id, bbl, bin, address, unit, source, violation_id, class_or_severity,
status, is_open, date, penalty_imposed, balance_due, apartment, description`

- `source` ∈ {HPD, ECB, DOB}.
- HPD `class_or_severity`: **A** non-hazardous · **B** hazardous · **C** immediately
  hazardous · **I** informational. `status` = Open/Close.
- ECB: `class_or_severity` = severity; `status` = ACTIVE/RESOLVE; `penalty_imposed` /
  `balance_due` in dollars.
- DOB: `status` = DOB violation category (e.g. `V-DOB VIOLATION - ACTIVE` / `... DISMISSED`).

### Signals worth sorting on
- `hpd_open_class_c` — open *immediately hazardous* violations (heat, no hot water, vermin, lead).
- `hpd_rent_impairing_open` — open rent-impairing violations.
- `ecb_active` / `ecb_balance_due` — unresolved DOB/ECB fines and money owed.

## Reproduce

```bash
# 1. Harvest listings (needs a StreetEasy session cookie — bot-walled otherwise)
STREETEASY_COOKIE="$(cat cookie.txt)" node scripts/fetch-listings.mjs
# 2. Enrich (no auth needed; caches make re-runs cheap)
SOCRATA_APP_TOKEN=optional node scripts/enrich.mjs
```

## Caveats
- Subway distances are **straight-line** to the nearest station entrance; `walk_min ≈ 20 min/mi`
  is an estimate, not routed walking time.
- Violation records are the public city snapshot as of the generated date; HPD/DOB update daily.
- DOB "open" is inferred from the violation category text; refer to the raw category for edge cases.
- A small number of listings may fail to geocode to a BBL; those are written as `nobbl-se<id>.json`
  and have empty violation fields. (In this snapshot all 1,613 resolved to a BBL.)
- **`no_fee` is unreliable** — StreetEasy's *search* endpoint returns `false` for every listing
  (it is only populated in the per-listing detail query). Use `net_effective_rent` and
  `months_free` (both reliable here) to reason about concessions instead.
- `violations.csv` is keyed by listing, so buildings with several listed units repeat their
  violation rows once per unit. De-duplicate on `bbl` for building-level violation analysis.
