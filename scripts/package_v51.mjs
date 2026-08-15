/**
 * Builds the Version 5.1 release ZIP.
 *
 * Deliberate exclusions: node_modules, benchmark fixtures, uploaded user files,
 * temporary files, test databases, validator projects and private source caches.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "..");
const STAGE = path.join(ROOT, "_v51_stage", "US-Vehicle-Catalog-App-v5.1");
const OUT = path.join(APP, "exports", "US-Vehicle-Catalog-App-v5.1.zip");

fs.rmSync(path.join(ROOT, "_v51_stage"), { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const TOP_FILES = [
  "package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts",
  "setup-windows.bat", "start-app.bat", "stop-app.bat",
  "import-latest-catalog.bat", "export-excel.bat",
  "backup-database.bat", "restore-database.bat",
  "README.md", "DATA_MODEL.md", "IMPORT_GUIDE.md", "EXPORT_GUIDE.md",
  "VALIDATION_GUIDE.md", "DEPLOYMENT_GUIDE.md", "FILE_STANDARDIZATION_GUIDE.md",
  "COLUMN_MAPPING_GUIDE.md", "MATCH_CONFIDENCE_GUIDE.md", "REVIEW_WORKFLOW_GUIDE.md",
  "PROJECT_MAPPING_GUIDE.md", "LARGE_FILE_PROCESSING_GUIDE.md",
  // Version 5.1 documentation
  "SECURITY_GUIDE.md", "SAFE_FILE_HANDLING_GUIDE.md", "DATA_RETENTION_GUIDE.md",
  "CRASH_RECOVERY_GUIDE.md", "BACKUP_RESTORE_GUIDE.md",
  "CLEAN_INSTALL_VALIDATION.md", "Clean_Windows_Installation_Report.md",
  "Canonical_Immutability_Security_Audit.md",
];

// validators live beside the project, not inside the app directory
const ROOT_FILES = [
  "validate_catalog_v3_semantics.py", "validate_catalog_v4_hierarchy.py",
  "validate_standardization_workspace_v5.py",
  "validate_standardization_workspace_v5_1.py",
];

// Directories copied wholesale, minus anything the filter rejects.
const TOP_DIRS = ["server", "web", "tests", "scripts", "config", "samples",
  "catalog-files", "screenshots", "audit-reports", "reports"];

const EXCLUDE_DIR = new Set(["node_modules", "dist", ".vite", ".git", "coverage",
  "release-stage-v5", "release-stage-v51", "projects", "uploads", ".npm-cache"]);
const isBenchmarkFixture = (n) =>
  /fixture/i.test(n) || /benchmark/i.test(n) || /^large_/i.test(n);
const skipFile = (n) =>
  n.endsWith(".part") || n.endsWith(".tmp") || n.endsWith("-wal") || n.endsWith("-shm")
  || n.endsWith(".log") || n === ".DS_Store" || n === "Thumbs.db"
  || /^\.env/.test(n)                     // never ship secrets
  || isBenchmarkFixture(n)
  || /\.(db|sqlite)$/i.test(n)            // databases are staged explicitly below
  || /^test.*\.(db|json)$/i.test(n);

function copyTree(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name)) continue;
      copyTree(path.join(src, e.name), path.join(dest, e.name));
    } else {
      if (skipFile(e.name)) continue;
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
    }
  }
}

for (const f of TOP_FILES) {
  const src = path.join(APP, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
  else console.warn(`  missing (skipped): ${f}`);
}
for (const d of TOP_DIRS) {
  const src = path.join(APP, d);
  if (fs.existsSync(src)) copyTree(src, path.join(STAGE, d));
}

// the built frontend must ship: setup rebuilds it, but the app runs without npm run build
const dist = path.join(APP, "web", "dist");
if (fs.existsSync(dist)) copyTree(dist, path.join(STAGE, "web", "dist"));

for (const f of ROOT_FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, f));
  else console.warn(`  missing validator (skipped): ${f}`);
}

// the release database, checkpointed and self-contained
fs.mkdirSync(path.join(STAGE, "data"), { recursive: true });
fs.copyFileSync(path.join(APP, "data", "catalog-v5.1.db"),
  path.join(STAGE, "data", "catalog-v5.1.db"));
for (const f of ["app_verification_report_v5_1.json", "app_verification_report.json"]) {
  const src = path.join(APP, "data", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, "data", f));
}

// validation and benchmark REPORTS ship; the fixtures they measured do not
fs.mkdirSync(path.join(STAGE, "exports"), { recursive: true });
for (const f of ["Large_File_Performance_Report.json", "Large_File_Performance_Report.csv",
  "Backup_Restore_Validation_Report.json", "Release_Database_Inspection_Report.json",
  // the package manifest and post-package results describe the finished ZIP, so
  // they are produced from it and ship beside it rather than inside it
  "Formula_Injection_Verification.json", "Workbook_Limits_Verification.json",
  "clean_install_steps.json"]) {
  const src = path.join(APP, "exports", f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(STAGE, "exports", f));
  else console.warn(`  missing report (skipped): ${f}`);
}
// the canonical workbooks users actually need
for (const f of fs.readdirSync(path.join(APP, "exports"))) {
  // the Version 4 catalog workbook and the simplified lookup workbook
  if (/^Complete_US_Vehicle_Catalog_.*_v4\.xlsx$/i.test(f)
      || /^Canonical Vehicle Lookup\.xlsx$/i.test(f)) {
    fs.copyFileSync(path.join(APP, "exports", f), path.join(STAGE, "exports", f));
  }
}

// empty working directories so first run has somewhere to write
for (const d of ["uploads", "backups", "exports/projects"]) {
  const p = path.join(STAGE, d);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, ".gitkeep"), "");
}

fs.rmSync(OUT, { force: true });
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${path.join(ROOT, "_v51_stage", "*")}' ` +
  `-DestinationPath '${OUT}' -CompressionLevel Optimal`], { stdio: "inherit" });
fs.rmSync(path.join(ROOT, "_v51_stage"), { recursive: true, force: true });

const size = fs.statSync(OUT).size;
console.log(`\n${OUT}\n${(size / 1048576).toFixed(1)} MB`);
