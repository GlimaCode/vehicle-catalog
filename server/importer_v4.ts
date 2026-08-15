/**
 * Phase 4 importer: layers the researched hierarchy additions onto a V3-built
 * database, updates research outcomes on review candidates, imports the
 * official source index, and records V4 configuration additions.
 * Transactional, idempotent, never deletes a V3 hierarchy value.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { CATALOG_DIR, norm } from "./db.js";
import { readCsv, sha256, parseYearRanges } from "./importer.js";
import { withCanonicalUnlocked, CANONICAL_IMPORTER_TOKEN } from "./canonical_lock.js";

const HIER_V4 = "Complete_US_Vehicle_Hierarchy_1980_to_2026-07-15_v4.csv";
const CONF_ADD = "US_Vehicle_Configuration_Additions_v4.csv";
const AUDIT = "High_Priority_Trim_Research_Audit.csv";
const SRC_IDX = "Official_Hierarchy_Source_Index.csv";

export function detectV4Files(dir: string = CATALOG_DIR) {
  const f = (n: string) => (fs.existsSync(path.join(dir, n)) ? path.join(dir, n) : null);
  return { hierarchy: f(HIER_V4), confAdd: f(CONF_ADD), audit: f(AUDIT), srcIdx: f(SRC_IDX) };
}

export function runImportV4(db: Database.Database, dir: string = CATALOG_DIR) {
  const files = detectV4Files(dir);
  if (!files.hierarchy || !files.audit) {
    throw new Error("V4 hierarchy/audit files not found; run research_v4.py first.");
  }
  const report = { files: [] as Record<string, unknown>[], totals: {} as Record<string, number> };
  const modelId = new Map<string, number>();
  for (const row of db.prepare(
    "SELECT m.id, k.standard_make mk, m.norm_model nm FROM models m JOIN makes k ON k.id=m.make_id")
    .all() as { id: number; mk: string; nm: string }[]) {
    modelId.set(`${row.mk}|${row.nm}`, row.id);
  }

  const tx = db.transaction(() => {
    // ---- hierarchy V4 (upsert; V3 rows update in place, new rows insert) ----
    const rows = readCsv(files.hierarchy!);
    const fr = { file: HIER_V4, hash: sha256(files.hierarchy!), rows: rows.length,
      imported: 0, updated: 0, rejected: 0 };
    report.files.push(fr);
    const ins = db.prepare(`
      INSERT INTO vehicle_hierarchy_values (model_id, value, classification_type,
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
        source_organization_count=excluded.source_organization_count,
        source_dataset_count=excluded.source_dataset_count,
        notes=excluded.notes`);
    const insYear = db.prepare(`
      INSERT INTO hierarchy_value_years (hierarchy_value_id, model_year,
        validation_status, source_name, source_url, notes)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(hierarchy_value_id, model_year) DO UPDATE SET
        validation_status=excluded.validation_status`);
    for (const r of rows) {
      const mid = modelId.get(`${r["Standard Make"]}|${norm(r["Standard Model"])}`);
      if (!mid) { fr.rejected++; continue; }
      const before = db.prepare(
        `SELECT id FROM vehicle_hierarchy_values WHERE model_id=? AND norm_value=?
         AND classification_type=?`)
        .get(mid, norm(r["Standard Hierarchy Value"]), r["Classification Type"]);
      ins.run(mid, r["Standard Hierarchy Value"], r["Classification Type"],
        r["Confirmed Model Years"], Number(r["First Confirmed Model Year"]),
        Number(r["Last Confirmed Model Year"]), r["Validation Status"],
        r["Raw Source Value"] ?? "", r["Primary Source Document"],
        r["Primary Source URL"], r["Secondary Source Document"] ?? "",
        r["Secondary Source URL"] ?? "", r["Source Access Date"] ?? "",
        Number(r["Source Organization Count"] || 1),
        Number(r["Source Dataset Count"] || 1), r["Notes"] ?? "",
        norm(r["Standard Hierarchy Value"]));
      before ? fr.updated++ : fr.imported++;
      const vid = (db.prepare(
        `SELECT id FROM vehicle_hierarchy_values WHERE model_id=? AND norm_value=?
         AND classification_type=?`)
        .get(mid, norm(r["Standard Hierarchy Value"]),
             r["Classification Type"]) as { id: number }).id;
      for (const y of parseYearRanges(r["Confirmed Model Years"])) {
        insYear.run(vid, y, r["Validation Status"], r["Primary Source Document"],
          r["Primary Source URL"], null);
      }
    }
    if (fr.rejected > 0) throw new Error(`${fr.rejected} V4 hierarchy rows reference unknown models`);

    // ---- configuration additions ----
    if (files.confAdd) {
      const crows = readCsv(files.confAdd);
      const cf = { file: CONF_ADD, hash: sha256(files.confAdd), rows: crows.length,
        imported: 0, updated: 0, rejected: 0 };
      report.files.push(cf);
      for (const r of crows) {
        const mid = modelId.get(`${r["Standard Make"]}|${norm(r["Standard Model"])}`);
        if (!mid) { cf.rejected++; continue; }
        const before = db.prepare(
          `SELECT id FROM vehicle_configuration_values WHERE model_id=? AND norm_value=?
           AND classification_type=?`)
          .get(mid, norm(r["Standard Sub-model or Variant"]), r["Classification Type"]);
        db.prepare(`
          INSERT INTO vehicle_configuration_values (model_id, value, classification_type,
            confirmed_model_years, first_confirmed_model_year, last_confirmed_model_year,
            validation_status, raw_source_value, source_name, source_url,
            source_access_date, notes, norm_value)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(model_id, norm_value, classification_type) DO UPDATE SET
            confirmed_model_years=excluded.confirmed_model_years,
            validation_status=excluded.validation_status, notes=excluded.notes`)
          .run(mid, r["Standard Sub-model or Variant"], r["Classification Type"],
            r["Confirmed Model Years"], Number(r["First Confirmed Model Year"]),
            Number(r["Last Confirmed Model Year"]), r["Validation Status"],
            r["Raw Source Value"] ?? "", r["Primary Source Name"],
            r["Primary Source URL"], r["Source Access Date"] ?? "",
            r["Notes"] ?? "", norm(r["Standard Sub-model or Variant"]));
        before ? cf.updated++ : cf.imported++;
        const vid = (db.prepare(
          `SELECT id FROM vehicle_configuration_values WHERE model_id=? AND norm_value=?
           AND classification_type=?`)
          .get(mid, norm(r["Standard Sub-model or Variant"]),
               r["Classification Type"]) as { id: number }).id;
        for (const y of parseYearRanges(r["Confirmed Model Years"])) {
          db.prepare(`INSERT INTO configuration_value_years (configuration_value_id,
            model_year, validation_status, source_name, source_url, notes)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(configuration_value_id, model_year) DO UPDATE SET
              validation_status=excluded.validation_status`)
            .run(vid, y, r["Validation Status"], r["Primary Source Name"],
              r["Primary Source URL"], null);
        }
      }
    }

    // ---- research outcomes onto review candidates ----
    const arows = readCsv(files.audit!);
    const af = { file: AUDIT, hash: sha256(files.audit!), rows: arows.length,
      imported: 0, updated: 0, rejected: 0 };
    report.files.push(af);
    for (const r of arows) {
      const outcome = r["Research Outcome"];
      const status = outcome.startsWith("Approved") ? "Approved"
        : outcome === "Duplicate of Existing Canonical Value" ? "Corrected"
        : outcome === "Source Artifact" ? "Rejected"
        : "Needs More Evidence";
      const res = db.prepare(`UPDATE validation_reviews SET review_status=?,
        notes=COALESCE(notes,'') || ' [V4 research: ' || ? || ']'
        WHERE candidate_make=? AND candidate_model=? AND candidate_submodel=?
        AND review_status='Pending'`)
        .run(status, outcome, r["Standard Make"], r["Standard Model"],
             r["Candidate Value"]);
      if (res.changes) af.updated++;
    }

    // ---- official source index into sources table ----
    if (files.srcIdx) {
      for (const r of readCsv(files.srcIdx)) {
        db.prepare(`INSERT INTO sources (source_name, source_url, source_type,
            access_date, evidence_type, known_limitations, notes,
            source_organization, source_dataset)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(source_name) DO UPDATE SET source_url=excluded.source_url,
            notes=excluded.notes`)
          .run(r["Document Title"], r["Source URL"], r["Document Type"],
            r["Access Date"], r["Document Type"], "",
            `V4 hierarchy research source (${r["Source ID"]}); supports ` +
            `${r["Candidates Supported"]} candidate(s). ${r["Notes"] ?? ""}`,
            r["Source Organization"], r["Document Title"]);
      }
    }

    for (const fx of report.files) {
      db.prepare(`INSERT INTO import_runs (input_filename, input_file_hash, rows_read,
        rows_imported, rows_updated, rows_rejected, validation_status, error_log, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(fx.file, fx.hash, fx.rows, fx.imported, fx.updated, fx.rejected,
          "Validated", null, "Phase 4 hierarchy research import");
    }
    db.prepare(`INSERT INTO catalog_meta (key, value) VALUES ('catalog_version','V4')
      ON CONFLICT(key) DO UPDATE SET value='V4'`).run();
  });
  withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, tx);

  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  report.totals = {
    hierarchy_values: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
    hierarchy_years: n("SELECT COUNT(*) n FROM hierarchy_value_years"),
    configuration_values: n("SELECT COUNT(*) n FROM vehicle_configuration_values"),
    sources: n("SELECT COUNT(*) n FROM sources"),
  };
  return report;
}
