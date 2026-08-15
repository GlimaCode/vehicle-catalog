import Database from "better-sqlite3";
const db = new Database("data/catalog-v2.db", { readonly: true });
const rows = db.prepare(`SELECT k.standard_make mk, m.standard_model md, m.norm_model nm,
  m.confirmed_model_years years, m.present_in_original_source pos, m.catalog_origin
  FROM models m JOIN makes k ON k.id=m.make_id
  WHERE m.norm_model IN ('AWD','4WD','FWD','RWD','2WD','HEMI','TURBO','HYBRID','DIESEL','V6','V8')`).all();
console.log(JSON.stringify(rows, null, 1));
