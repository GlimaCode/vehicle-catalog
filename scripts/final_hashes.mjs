/**
 * Produces Version_5_1_Final_Hash_Manifest.csv over every final artifact.
 * Run LAST, after the final ZIP has been built.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "..");
const OUT = path.join(APP, "exports", "Version_5_1_Final_Hash_Manifest.csv");

const ARTIFACTS = [
  ["Final release ZIP", "exports/US-Vehicle-Catalog-App-v5.1.zip"],
  ["Release database", "data/catalog-v5.1.db"],
  ["Package manifest", "exports/Release_Package_Manifest_v5_1.csv"],
  ["Package manifest check", "exports/Release_Package_Manifest_Check.json"],
  ["Performance report (JSON)", "exports/Large_File_Performance_Report.json"],
  ["Performance report (CSV)", "exports/Large_File_Performance_Report.csv"],
  ["Backup/restore report", "exports/Backup_Restore_Validation_Report.json"],
  ["Release-database inspection report", "exports/Release_Database_Inspection_Report.json"],
  ["Clean-install report (Markdown)", "Clean_Windows_Installation_Report.md"],
  ["Clean-install validation notes", "CLEAN_INSTALL_VALIDATION.md"],
  ["Clean-install step results", "exports/clean_install_steps.json"],
  ["Post-package install step results", "exports/post_package_steps.json"],
  ["Formula-injection verification", "exports/Formula_Injection_Verification.json"],
  ["Workbook-limits verification", "exports/Workbook_Limits_Verification.json"],
  ["Version 5 validator report", "data/app_verification_report_v5.json"],
  ["Version 5.1 validator report", "data/app_verification_report_v5_1.json"],
  ["Canonical immutability audit", "Canonical_Immutability_Security_Audit.md"],
  ["Application build artifact (HTML)", "web/dist/index.html"],
  ["Lookup workbook", "exports/Canonical Vehicle Lookup.xlsx"],
  ["Version 4 catalog workbook",
    "exports/Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v4.xlsx"],
  ["README", "README.md"],
];

const ROOT_ARTIFACTS = [
  ["Version 5 validator", "validate_standardization_workspace_v5.py"],
  ["Version 5.1 validator", "validate_standardization_workspace_v5_1.py"],
];

const sha256 = (p) => {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  const buf = Buffer.alloc(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest("hex");
};

// built JS/CSS bundles have content-hashed names, so discover them
const assets = path.join(APP, "web", "dist", "assets");
if (fs.existsSync(assets)) {
  for (const f of fs.readdirSync(assets)) {
    ARTIFACTS.push([`Application build artifact (${path.extname(f).slice(1)
      .toUpperCase()})`, `web/dist/assets/${f}`]);
  }
}

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const rows = [["Artifact", "Relative Path", "Bytes", "SHA-256", "Status"].join(",")];
const missing = [];
for (const [label, rel] of ARTIFACTS) {
  const full = path.join(APP, rel);
  if (!fs.existsSync(full)) { missing.push(rel); rows.push([esc(label), esc(rel), "", "", "MISSING"].join(",")); continue; }
  rows.push([esc(label), esc(rel), fs.statSync(full).size, sha256(full), "Present"].join(","));
}
for (const [label, rel] of ROOT_ARTIFACTS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { missing.push(rel); rows.push([esc(label), esc(rel), "", "", "MISSING"].join(",")); continue; }
  rows.push([esc(label), esc(`../${rel}`), fs.statSync(full).size, sha256(full), "Present"].join(","));
}
fs.writeFileSync(OUT, rows.join("\r\n") + "\r\n", "utf8");

const zip = path.join(APP, "exports", "US-Vehicle-Catalog-App-v5.1.zip");
console.log(JSON.stringify({
  manifest: OUT, entries: rows.length - 1, missing,
  finalZip: { bytes: fs.statSync(zip).size,
    megabytes: Number((fs.statSync(zip).size / 1048576).toFixed(2)),
    sha256: sha256(zip) },
  releaseDatabase: { sha256: sha256(path.join(APP, "data", "catalog-v5.1.db")) },
  status: missing.length ? "INCOMPLETE" : "PASS",
}, null, 2));
