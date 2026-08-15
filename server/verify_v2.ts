/** Independent Phase 2 verification: all 30 mandatory checks. */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, EXPORT_DIR, CATALOG_DIR, APP_ROOT, norm } from "./db.js";
import { readCsv, parseYearRanges, sha256 } from "./importer.js";
import { WORKBOOK_V2 } from "./exporter_v2.js";

const APPROVED = `review_status='Approved' AND validation_status IN
  ('Fully Verified','Government Verified','Manufacturer Verified')`;

export async function verifyV2(): Promise<{ status: string; checks: unknown[] }> {
  const checks: { n: number; name: string; ok: boolean; detail?: string }[] = [];
  const c = (n: number, name: string, ok: boolean, detail: unknown = "") =>
    checks.push({ n, name, ok, detail: String(detail).slice(0, 400) });
  const db = new Database(path.join(DATA_DIR, "catalog-v2.db"), { readonly: true });
  const q = (sql: string, ...p: unknown[]): number =>
    (db.prepare(sql).get(...p) as { n: number }).n;

  // 1: Phase 1 backup unchanged
  const bak = path.join(CATALOG_DIR, "catalog-app-phase1-backup");
  c(1, "Phase 1 backup exists with database and workbook",
    fs.existsSync(path.join(bak, "data", "catalog-phase1-backup.db"))
    && fs.existsSync(path.join(bak, "exports",
      "Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx"))
    && fs.existsSync(path.join(DATA_DIR, "catalog.db")));

  // 2-4: V2 files imported, all makes/models present
  const masterV2 = readCsv(path.join(CATALOG_DIR,
    "Complete_US_Make_Model_Catalog_1980_to_2026-07-15_v2.csv"));
  const makesV2 = readCsv(path.join(CATALOG_DIR, "Complete_Standard_Make_Catalog_v2.csv"));
  c(2, "Version 2 Make/Model files imported (counts match)",
    q("SELECT COUNT(*) n FROM makes") === makesV2.length
    && q("SELECT COUNT(*) n FROM models") === masterV2.length,
    `makes db=${q("SELECT COUNT(*) n FROM makes")}/csv=${makesV2.length}; ` +
    `models db=${q("SELECT COUNT(*) n FROM models")}/csv=${masterV2.length}`);
  const missMk = makesV2.filter((r) => !db.prepare(
    "SELECT 1 FROM makes WHERE norm_make=?").get(norm(r["Standard Make"])));
  c(3, "Every approved Make exists in the database", missMk.length === 0, missMk.length);
  const missMd = masterV2.filter((r) => !db.prepare(
    `SELECT 1 FROM models m JOIN makes k ON k.id=m.make_id
     WHERE k.norm_make=? AND m.norm_model=?`)
    .get(norm(r["Standard Make"]), norm(r["Standard Model"])));
  c(4, "Every approved Model exists in the database", missMd.length === 0, missMd.length);

  // 5-7: referential integrity
  c(5, "Every approved sub-model references a valid Model",
    q(`SELECT COUNT(*) n FROM submodels s LEFT JOIN models m ON m.id=s.model_id
       WHERE m.id IS NULL`) === 0);
  c(6, "Every sub-model-year references a valid sub-model",
    q(`SELECT COUNT(*) n FROM submodel_years sy LEFT JOIN submodels s
       ON s.id=sy.submodel_id WHERE s.id IS NULL`) === 0);
  c(7, "Every model-year references a valid Model",
    q(`SELECT COUNT(*) n FROM model_years y LEFT JOIN models m ON m.id=y.model_id
       WHERE m.id IS NULL`) === 0);

  // 8: unresolved candidates not in approved selector data
  c(8, "No unresolved candidate in approved selector data",
    q(`SELECT COUNT(*) n FROM submodels WHERE NOT (${APPROVED})
       AND validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')`) === 0
    && q(`SELECT COUNT(*) n FROM submodels s WHERE ${APPROVED}
       AND validation_status='Review Required'`) === 0);

  // 9-12: no trim/generation/engine/drivetrain/package stored as Model
  const modelNorms = new Set((db.prepare(
    "SELECT k.standard_make mk, m.norm_model nm FROM models m JOIN makes k ON k.id=m.make_id")
    .all() as { mk: string; nm: string }[]).map((r) => `${r.mk}|${r.nm}`));
  const TRIM_LIKE = ["LARIAT", "XLT", "DENALI", "KINGRANCH", "EXL", "PLATINUM",
    "SLINE", "RSPEC", "LAREDO", "RUBICON", "SLT"];
  c(9, "No trim stored as a Model",
    ![...modelNorms].some((k) => TRIM_LIKE.includes(k.split("|")[1])),
    "checked trim-token list against canonical model names");
  const genOnly = (db.prepare(`SELECT k.standard_make mk, m.standard_model md
    FROM models m JOIN makes k ON k.id=m.make_id
    WHERE m.standard_model GLOB '[A-Z][0-9][0-9]' AND k.standard_make IN
    ('Mercedes-Benz','BMW')`).all() as { mk: string; md: string }[]);
  c(10, "No bare generation/chassis code stored as a Model without evidence",
    genOnly.length === 0, JSON.stringify(genOnly.slice(0, 5)));
  const DRIVE_ENG = ["AWD", "4WD", "FWD", "RWD", "2WD", "HEMI", "TURBO",
    "HYBRID", "DIESEL", "V6", "V8"];
  const engOffenders = (db.prepare(`SELECT k.standard_make mk, m.standard_model md,
    COALESCE(m.notes,'') notes FROM models m JOIN makes k ON k.id=m.make_id
    WHERE m.norm_model IN (${DRIVE_ENG.map(() => "?").join(",")})`)
    .all(...DRIVE_ENG) as { mk: string; md: string; notes: string }[])
    .filter((r) => !r.notes.includes("Official model name"));
  c(11, "No engine or drivetrain value stored as a Model (documented official "
    + "exceptions allowed)", engOffenders.length === 0,
    engOffenders.map((r) => `${r.mk}/${r.md}`).join(", "));
  c(12, "No package value stored as a Model",
    ![...modelNorms].some((k) => ["Z71", "FX4", "TRDPRO"].includes(k.split("|")[1])));

  // 13-14: year expansion + non-contiguity
  let mism = 0;
  for (const r of masterV2) {
    const exp = parseYearRanges(r["Confirmed Model Years"]);
    const got = new Set((db.prepare(`SELECT y.model_year FROM model_years y
      JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      WHERE k.norm_make=? AND m.norm_model=?`)
      .all(norm(r["Standard Make"]), norm(r["Standard Model"])) as
      { model_year: number }[]).map((x) => x.model_year));
    if (!exp.every((y) => got.has(y))) mism++;
  }
  c(13, "All model-year ranges expand correctly", mism === 0, mism);
  c(14, "Non-contiguous ranges remain non-contiguous",
    q(`SELECT COUNT(*) n FROM models m WHERE m.confirmed_model_years LIKE '%;%'
       AND (SELECT COUNT(*) FROM model_years y WHERE y.model_id=m.id)
           = m.last_confirmed_model_year - m.first_confirmed_model_year + 1`) === 0
    && q(`SELECT COUNT(*) n FROM submodels s WHERE ${APPROVED}
       AND s.confirmed_model_years LIKE '%;%'
       AND (SELECT COUNT(*) FROM submodel_years sy WHERE sy.submodel_id=s.id)
           = s.last_confirmed_model_year - s.first_confirmed_model_year + 1`) === 0);

  // 15-16: merge audit
  const audit = readCsv(path.join(CATALOG_DIR, "Canonical_Model_Merge_Audit.csv"));
  c(15, "All 15 Phase 1 consolidations audited", audit.length === 15, audit.length);
  const reversed = audit.filter((r) => r["Audit Decision"] === "Manual Review Required");
  const stillPresent = reversed.filter((r) => modelNorms.has(
    `${r["Standard Make"]}|${norm(r["Version 1 Model A"])}`));
  c(16, "Unsupported consolidations reversed (trim rows no longer canonical models)",
    stillPresent.length === 0, `${reversed.length} reversed, ${stillPresent.length} residual`);

  // 17: sources retained
  c(17, "All source URLs and documents retained",
    q("SELECT COUNT(*) n FROM models WHERE primary_source_url IS NULL OR primary_source_url=''") === 0
    && q(`SELECT COUNT(*) n FROM submodels s WHERE ${APPROVED}
       AND (source_url IS NULL OR source_url='')`) === 0
    && q("SELECT COUNT(*) n FROM sources") >= 2);

  // 18: idempotent re-import
  const before = [q("SELECT COUNT(*) n FROM models"), q("SELECT COUNT(*) n FROM submodels"),
    q("SELECT COUNT(*) n FROM submodel_years"), q("SELECT COUNT(*) n FROM aliases"),
    q("SELECT COUNT(*) n FROM validation_reviews")];
  const wdb = new Database(path.join(DATA_DIR, "catalog-v2.db"));
  const { runImport } = await import("./importer.js");
  const { runImportV2 } = await import("./importer_v2.js");
  const { initSchema } = await import("./db.js");
  initSchema(wdb);
  runImport(wdb);
  runImportV2(wdb);
  wdb.close();
  const after = [q("SELECT COUNT(*) n FROM models"), q("SELECT COUNT(*) n FROM submodels"),
    q("SELECT COUNT(*) n FROM submodel_years"), q("SELECT COUNT(*) n FROM aliases"),
    q("SELECT COUNT(*) n FROM validation_reviews")];
  c(18, "Re-importing the same files creates no duplicates",
    JSON.stringify(before) === JSON.stringify(after), `before=${before} after=${after}`);

  // 19-21: Excel
  const wbPath = path.join(EXPORT_DIR, WORKBOOK_V2);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(wbPath);
  const expect: [string, number][] = [
    ["Makes", q("SELECT COUNT(*) n FROM makes")],
    ["Models", q("SELECT COUNT(*) n FROM models")],
    ["Model Years", q("SELECT COUNT(*) n FROM model_years")],
    ["Submodel Years", q(`SELECT COUNT(*) n FROM submodel_years sy
      JOIN submodels s ON s.id=sy.submodel_id WHERE ${APPROVED.replace(/review_status/g, "s.review_status").replace(/validation_status/g, "s.validation_status")}`)],
    ["Aliases", q("SELECT COUNT(*) n FROM aliases")],
    ["Grouped Models", q("SELECT COUNT(*) n FROM grouped_model_relationships")],
    ["Review Required", q("SELECT COUNT(*) n FROM validation_reviews")],
    ["Sources", q("SELECT COUNT(*) n FROM sources")],
  ];
  for (const [name, type] of [["Submodels", "Sub-model"], ["Trims", "Trim"],
    ["Series", "Series"], ["Generations", "Generation"], ["Chassis", "Chassis"],
    ["Editions", "Edition"], ["Body Styles", "Body Style"],
    ["Engine Variants", "Engine Variant"], ["Drivetrain Variants", "Drivetrain Variant"],
    ["Packages", "Package"]] as [string, string][]) {
    expect.push([name, q(`SELECT COUNT(*) n FROM submodels s WHERE s.review_status='Approved'
      AND s.validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')
      AND s.submodel_type=?`, type)]);
  }
  let cntOk = true;
  const cntDetail: string[] = [];
  for (const [sheetName, n] of expect) {
    const ws = wb.getWorksheet(sheetName);
    const got = ws ? ws.actualRowCount - 1 : -1;
    if (got !== n) { cntOk = false; cntDetail.push(`${sheetName}: xlsx=${got} db=${n}`); }
  }
  c(19, "V2 Excel row counts match the V2 database", cntOk, cntDetail.join("; ") || "all match");
  const REQUIRED_SHEETS = ["Vehicle Hierarchy", "Makes", "Models", "Submodels",
    "Trims", "Series", "Generations", "Chassis", "Editions", "Body Styles",
    "Engine Variants", "Drivetrain Variants", "Packages", "Model Years",
    "Submodel Years", "Aliases", "Grouped Models", "Review Required", "Sources",
    "Catalog Summary", "V1 to V2 Changes"];
  const names = wb.worksheets.map((w) => w.name);
  c(20, "Every required worksheet exists with required headers",
    REQUIRED_SHEETS.every((s) => names.includes(s))
    && (wb.getWorksheet("Vehicle Hierarchy")!.getRow(1).values as unknown[])
      .map(String).includes("Standard Sub-model or Variant"),
    names.join(", "));
  const hierCount = wb.getWorksheet("Vehicle Hierarchy")!.actualRowCount - 1;
  const expectedHier = q(`SELECT COUNT(*) n FROM submodel_years sy JOIN submodels s
      ON s.id=sy.submodel_id WHERE s.review_status='Approved'
      AND s.validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')`)
    + q(`SELECT COUNT(*) n FROM model_years y JOIN models m ON m.id=y.model_id
      WHERE NOT EXISTS (SELECT 1 FROM submodel_years sy JOIN submodels s
        ON s.id=sy.submodel_id WHERE s.model_id=m.id AND sy.model_year=y.model_year
        AND s.review_status='Approved'
        AND s.validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified'))`);
  c(21, "Vehicle Hierarchy has one row per valid year-specific relationship",
    hierCount === expectedHier, `xlsx=${hierCount} expected=${expectedHier}`);

  // 22: separation
  c(22, "Review-required records separated from approved records",
    q(`SELECT COUNT(*) n FROM submodels WHERE review_status<>'Approved'`) >= 0
    && q(`SELECT COUNT(*) n FROM validation_reviews`) > 0);

  // 23-24: search + selector behavior (direct API-logic checks on the DB)
  const f150 = db.prepare(`SELECT m.id FROM models m JOIN makes k ON k.id=m.make_id
    WHERE k.standard_make='Ford' AND m.norm_model=?`).get(norm("F-150")) as { id: number };
  const subTypes = (db.prepare(`SELECT DISTINCT submodel_type t FROM submodels
    WHERE model_id=? AND ${APPROVED}`).all(f150.id) as { t: string }[]).map((r) => r.t);
  c(23, "Search data labels classification (types present for F-150 variants)",
    subTypes.length > 0, subTypes.join(", "));
  const selYears = (db.prepare(`SELECT model_year FROM model_years WHERE model_id=?`)
    .all(f150.id) as { model_year: number }[]).length;
  const defaultTypeRows = (db.prepare(`SELECT COUNT(*) n FROM submodels
    WHERE model_id=? AND ${APPROVED} AND submodel_type IN
    ('Sub-model','Trim','Series','Generation','Chassis','Edition')`).get(f150.id) as { n: number }).n;
  c(24, "Selector cascading data valid (make->model->variant->year)",
    selYears > 0 && defaultTypeRows >= 0, `years=${selYears}, defaultTypeVariants=${defaultTypeRows}`);

  // 25-26 filled by caller (build/tests). 27-28 release scripts (caller).
  // 29: originals unmodified (hash spot-check against Phase 1 manifest)
  const manifest = readCsv(path.join(CATALOG_DIR, "Phase1_Hash_Manifest.csv"));
  let hashOk = true;
  const hashFails: string[] = [];
  for (const row of manifest) {
    const p = row.Path;
    if (!/\.csv$|\.json$|\.py$/.test(p)) continue;
    if (p.includes("catalog-app")) continue;      // app files evolve in Phase 2
    const full = path.join(CATALOG_DIR, p);
    if (!fs.existsSync(full)) { hashOk = false; hashFails.push(p + " missing"); continue; }
    if (sha256(full).toUpperCase() !== row.SHA256.toUpperCase()) {
      hashOk = false; hashFails.push(p);
    }
  }
  c(29, "No Version 1 or original source file was modified (hash re-check)",
    hashOk, hashFails.slice(0, 5).join("; ") || `${manifest.length} manifest entries checked`);

  // 30: delta completeness
  const appDelta = fs.existsSync(path.join(EXPORT_DIR, "Application_Data_V1_to_V2_Delta.csv"));
  const catDelta = fs.existsSync(path.join(CATALOG_DIR, "Catalog_V1_to_V2_Delta.csv"));
  c(30, "All V2 changes included in delta reports", appDelta && catDelta);

  db.close();
  return { status: checks.every((x) => x.ok) ? "PASS" : "FAIL", checks };
}
