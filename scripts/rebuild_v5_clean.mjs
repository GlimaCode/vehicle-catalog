/**
 * Rebuild a pristine catalog-v5.db: a checkpointed copy of the frozen
 * catalog-v4.db plus the Version 5 workspace migrations, with no project data.
 * Also produces the disposable validation copy used by the V5 validator.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import { initSchema } from "../server/db.ts";

const TARGET = "data/catalog-v5.db";
const VALIDATION = "data/catalog-v5-validation.db";

for (const base of [TARGET, VALIDATION]) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = base + suffix;
    if (fs.existsSync(f)) { try { fs.rmSync(f); } catch (e) { console.log("keep", f, String(e)); } }
  }
}

const src = new Database("data/catalog-v4.db");
src.pragma("wal_checkpoint(TRUNCATE)");
src.prepare(`VACUUM INTO '${TARGET}'`).run();
src.close();

const db = new Database(TARGET);
initSchema(db);                    // applies migrations 001-006
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

fs.copyFileSync(TARGET, VALIDATION);

const check = new Database(TARGET, { readonly: true });
const n = (q) => check.prepare(q).get().n;
console.log(JSON.stringify({
  sizeMb: Number((fs.statSync(TARGET).size / 1024 / 1024).toFixed(1)),
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  hierarchy: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  configuration: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
  projects: n("SELECT COUNT(*) n FROM standardization_projects"),
  readOnlyTriggers: n("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_ro_%'"),
}, null, 1));
check.close();
