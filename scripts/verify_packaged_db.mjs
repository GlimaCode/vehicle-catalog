/**
 * Extracts the final ZIP and inspects the PACKAGED database, not the
 * development one. Appends a "Packaged Database Verification" section to
 * Release_Database_Inspection_Report.json.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = path.join(APP, "exports", "US-Vehicle-Catalog-App-v5.1.zip");
const WORK = path.join(APP, "exports", "_packaged_db_check");
const REPORT = path.join(APP, "exports", "Release_Database_Inspection_Report.json");

const EXPECTED_CANONICAL = {
  makes: 76, models: 1798, model_years: 15594, vehicle_hierarchy_values: 390,
  hierarchy_value_years: 2504, vehicle_configuration_values: 6859,
  configuration_value_years: 43465, aliases: 206, grouped_model_relationships: 119,
};
const WORKSPACE_TABLES = ["standardization_projects", "standardization_rows",
  "standardization_changes", "project_exports", "project_value_mappings",
  "project_deletions", "security_events", "mapping_templates"];
const REQUIRED_MIGRATIONS = ["002", "003", "004", "005", "006", "007"];

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
execFileSync("powershell", ["-NoProfile", "-Command",
  `Expand-Archive -Path '${ZIP}' -DestinationPath '${WORK}' -Force`], { stdio: "inherit" });

const DB = path.join(WORK, "US-Vehicle-Catalog-App-v5.1", "data", "catalog-v5.1.db");
const checks = [];
const c = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail: String(detail) });

c("The packaged ZIP contains a release database", fs.existsSync(DB), DB);
const sidecars = ["-wal", "-shm"].filter((s) => fs.existsSync(DB + s));
c("No WAL or SHM sidecar is packaged", sidecars.length === 0,
  sidecars.length ? `present: ${sidecars.join(", ")}` : "none");

const dbBytes = fs.statSync(DB).size;
const dbHash = crypto.createHash("sha256").update(fs.readFileSync(DB)).digest("hex");

const db = new Database(DB, { readonly: true });
const one = (sql) => db.prepare(sql).pluck().get();

c("PRAGMA integrity_check returns ok", one("PRAGMA integrity_check") === "ok",
  one("PRAGMA integrity_check"));
const fk = db.prepare("PRAGMA foreign_key_check").all();
c("PRAGMA foreign_key_check reports no violations", fk.length === 0,
  `${fk.length} violation(s)`);

// Committed data must be readable with no sidecar present at all. Opening the
// file read-only above already proves this: SQLite would need the -wal file to
// see committed-but-uncheckpointed transactions, and none was shipped.
const canonical = {};
for (const t of Object.keys(EXPECTED_CANONICAL)) {
  canonical[t] = one(`SELECT COUNT(*) FROM ${t}`);
}
const mismatched = Object.entries(EXPECTED_CANONICAL)
  .filter(([t, n]) => canonical[t] !== n)
  .map(([t, n]) => `${t}: expected ${n}, found ${canonical[t]}`);
c("All Version 4 canonical counts match exactly", mismatched.length === 0,
  mismatched.length ? mismatched.join("; ") : JSON.stringify(canonical));

const workspace = {};
for (const t of WORKSPACE_TABLES) {
  try { workspace[t] = one(`SELECT COUNT(*) FROM ${t}`); }
  catch { workspace[t] = "table missing"; }
}
const dirty = Object.entries(workspace).filter(([, n]) => n !== 0);
c("The packaged database contains zero standardization projects",
  workspace.standardization_projects === 0, `${workspace.standardization_projects}`);
c("The packaged database contains zero standardization rows",
  workspace.standardization_rows === 0, `${workspace.standardization_rows}`);
c("The packaged database contains zero project changes and mappings",
  workspace.standardization_changes === 0 && workspace.project_value_mappings === 0
  && workspace.project_deletions === 0,
  JSON.stringify({ changes: workspace.standardization_changes,
    mappings: workspace.project_value_mappings,
    deletions: workspace.project_deletions }));
c("The packaged database contains zero generated export records",
  workspace.project_exports === 0, `${workspace.project_exports}`);
c("No benchmark or validator data exists in the packaged database",
  dirty.length === 0, dirty.length ? JSON.stringify(dirty) : "all workspace tables empty");

const migrations = db.prepare("SELECT id FROM schema_migrations ORDER BY id").pluck().all();
const missingMig = REQUIRED_MIGRATIONS.filter((m) => !migrations.some((x) => x.startsWith(m)));
c("All required migrations are applied", missingMig.length === 0,
  missingMig.length ? `missing ${missingMig.join(", ")}` : migrations.join(", "));

const triggers = db.prepare(
  "SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'").all();
const guarded = new Set(triggers.map((t) => t.tbl_name));
c("Read-only triggers protect every canonical table",
  triggers.length === 27 && Object.keys(EXPECTED_CANONICAL).every((t) => guarded.has(t)),
  `${triggers.length} triggers across ${guarded.size} tables`);

// Version 5.1 schema objects
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
const projCols = cols("standardization_projects");
const v51Cols = ["storage_id", "display_filename", "upload_removed", "upload_sha256",
  "last_progress_at", "recovery_state", "retention_policy"];
const missingCols = v51Cols.filter((x) => !projCols.includes(x));
const exportCols = cols("project_exports");
const missingExport = ["neutralized_cells", "formula_protection_applied"]
  .filter((x) => !exportCols.includes(x));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .pluck().all();
const missingTables = ["project_deletions", "security_events"]
  .filter((t) => !tables.includes(t));
c("All Version 5.1 schema objects exist",
  missingCols.length === 0 && missingExport.length === 0 && missingTables.length === 0,
  [...missingCols, ...missingExport, ...missingTables].join(", ") || "complete");

const journal = one("PRAGMA journal_mode");
c("The packaged database is self-contained (no sidecar needed to recover data)",
  sidecars.length === 0 && one("SELECT COUNT(*) FROM makes") === 76,
  `journal_mode=${journal}, canonical rows readable with no -wal present`);
db.close();

fs.rmSync(WORK, { recursive: true, force: true });

const section = {
  performedAt: new Date().toISOString(),
  source: "Extracted from the final release ZIP, not the development directory",
  zip: path.basename(ZIP),
  zipSha256: crypto.createHash("sha256").update(fs.readFileSync(ZIP)).digest("hex"),
  packagedDatabase: {
    path: "data/catalog-v5.1.db", bytes: dbBytes,
    megabytes: Number((dbBytes / 1048576).toFixed(2)), sha256: dbHash,
  },
  canonicalCounts: canonical,
  workspaceCounts: workspace,
  migrations, triggerCount: triggers.length,
  checks,
  status: checks.every((x) => x.ok) ? "PASS" : "FAIL",
};

const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
report["Packaged Database Verification"] = section;
report.status = report.status === "PASS" && section.status === "PASS" ? "PASS" : "FAIL";
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

console.log(JSON.stringify({ status: section.status,
  failed: checks.filter((x) => !x.ok),
  db: section.packagedDatabase }, null, 2));
