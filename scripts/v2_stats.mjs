import Database from "better-sqlite3";
const db = new Database("data/catalog-v2.db", { readonly: true });
const n = (sql) => db.prepare(sql).get().n;
console.log(JSON.stringify({
  makes: n("SELECT COUNT(*) n FROM makes"),
  models: n("SELECT COUNT(*) n FROM models"),
  model_years: n("SELECT COUNT(*) n FROM model_years"),
  approved_submodels: n(`SELECT COUNT(*) n FROM submodels WHERE review_status='Approved'
    AND validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')`),
  pending_submodel_candidates: n("SELECT COUNT(*) n FROM submodels WHERE review_status<>'Approved'"),
  submodel_years: n("SELECT COUNT(*) n FROM submodel_years"),
  aliases: n("SELECT COUNT(*) n FROM aliases"),
  reviews: n("SELECT COUNT(*) n FROM validation_reviews"),
  by_type: db.prepare(`SELECT submodel_type k, COUNT(*) n FROM submodels
    WHERE review_status='Approved' GROUP BY 1 ORDER BY 2 DESC`).all(),
  version: db.prepare("SELECT value FROM catalog_meta WHERE key='catalog_version'").get(),
}, null, 1));
