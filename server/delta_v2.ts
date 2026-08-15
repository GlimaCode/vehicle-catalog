/** Application_Data_V1_to_V2_Delta.csv: compares catalog.db vs catalog-v2.db. */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, EXPORT_DIR } from "./db.js";
import { toCsv } from "./exporter.js";

export function generateAppDelta(): string {
  const v1 = new Database(path.join(DATA_DIR, "catalog.db"), { readonly: true });
  const v2 = new Database(path.join(DATA_DIR, "catalog-v2.db"), { readonly: true });
  const rows: Record<string, string>[] = [];
  const add = (type: string, mk: string, item: string, detail: string) =>
    rows.push({ "Change Type": type, "Standard Make": mk, Item: item, Detail: detail });

  type MakeRow = { standard_make: string };
  const makes1 = new Set((v1.prepare("SELECT standard_make FROM makes").all() as MakeRow[])
    .map((r) => r.standard_make));
  const makes2 = new Set((v2.prepare("SELECT standard_make FROM makes").all() as MakeRow[])
    .map((r) => r.standard_make));
  for (const m of makes2) if (!makes1.has(m)) add("Added Make", m, m, "Present only in V2.");
  for (const m of makes1) if (!makes2.has(m)) add("Removed Make", m, m, "Absent from V2.");

  type ModelRow = { mk: string; md: string; years: string; vs: string };
  const q = "SELECT k.standard_make mk, m.standard_model md, m.confirmed_model_years years, m.validation_status vs FROM models m JOIN makes k ON k.id=m.make_id";
  const m1 = new Map((v1.prepare(q).all() as ModelRow[]).map((r) => [`${r.mk}|${r.md}`, r]));
  const m2 = new Map((v2.prepare(q).all() as ModelRow[]).map((r) => [`${r.mk}|${r.md}`, r]));
  for (const [k, r] of m2) {
    if (!m1.has(k)) add("Added Model", r.mk, r.md, "Present only in V2 database.");
    else {
      const p = m1.get(k)!;
      if (p.years !== r.years) {
        add("Corrected Year Range", r.mk, r.md, `${p.years} -> ${r.years}`);
      }
      if (p.vs !== r.vs) {
        add("Changed Validation Status", r.mk, r.md, `${p.vs} -> ${r.vs}`);
      }
    }
  }
  for (const [k, r] of m1) {
    if (!m2.has(k)) {
      add("Model Moved to Review / Merged", r.mk, r.md,
        "Removed from canonical models in V2 (see Canonical_Model_Merge_Audit.csv).");
    }
  }

  const subCount = (v2.prepare(`SELECT COUNT(*) n FROM submodels WHERE review_status='Approved'
    AND validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')`)
    .get() as { n: number }).n;
  add("Added Sub-models", "(all)", `${subCount} approved classified variants`,
    "Phase 2 sub-model research pipeline (EPA-explicit values; NHTSA-only values kept in review).");
  const alias1 = (v1.prepare("SELECT COUNT(*) n FROM aliases").get() as { n: number }).n;
  const alias2 = (v2.prepare("SELECT COUNT(*) n FROM aliases").get() as { n: number }).n;
  add("New Aliases", "(all)", `${alias2 - alias1} added (total ${alias2})`,
    "Hierarchy raw-to-canonical mappings and V2 merge-audit aliases.");
  const rev1 = (v1.prepare("SELECT COUNT(*) n FROM validation_reviews").get() as { n: number }).n;
  const rev2 = (v2.prepare("SELECT COUNT(*) n FROM validation_reviews").get() as { n: number }).n;
  add("Items Moved to Review", "(all)", `${rev2 - rev1} added (total ${rev2})`,
    "vPIC-only model candidates, NHTSA-only trims, unclassified residuals, "
    + "chassis/generation codes, reversed trim-row merges.");

  const csv = toCsv(rows, [
    { header: "Change Type", key: "Change Type" },
    { header: "Standard Make", key: "Standard Make" },
    { header: "Item", key: "Item" },
    { header: "Detail", key: "Detail" }]);
  const out = path.join(EXPORT_DIR, "Application_Data_V1_to_V2_Delta.csv");
  fs.writeFileSync(out, csv);
  v1.close(); v2.close();
  return out;
}
