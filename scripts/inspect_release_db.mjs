/** Release-database inspection: the shipped catalog-v5.1.db must be pristine. */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";

const TARGET = process.argv[2] ?? "data/catalog-v5.1.db";
const checks = [];
const check = (name, ok, detail = "") =>
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });

const db = new Database(TARGET, { readonly: true });
const n = (q) => db.prepare(q).get().n;

const canonical = {
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
  vehicle_hierarchy_values: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  hierarchy_value_years: n("SELECT COUNT(*) n FROM hierarchy_value_years"),
  vehicle_configuration_values: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  configuration_value_years: n("SELECT COUNT(*) n FROM configuration_value_years"),
  aliases: n("SELECT COUNT(*) n FROM aliases"),
  grouped_model_relationships: n("SELECT COUNT(*) n FROM grouped_model_relationships"),
};
const EXPECTED = { makes: 76, models: 1798, model_years: 15594,
  vehicle_hierarchy_values: 390, hierarchy_value_years: 2504,
  vehicle_configuration_values: 6859, configuration_value_years: 43465,
  aliases: 206, grouped_model_relationships: 119 };
check("Contains all canonical Version 4 records",
  JSON.stringify(canonical) === JSON.stringify(EXPECTED), JSON.stringify(canonical));

const tables = new Set(db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const REQUIRED_V51 = ["standardization_projects", "standardization_rows",
  "standardization_changes", "mapping_templates", "project_value_mappings",
  "catalog_change_proposals", "project_exports", "project_deletions",
  "security_events", "vehicle_hierarchy_values", "vehicle_configuration_values"];
check("Contains all Version 5.1 schema objects",
  REQUIRED_V51.every((t) => tables.has(t)),
  REQUIRED_V51.filter((t) => !tables.has(t)).join(", ") || "all present");

const migrations = db.prepare("SELECT id FROM schema_migrations ORDER BY id")
  .all().map((r) => r.id);
const REQUIRED_MIGRATIONS = ["002_v2_submodels", "003_review_submodel_uniqueness",
  "004_v3_hierarchy_configuration_split", "005_v5_standardization_workspace",
  "006_canonical_readonly_guard", "007_v51_hardening"];
check("All migrations applied without error",
  REQUIRED_MIGRATIONS.every((m) => migrations.includes(m)),
  migrations.join(", "));

const projects = db.prepare("SELECT id, project_name FROM standardization_projects").all();
check("No benchmark projects", !projects.some((p) => /fixture|benchmark/i.test(p.project_name)),
  projects.map((p) => p.project_name).join(", ") || "none");
check("No validator projects", !projects.some((p) => /validator|smoke|test/i.test(p.project_name)),
  projects.map((p) => p.project_name).join(", ") || "none");
check("No project rows at all (clean release database)",
  n("SELECT COUNT(*) n FROM standardization_rows") === 0
  && n("SELECT COUNT(*) n FROM standardization_changes") === 0
  && projects.length === 0,
  `projects=${projects.length}`);

const triggers = n(
  "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_ro_%'");
check("Canonical read-only triggers present", triggers === 27, `${triggers} triggers`);
const unlocked = db.prepare("SELECT value FROM catalog_meta WHERE key='canonical_unlocked'")
  .get();
check("Canonical catalog is locked in the shipped database",
  !unlocked || unlocked.value === "0", JSON.stringify(unlocked));

check("PRAGMA integrity_check passes",
  db.pragma("integrity_check", { simple: true }) === "ok");
check("Foreign-key check passes", db.pragma("foreign_key_check").length === 0);
const journal = db.pragma("journal_mode", { simple: true });
const walExists = fs.existsSync(TARGET + "-wal");
const walSize = walExists ? fs.statSync(TARGET + "-wal").size : 0;
check("Clean WAL checkpoint (no pending WAL data)", walSize === 0,
  `journal_mode=${journal}, wal bytes=${walSize}`);

db.close();
const report = {
  generatedAt: new Date().toISOString(),
  database: TARGET,
  sizeMB: Number((fs.statSync(TARGET).size / 1024 / 1024).toFixed(1)),
  sha256: crypto.createHash("sha256").update(fs.readFileSync(TARGET)).digest("hex"),
  canonicalCounts: canonical,
  migrations,
  checks,
  status: checks.every((c) => c.ok) ? "PASS" : "FAIL",
};
fs.writeFileSync("exports/Release_Database_Inspection_Report.json",
  JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, sizeMB: report.sizeMB,
  failed: checks.filter((c) => !c.ok) }, null, 1));
