/**
 * Phase 3 importer: loads the audited vehicle-hierarchy and
 * vehicle-configuration catalogs into their separate tables, applies
 * candidate priorities, and registers dataset-level source terminology.
 * Transactional and idempotent; never deletes.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { CATALOG_DIR, norm } from "./db.js";
import { readCsv, sha256, parseYearRanges } from "./importer.js";
import { withCanonicalUnlocked, CANONICAL_IMPORTER_TOKEN } from "./canonical_lock.js";

const HIER = "US_Vehicle_Hierarchy_Values_2026-07-15_v3.csv";
const CONF = "US_Vehicle_Configuration_Values_2026-07-15_v3.csv";
const SUBREV = "Submodel_Validation_Review_v3.csv";

export function detectV3Files(dir: string = CATALOG_DIR) {
  const f = (n: string) => (fs.existsSync(path.join(dir, n)) ? path.join(dir, n) : null);
  return { hierarchy: f(HIER), configuration: f(CONF), subReview: f(SUBREV) };
}

export function runImportV3(db: Database.Database, dir: string = CATALOG_DIR) {
  const files = detectV3Files(dir);
  if (!files.hierarchy || !files.configuration) {
    throw new Error("V3 hierarchy/configuration catalogs not found; run audit_v3.py first.");
  }
  const report = { files: [] as { file: string; hash: string; rows: number;
    imported: number; updated: number; rejected: number }[], totals: {} as Record<string, number> };
  const modelId = new Map<string, number>();
  for (const row of db.prepare(
    "SELECT m.id, k.standard_make mk, m.norm_model nm FROM models m JOIN makes k ON k.id=m.make_id")
    .all() as { id: number; mk: string; nm: string }[]) {
    modelId.set(`${row.mk}|${row.nm}`, row.id);
  }

  const importValues = (file: string, table: string, yearTable: string, fk: string) => {
    const rows = readCsv(file);
    const fr = { file: path.basename(file), hash: sha256(file), rows: rows.length,
      imported: 0, updated: 0, rejected: 0 };
    report.files.push(fr);
    const ins = db.prepare(`
      INSERT INTO ${table} (model_id, value, classification_type,
        confirmed_model_years, first_confirmed_model_year, last_confirmed_model_year,
        validation_status, raw_source_value, source_name, source_url,
        secondary_source_name, secondary_source_url, source_access_date,
        source_organization_count, source_dataset_count, notes, norm_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(model_id, norm_value, classification_type) DO UPDATE SET
        value=excluded.value,
        confirmed_model_years=excluded.confirmed_model_years,
        first_confirmed_model_year=excluded.first_confirmed_model_year,
        last_confirmed_model_year=excluded.last_confirmed_model_year,
        validation_status=excluded.validation_status,
        raw_source_value=excluded.raw_source_value,
        notes=excluded.notes`);
    const insYear = db.prepare(`
      INSERT INTO ${yearTable} (${fk}, model_year, validation_status, source_name,
        source_url, notes)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(${fk}, model_year) DO UPDATE SET
        validation_status=excluded.validation_status`);
    for (const r of rows) {
      const mid = modelId.get(`${r["Standard Make"]}|${norm(r["Standard Model"])}`);
      if (!mid) { fr.rejected++; continue; }
      const before = db.prepare(
        `SELECT id FROM ${table} WHERE model_id=? AND norm_value=? AND classification_type=?`)
        .get(mid, norm(r["Standard Sub-model or Variant"]), r["Classification Type"]);
      const orgs = (r["Secondary Source Name"] ?? "").includes("NHTSA") ? 2 : 1;
      ins.run(mid, r["Standard Sub-model or Variant"], r["Classification Type"],
        r["Confirmed Model Years"], Number(r["First Confirmed Model Year"]),
        Number(r["Last Confirmed Model Year"]), r["Validation Status"],
        r["Raw Source Value"] ?? "", r["Primary Source Name"], r["Primary Source URL"],
        r["Secondary Source Name"] ?? "", r["Secondary Source URL"] ?? "",
        r["Source Access Date"] ?? "", orgs, orgs, r["Notes"] ?? "",
        norm(r["Standard Sub-model or Variant"]));
      before ? fr.updated++ : fr.imported++;
      const vid = (db.prepare(
        `SELECT id FROM ${table} WHERE model_id=? AND norm_value=? AND classification_type=?`)
        .get(mid, norm(r["Standard Sub-model or Variant"]),
             r["Classification Type"]) as { id: number }).id;
      for (const y of parseYearRanges(r["Confirmed Model Years"])) {
        insYear.run(vid, y, r["Validation Status"], r["Primary Source Name"],
          r["Primary Source URL"], null);
      }
    }
    if (fr.rejected > 0) {
      throw new Error(`${path.basename(file)}: ${fr.rejected} rows reference unknown models`);
    }
  };

  const tx = db.transaction(() => {
    importValues(files.hierarchy!, "vehicle_hierarchy_values",
      "hierarchy_value_years", "hierarchy_value_id");
    importValues(files.configuration!, "vehicle_configuration_values",
      "configuration_value_years", "configuration_value_id");

    // sub-model review candidates with priorities
    if (files.subReview) {
      const rows = readCsv(files.subReview);
      const fr = { file: path.basename(files.subReview), hash: sha256(files.subReview),
        rows: rows.length, imported: 0, updated: 0, rejected: 0 };
      report.files.push(fr);
      for (const r of rows) {
        const exists = db.prepare(`SELECT id FROM validation_reviews
          WHERE candidate_make=? AND candidate_model=? AND candidate_submodel=?`)
          .get(r["Candidate Make"], r["Candidate Model"], r["Candidate Value"]);
        if (exists) {
          db.prepare("UPDATE validation_reviews SET priority=? WHERE id=?")
            .run(r["Priority"] ?? "", (exists as { id: number }).id);
          fr.updated++;
        } else {
          db.prepare(`INSERT OR IGNORE INTO validation_reviews (candidate_make,
            candidate_model, candidate_submodel, candidate_model_years, issue_type,
            reason_not_approved, primary_source_name, primary_source_url,
            secondary_source_name, secondary_source_url, recommended_next_action,
            review_status, notes, possible_classification, priority)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(r["Candidate Make"], r["Candidate Model"], r["Candidate Value"],
              r["Candidate Model Years"] ?? "", r["Issue Type"],
              r["Reason Not Approved"], r["Primary Source Name"] ?? "",
              r["Primary Source URL"] ?? "", r["Secondary Source Name"] ?? "",
              r["Secondary Source URL"] ?? "", r["Recommended Next Action"] ?? "",
              r["Review Status"] ?? "Pending", r["Notes"] ?? "",
              r["Possible Classification"] ?? "", r["Priority"] ?? "");
          fr.imported++;
        }
      }
    }
    // model-level priorities from the v3 review file
    const mrev = path.join(dir, "Make_Model_Validation_Review_v3.csv");
    if (fs.existsSync(mrev)) {
      for (const r of readCsv(mrev)) {
        db.prepare(`UPDATE validation_reviews SET priority=?
          WHERE candidate_make=? AND candidate_model=?
          AND COALESCE(candidate_submodel,'')='' AND issue_type=?`)
          .run(r["Priority"] ?? "", r["Candidate Make"], r["Candidate Model"],
            r["Issue Type"]);
      }
    }

    // organization/dataset counts on models (from the v3 master extra columns)
    const masterV3 = path.join(dir, "Complete_US_Make_Model_Catalog_1980_to_2026-07-15_v3.csv");
    if (fs.existsSync(masterV3)) {
      for (const r of readCsv(masterV3)) {
        const mid = modelId.get(`${r["Standard Make"]}|${norm(r["Standard Model"])}`);
        if (mid && r["Source Organization Count"]) {
          db.prepare(`UPDATE models SET source_organization_count=?,
            source_dataset_count=? WHERE id=?`)
            .run(Number(r["Source Organization Count"]),
                 Number(r["Source Dataset Count"]), mid);
        }
      }
    }

    // dataset-level source registry terminology
    const upd = db.prepare(`UPDATE sources SET source_organization=?, source_dataset=?,
      evidence_type=? WHERE source_name LIKE ?`);
    upd.run("EPA", "FuelEconomy.gov vehicle dataset",
      "Fuel-economy certification records", "%FuelEconomy%");
    upd.run("NHTSA", "Recall (Product Information Catalog)",
      "Safety Recall Record", "%Product Information Catalog%");
    db.prepare(`INSERT INTO sources (source_name, source_url, source_type, access_date,
        evidence_type, known_limitations, notes, source_organization, source_dataset)
      VALUES ('NHTSA vPIC (VIN product data)',
        'https://vpic.nhtsa.dot.gov/api/vehicles/GetModelsForMake/{make}?format=json',
        'US Government API', '2026-07-18',
        'Manufacturer-Reported Vehicle Product Data',
        'No per-year breakdown; same organization as the Recall dataset - '
        || 'cross-dataset confirmation, not an independent organization.',
        'Used for V2/V3 external completeness validation.',
        'NHTSA', 'vPIC')
      ON CONFLICT(source_name) DO UPDATE SET source_organization='NHTSA',
        source_dataset='vPIC',
        evidence_type='Manufacturer-Reported Vehicle Product Data'`).run();
    db.prepare(`INSERT INTO sources (source_name, source_url, source_type, access_date,
        evidence_type, known_limitations, notes, source_organization, source_dataset)
      VALUES ('EPA FuelEconomy.gov historical dataset (1980-1983)',
        'https://www.fueleconomy.gov/feg/epadata/80data.zip',
        'US Government dataset (fixed-width .DAT in legacy ZIP)', '2026-07-18',
        'Fuel-economy certification records (historical)',
        'Legacy PKWARE implode compression requires a compatible extractor; '
        || 'fixed-width layout parsed by the audit_v3 parser.',
        'Corrects the Phase 2 statement; provides EPA coverage for MY1980-1983.',
        'EPA', 'FuelEconomy historical 1980-83')
      ON CONFLICT(source_name) DO UPDATE SET source_organization='EPA'`).run();

    for (const fr of report.files) {
      db.prepare(`INSERT INTO import_runs (input_filename, input_file_hash, rows_read,
        rows_imported, rows_updated, rows_rejected, validation_status, error_log, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(fr.file, fr.hash, fr.rows, fr.imported, fr.updated, fr.rejected,
          "Validated", null, "Phase 3 hierarchy/configuration import");
    }
    db.prepare(`INSERT INTO catalog_meta (key, value) VALUES ('catalog_version','V3')
      ON CONFLICT(key) DO UPDATE SET value='V3'`).run();

    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const bad: string[] = [];
    if (n(`SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type
        NOT IN ('Sub-model','Trim','Series','Edition','Generation','Chassis')`) > 0) {
      bad.push("non-hierarchy type in hierarchy table");
    }
    if (n(`SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type
        NOT IN ('Engine Variant','Drivetrain Variant','Body Style','Package',
        'Commercial Configuration')`) > 0) {
      bad.push("non-configuration type in configuration table");
    }
    if (bad.length) throw new Error("V3 mandatory validation failed: " + bad.join("; "));
  });
  withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, tx);

  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  report.totals = {
    hierarchy_values: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
    hierarchy_years: n("SELECT COUNT(*) n FROM hierarchy_value_years"),
    configuration_values: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
    configuration_years: n("SELECT COUNT(*) n FROM configuration_value_years"),
  };
  return report;
}
