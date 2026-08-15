import Database from "better-sqlite3";
import fs from "node:fs";
const db = new Database("data/catalog-v5.db", { readonly: true });
const n = (q) => db.prepare(q).get().n;
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log(JSON.stringify({
  sizeMb: Number((fs.statSync("data/catalog-v5.db").size / 1024 / 1024).toFixed(1)),
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  hierarchy: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  configuration: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
  aliases: n("SELECT COUNT(*) n FROM aliases"),
  projects: n("SELECT COUNT(*) n FROM standardization_projects"),
  rows: n("SELECT COUNT(*) n FROM standardization_rows"),
  v5Tables: tables.filter((t) => /standardization|mapping_templates|project_|catalog_change/.test(t)),
  triggers: db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_ro_%'").get().n,
}, null, 1));
db.close();
