import Database from "better-sqlite3";
const db = new Database("data/catalog-v3.db", { readonly: true });
console.log(JSON.stringify({
  priorities: db.prepare(`SELECT COALESCE(NULLIF(priority,''),'(model-level, unprioritized)') k,
    COUNT(*) n FROM validation_reviews GROUP BY 1 ORDER BY 2 DESC`).all(),
  model_years: db.prepare("SELECT COUNT(*) n FROM model_years").get().n,
  hierarchy_years: db.prepare("SELECT COUNT(*) n FROM hierarchy_value_years").get().n,
  configuration_years: db.prepare("SELECT COUNT(*) n FROM configuration_value_years").get().n,
  validation: db.prepare(`SELECT validation_status k, COUNT(*) n FROM models GROUP BY 1`).all(),
}, null, 1));
