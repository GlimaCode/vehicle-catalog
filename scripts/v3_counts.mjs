import Database from "better-sqlite3";
const db = new Database(process.env.CATALOG_DB ?? "data/catalog-v3.db", { readonly: true });
const n = (s) => db.prepare(s).get().n;
console.log([
  n("SELECT COUNT(*) n FROM models"),
  n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
  n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
  n("SELECT COUNT(*) n FROM hierarchy_value_years"),
  n("SELECT COUNT(*) n FROM configuration_value_years"),
  n("SELECT COUNT(*) n FROM aliases"),
  n("SELECT COUNT(*) n FROM validation_reviews"),
].join(","));
