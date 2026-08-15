/** Create a pristine catalog-v5.1.db from the frozen V4 canonical catalog. */
import Database from "better-sqlite3";
import fs from "node:fs";
import { initSchema } from "../server/db.ts";

const TARGET = "data/catalog-v5.1.db";
for (const s of ["", "-wal", "-shm"]) {
  const f = TARGET + s;
  if (fs.existsSync(f)) fs.rmSync(f);
}
const src = new Database("data/catalog-v4.db");
src.pragma("wal_checkpoint(TRUNCATE)");
src.prepare(`VACUUM INTO '${TARGET}'`).run();
src.close();

const db = new Database(TARGET);
initSchema(db);                       // migrations 001-007
db.pragma("wal_checkpoint(TRUNCATE)");
const integrity = db.pragma("integrity_check", { simple: true });
const fk = db.pragma("foreign_key_check");
db.close();

const check = new Database(TARGET, { readonly: true });
const n = (q) => check.prepare(q).get().n;
console.log(JSON.stringify({
  sizeMb: Number((fs.statSync(TARGET).size / 1024 / 1024).toFixed(1)),
  integrity, foreignKeyViolations: fk.length,
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  hierarchy: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  configuration: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
  projects: n("SELECT COUNT(*) n FROM standardization_projects"),
  readOnlyTriggers: n("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_ro_%'"),
}, null, 1));
check.close();
