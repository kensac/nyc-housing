// Fetch NYC building violations (DETAIL + AGGREGATE) for a set of buildings.
// Join keys (verified): HPD has `bbl`; ECB + DOB have `bin` (padding-free, reliable).
//   HPD  Housing Maintenance Code Violations : wvxf-dwi5  (data.cityofnewyork.us)
//   ECB/OATH Violations                      : 6bgk-3dad  (data.cityofnewyork.us)
//   DOB  Violations (non-ECB)                : 3h2n-5cm9  (data.cityofnewyork.us)
import { fetchJSON, sleep, chunk } from "./util.mjs";

const NYC = "https://data.cityofnewyork.us/resource";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN; // optional, raises rate limits
const hdr = APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {};
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const inList = (vals) => "(" + vals.map((v) => `'${String(v).replace(/'/g, "")}'`).join(",") + ")";

async function socrata(dataset, whereField, values, select) {
  const rows = [];
  for (const grp of chunk(values, 50)) {
    const where = `${whereField} in ${inList(grp)}`;
    const url = `${NYC}/${dataset}.json?$select=${encodeURIComponent(select)}&$where=${encodeURIComponent(where)}&$limit=50000`;
    const data = await fetchJSON(url, { tries: 5, headers: hdr });
    rows.push(...data);
    await sleep(200);
  }
  return rows;
}

// HPD detail -> normalized
function normHPD(r) {
  return {
    source: "HPD", violation_id: r.violationid, bbl: r.bbl, bin: r.bin,
    class: r.class || null,                       // A(non-hazard) B(hazard) C(immediately hazardous) I(info)
    status: r.violationstatus || null,            // Open / Close
    is_open: (r.violationstatus || "").toLowerCase() === "open",
    rent_impairing: r.rentimpairing === "Y",
    description: (r.novdescription || "").replace(/\s+/g, " ").trim() || null,
    apartment: r.apartment || null, story: r.story || null,
    inspection_date: r.inspectiondate || null,
    nov_issued_date: r.novissueddate || null,
    current_status: r.currentstatus || null,
    current_status_date: r.currentstatusdate || null,
  };
}
function normECB(r) {
  return {
    source: "ECB", violation_id: r.ecb_violation_number, bin: r.bin,
    status: r.ecb_violation_status || null,       // ACTIVE / RESOLVE
    is_open: (r.ecb_violation_status || "").toUpperCase() === "ACTIVE",
    severity: r.severity || null,
    violation_type: (r.violation_type || "").replace(/\s+/g, " ").trim() || null,
    description: (r.violation_description || r.section_law_description1 || "").replace(/\s+/g, " ").trim() || null,
    infraction_code: r.infraction_code1 || null,
    penalty_imposed: num(r.penality_imposed),
    amount_paid: num(r.amount_paid),
    balance_due: num(r.balance_due),
    issue_date: r.issue_date || null, hearing_status: r.hearing_status || null,
    respondent: r.respondent_name || null,
  };
}
function normDOB(r) {
  const cat = r.violation_category || "";
  return {
    source: "DOB", violation_id: r.violation_number || r.number, bin: r.bin,
    category: cat.replace(/\s+/g, " ").trim() || null,   // e.g. "V-DOB VIOLATION - ACTIVE" / "... DISMISSED"
    is_open: !/DISMISS|RESOLVE|CLOSED/i.test(cat) && cat !== "",
    violation_type: (r.violation_type || "").replace(/\s+/g, " ").trim() || null,
    type_code: r.violation_type_code || null,
    description: (r.description || "").replace(/\s+/g, " ").trim() || null,
    issue_date: r.issue_date || null,
    disposition_comments: (r.disposition_comments || "").replace(/\s+/g, " ").trim() || null,
  };
}

function summarize(hpd, ecb, dob) {
  const openC = hpd.filter((v) => v.is_open && v.class === "C");
  const maxDate = (arr, f) => arr.map((v) => v[f]).filter(Boolean).sort().slice(-1)[0] || null;
  return {
    hpd_total: hpd.length,
    hpd_open: hpd.filter((v) => v.is_open).length,
    hpd_class_a: hpd.filter((v) => v.class === "A").length,
    hpd_class_b: hpd.filter((v) => v.class === "B").length,
    hpd_class_c: hpd.filter((v) => v.class === "C").length,
    hpd_class_i: hpd.filter((v) => v.class === "I").length,
    hpd_open_class_c: openC.length,          // immediately hazardous, still open — key risk signal
    hpd_rent_impairing_open: hpd.filter((v) => v.is_open && v.rent_impairing).length,
    hpd_last_inspection: maxDate(hpd, "inspection_date"),
    ecb_total: ecb.length,
    ecb_active: ecb.filter((v) => v.is_open).length,
    ecb_penalty_total: Math.round(ecb.reduce((s, v) => s + v.penalty_imposed, 0)),
    ecb_balance_due: Math.round(ecb.reduce((s, v) => s + v.balance_due, 0)),
    dob_total: dob.length,
    dob_open: dob.filter((v) => v.is_open).length,
  };
}

// buildings: [{ bbl, bin }]. Returns Map keyed by bbl -> { hpd:[], ecb:[], dob:[], summary:{} }
export async function fetchAllViolations(buildings, log = () => {}) {
  const bbls = [...new Set(buildings.map((b) => b.bbl).filter(Boolean))];
  const bins = [...new Set(buildings.map((b) => b.bin).filter(Boolean))];
  const binToBbl = new Map();
  for (const b of buildings) if (b.bin && b.bbl && !binToBbl.has(b.bin)) binToBbl.set(b.bin, b.bbl);

  log(`  HPD: ${bbls.length} bbls...`);
  const hpdRows = (await socrata("wvxf-dwi5", "bbl", bbls,
    "violationid,bbl,bin,class,violationstatus,rentimpairing,novdescription,apartment,story,inspectiondate,novissueddate,currentstatus,currentstatusdate")).map(normHPD);
  log(`  ECB: ${bins.length} bins...`);
  const ecbRows = (await socrata("6bgk-3dad", "bin", bins,
    "ecb_violation_number,bin,ecb_violation_status,severity,violation_type,violation_description,section_law_description1,infraction_code1,penality_imposed,amount_paid,balance_due,issue_date,hearing_status,respondent_name")).map(normECB);
  log(`  DOB: ${bins.length} bins...`);
  const dobRows = (await socrata("3h2n-5cm9", "bin", bins,
    "violation_number,number,bin,violation_category,violation_type,violation_type_code,description,issue_date,disposition_comments")).map(normDOB);

  const out = new Map();
  const ensure = (bbl) => { if (!out.has(bbl)) out.set(bbl, { hpd: [], ecb: [], dob: [] }); return out.get(bbl); };
  for (const b of buildings) if (b.bbl) ensure(b.bbl);
  for (const r of hpdRows) if (r.bbl) ensure(r.bbl).hpd.push(r);
  for (const r of ecbRows) { const bbl = binToBbl.get(r.bin); if (bbl) ensure(bbl).ecb.push(r); }
  for (const r of dobRows) { const bbl = binToBbl.get(r.bin); if (bbl) ensure(bbl).dob.push(r); }
  for (const [, v] of out) v.summary = summarize(v.hpd, v.ecb, v.dob);
  return out;
}
