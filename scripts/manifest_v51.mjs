/**
 * Produces Release_Package_Manifest_v5_1.csv from the final ZIP and checks it
 * against the required-content and forbidden-content lists.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = path.join(APP, "exports", "US-Vehicle-Catalog-App-v5.1.zip");
const OUT = path.join(APP, "exports", "Release_Package_Manifest_v5_1.csv");
const WORK = path.join(APP, "exports", "_manifest_extract");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
execFileSync("powershell", ["-NoProfile", "-Command",
  `Expand-Archive -Path '${ZIP}' -DestinationPath '${WORK}' -Force`], { stdio: "inherit" });

const ROOT = path.join(WORK, "US-Vehicle-Catalog-App-v5.1");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else files.push(path.relative(ROOT, full).replace(/\\/g, "/"));
  }
})(ROOT);
files.sort();

const categorize = (p) => {
  if (p.startsWith("server/security/")) return "Hardening module";
  if (p.startsWith("server/standardize/")) return "Standardization workspace";
  if (p.startsWith("server/")) return "Application source (server)";
  if (p.startsWith("web/dist/")) return "Built frontend";
  if (p.startsWith("web/")) return "Application source (frontend)";
  if (p.startsWith("tests/")) return "Automated tests";
  if (p.startsWith("scripts/")) return "Utility script";
  if (p.startsWith("config/")) return "Security and retention configuration";
  if (p.startsWith("data/") && p.endsWith(".db")) return "Release database";
  if (p.startsWith("data/")) return "Validator report";
  if (p.startsWith("catalog-files/")) return "Version 4 canonical data";
  if (p.startsWith("samples/")) return "Sample input file";
  if (p.startsWith("screenshots/")) return "Application screenshot";
  if (p.startsWith("audit-reports/") || p.startsWith("reports/")) return "Audit report";
  if (/Report.*\.(json|csv)$|clean_install_steps\.json$/.test(p)) return "Validation report";
  if (p.endsWith(".xlsx")) return "Catalog workbook";
  if (p.endsWith(".bat")) return "Windows script";
  if (p.endsWith(".py")) return "Validator";
  if (p.endsWith(".md")) return "Documentation";
  if (/^package(-lock)?\.json$/.test(p)) return "Dependency manifest";
  if (p.endsWith(".gitkeep")) return "Working directory placeholder";
  return "Project configuration";
};

// Required content: label -> predicate over the file list
const REQUIRED = {
  "Full application source": (f) => f.some((x) => x.startsWith("server/index.ts")),
  "package.json": (f) => f.includes("package.json"),
  "Lockfile": (f) => f.includes("package-lock.json"),
  "Current migrations": (f) => f.includes("server/migrate.ts"),
  "Pristine catalog-v5.1.db": (f) => f.includes("data/catalog-v5.1.db"),
  "Version 4 canonical files": (f) => f.some((x) => x.startsWith("catalog-files/")),
  "Version 4 catalog workbook": (f) => f.some((x) => /_v4\.xlsx$/i.test(x)),
  "Canonical Vehicle Lookup.xlsx": (f) => f.some((x) => /Canonical Vehicle Lookup\.xlsx$/i.test(x)),
  "File-standardization workspace": (f) => f.some((x) => x.startsWith("server/standardize/")),
  "Hardening modules": (f) => ["formula", "workbook", "filenames", "locks", "atomic", "http"]
    .every((m) => f.includes(`server/security/${m}.ts`)),
  "Security and retention configuration": (f) => f.some((x) => x.startsWith("config/")),
  "All automated tests": (f) => ["catalog", "hardening", "standardization"]
    .every((t) => f.includes(`tests/${t}.test.ts`)),
  "validate_standardization_workspace_v5.py": (f) => f.includes("validate_standardization_workspace_v5.py"),
  "validate_standardization_workspace_v5_1.py": (f) => f.includes("validate_standardization_workspace_v5_1.py"),
  "Performance reports": (f) => f.includes("exports/Large_File_Performance_Report.json")
    && f.includes("exports/Large_File_Performance_Report.csv"),
  "Backup/restore report": (f) => f.includes("exports/Backup_Restore_Validation_Report.json"),
  "Release-database inspection report": (f) => f.includes("exports/Release_Database_Inspection_Report.json"),
  "Clean-install report": (f) => f.includes("CLEAN_INSTALL_VALIDATION.md")
    && f.includes("exports/clean_install_steps.json"),
  "Canonical immutability audit": (f) => f.includes("Canonical_Immutability_Security_Audit.md"),
  "Updated README": (f) => f.includes("README.md"),
  "Security and recovery guides": (f) => ["SECURITY_GUIDE", "SAFE_FILE_HANDLING_GUIDE",
    "DATA_RETENTION_GUIDE", "CRASH_RECOVERY_GUIDE", "BACKUP_RESTORE_GUIDE"]
    .every((g) => f.includes(`${g}.md`)),
  "Windows scripts (setup/start/stop/import/export/backup/restore)": (f) =>
    ["setup-windows", "start-app", "stop-app", "import-latest-catalog", "export-excel",
      "backup-database", "restore-database"].every((b) => f.includes(`${b}.bat`)),
  "Sample CSV and XLSX": (f) => f.some((x) => /^samples\/.*\.csv$/.test(x))
    && f.some((x) => /^samples\/.*\.xlsx$/.test(x)),
  "Application screenshots": (f) => f.filter((x) => x.startsWith("screenshots/")).length > 0,
};

const FORBIDDEN = {
  "node_modules": (x) => x.includes("node_modules/"),
  "Benchmark fixture files": (x) => /fixture|benchmark|^samples\/large_/i.test(x),
  "Validator databases": (x) => /validation.*\.db$|validator.*\.db$/i.test(x),
  "Test databases": (x) => /^test.*\.db$|test.*\.sqlite$/i.test(x),
  "Uploaded user files": (x) => /^uploads\/.+/.test(x) && !x.endsWith(".gitkeep"),
  "Processed user projects": (x) => /^exports\/projects\/.+/.test(x) && !x.endsWith(".gitkeep"),
  "Temporary exports": (x) => x.endsWith(".part") || x.endsWith(".tmp"),
  "SQLite WAL or SHM files": (x) => x.endsWith("-wal") || x.endsWith("-shm"),
  "Private source caches": (x) => /\.npm-cache\/|\.cache\//.test(x),
  "Development logs": (x) => x.endsWith(".log"),
  ".env files": (x) => /(^|\/)\.env/.test(x),
  "Unnecessary backup copies": (x) => /^backups\/.+/.test(x) && !x.endsWith(".gitkeep"),
};

const requiredPaths = new Set();
for (const [, pred] of Object.entries(REQUIRED)) {
  for (const f of files) if (pred([f])) requiredPaths.add(f);
}

const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const rows = [["Relative Path", "File Size", "SHA-256", "File Category",
  "Required", "Included", "Notes"].join(",")];

for (const rel of files) {
  const full = path.join(ROOT, rel);
  const size = fs.statSync(full).size;
  const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
  const violated = Object.entries(FORBIDDEN).find(([, p]) => p(rel));
  const notes = violated ? `FORBIDDEN CONTENT: ${violated[0]}`
    : rel === "data/catalog-v5.1.db" ? "Pristine release database, WAL checkpointed"
    : rel.endsWith(".gitkeep") ? "Empty working directory placeholder"
    : "";
  rows.push([esc(rel), size, hash, esc(categorize(rel)),
    requiredPaths.has(rel) ? "Yes" : "No", "Yes", esc(notes)].join(","));
}

// requirement coverage rows so the manifest also records what was checked
const missing = [];
for (const [label, pred] of Object.entries(REQUIRED)) {
  const ok = pred(files);
  if (!ok) missing.push(label);
  rows.push([esc(`[requirement] ${label}`), "", "", esc("Required-content check"),
    "Yes", ok ? "Yes" : "No", esc(ok ? "Present in package" : "MISSING")].join(","));
}
const present = [];
for (const [label, pred] of Object.entries(FORBIDDEN)) {
  const hits = files.filter(pred);
  if (hits.length) present.push(`${label} (${hits.length})`);
  rows.push([esc(`[exclusion] ${label}`), "", "", esc("Forbidden-content check"),
    "No", hits.length ? "Yes" : "No",
    esc(hits.length ? `PRESENT: ${hits.slice(0, 3).join("; ")}` : "Correctly absent")].join(","));
}

fs.writeFileSync(OUT, rows.join("\r\n") + "\r\n", "utf8");
fs.rmSync(WORK, { recursive: true, force: true });

const zipHash = crypto.createHash("sha256").update(fs.readFileSync(ZIP)).digest("hex");
const result = {
  zip: ZIP, zipBytes: fs.statSync(ZIP).size, zipSha256: zipHash,
  fileCount: files.length, manifest: OUT,
  missingRequired: missing, forbiddenPresent: present,
  status: missing.length === 0 && present.length === 0 ? "PASS" : "FAIL",
};
console.log(JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(APP, "exports", "Release_Package_Manifest_Check.json"),
  JSON.stringify(result, null, 2));
