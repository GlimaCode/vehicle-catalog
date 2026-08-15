/** Create catalog-v5.db as a complete, checkpointed copy of catalog-v4.db. */
import Database from "better-sqlite3";
import fs from "node:fs";

for (const f of ["data/catalog-v5.db", "data/catalog-v5.db-wal", "data/catalog-v5.db-shm"]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
const src = new Database("data/catalog-v4.db");
src.pragma("wal_checkpoint(TRUNCATE)");
src.prepare("VACUUM INTO 'data/catalog-v5.db'").run();
src.close();

const out = new Database("data/catalog-v5.db", { readonly: true });
const n = (q) => out.prepare(q).get().n;
console.log(JSON.stringify({
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  hierarchy: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  configuration: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
}, null, 1));
out.close();
