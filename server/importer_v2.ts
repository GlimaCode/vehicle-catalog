/**
 * Phase 2 importer: approved sub-model/variant catalog, sub-model years,
 * sub-model review candidates, and raw-to-canonical hierarchy aliases.
 * Runs after the base runImport() inside the same overall workflow;
 * transactional, idempotent, provenance-preserving.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { CATALOG_DIR, norm } from "./db.js";
import { readCsv, sha256, parseYearRanges } from "./importer.js";
import { withCanonicalUnlocked, CANONICAL_IMPORTER_TOKEN } from "./canonical_lock.js";

export interface V2ImportReport {
  files: { file: string; hash: string; rows: number; imported: number;
    updated: number; rejected: number; errors: string[] }[];
  totals: Record<string, number>;
  status: "SUCCESS" | "ROLLED_BACK";
}

export function detectV2Files(dir: string = CATALOG_DIR) {
  const f = (name: string) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? p : null;
  };
  return {
    submodels: f("Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15_v2.csv"),
    submodelReview: f("Submodel_Validation_Review.csv"),
    hierarchyAliases: f("Make_Model_Submodel_Alias_Mapping.csv"),
  };
}

export function runImportV2(db: Database.Database, dir: string = CATALOG_DIR): V2ImportReport {
  const files = detectV2Files(dir);
  if (!files.submodels) {
    throw new Error("Approved sub-model catalog CSV not found; run the Phase 2 "
      + "research pipeline first.");
  }
  const report: V2ImportReport = { files: [], totals: {}, status: "SUCCESS" };
  const fileRep = (file: string, rows: number) => {
    const fr = { file: path.basename(file), hash: sha256(file), rows,
      imported: 0, updated: 0, rejected: 0, errors: [] as string[] };
    report.files.push(fr);
    return fr;
  };
  const modelId = new Map<string, number>();
  for (const row of db.prepare(
    "SELECT m.id, k.standard_make mk, m.norm_model nm FROM models m JOIN makes k ON k.id=m.make_id")
    .all() as { id: number; mk: string; nm: string }[]) {
    modelId.set(`${row.mk}|${row.nm}`, row.id);
  }

  const tx = db.transaction(() => {
    // ---------------- approved sub-model catalog ----------------
    const subRows = readCsv(files.submodels!);
    const frSub = fileRep(files.submodels!, subRows.length);
    const insSub = db.prepare(`
      INSERT INTO submodels (model_id, standard_submodel, submodel_type,
        first_confirmed_model_year, last_confirmed_model_year, confirmed_model_years,
        validation_status, source_name, source_url, secondary_source_name,
        secondary_source_url, raw_source_value, catalog_origin,
        present_in_original_source, lifecycle_status, vehicle_category, market,
        review_status, notes, norm_submodel)
      VALUES (@model_id,@name,@type,@first,@last,@years,@validation,@psn,@psu,
        @ssn,@ssu,@raw,@origin,@present,@lifecycle,@category,@market,'Approved',
        @notes,@norm)
      ON CONFLICT(model_id, norm_submodel, submodel_type) DO UPDATE SET
        standard_submodel=excluded.standard_submodel,
        first_confirmed_model_year=excluded.first_confirmed_model_year,
        last_confirmed_model_year=excluded.last_confirmed_model_year,
        confirmed_model_years=excluded.confirmed_model_years,
        validation_status=excluded.validation_status,
        source_name=excluded.source_name, source_url=excluded.source_url,
        secondary_source_name=excluded.secondary_source_name,
        secondary_source_url=excluded.secondary_source_url,
        raw_source_value=excluded.raw_source_value,
        catalog_origin=excluded.catalog_origin,
        present_in_original_source=excluded.present_in_original_source,
        lifecycle_status=excluded.lifecycle_status,
        vehicle_category=excluded.vehicle_category,
        review_status='Approved', notes=excluded.notes,
        updated_at=datetime('now')`);
    const insSubYear = db.prepare(`
      INSERT INTO submodel_years (submodel_id, model_year, validation_status,
        source_name, source_url, notes)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(submodel_id, model_year) DO UPDATE SET
        validation_status=excluded.validation_status`);
    for (const r of subRows) {
      const mid = modelId.get(`${r["Standard Make"]}|${norm(r["Standard Model"])}`);
      if (!mid) {
        frSub.rejected++;
        frSub.errors.push(`No canonical model: ${r["Standard Make"]} / ${r["Standard Model"]}`);
        continue;
      }
      const before = db.prepare(
        "SELECT id FROM submodels WHERE model_id=? AND norm_submodel=? AND submodel_type=?")
        .get(mid, norm(r["Standard Sub-model or Variant"]), r["Classification Type"]);
      insSub.run({
        model_id: mid, name: r["Standard Sub-model or Variant"],
        type: r["Classification Type"],
        first: Number(r["First Confirmed Model Year"]),
        last: Number(r["Last Confirmed Model Year"]),
        years: r["Confirmed Model Years"], validation: r["Validation Status"],
        psn: r["Primary Source Name"], psu: r["Primary Source URL"],
        ssn: r["Secondary Source Name"] ?? "", ssu: r["Secondary Source URL"] ?? "",
        raw: r["Raw Source Value"] ?? "", origin: r["Catalog Origin"] ?? "",
        present: r["Present in Original Source"] ?? "No",
        lifecycle: r["Lifecycle Status"] ?? "", category: r["Vehicle Category"] ?? "",
        market: r["Market"] ?? "United States", notes: r["Notes"] ?? "",
        norm: norm(r["Standard Sub-model or Variant"]),
      });
      before ? frSub.updated++ : frSub.imported++;
      const sid = (db.prepare(
        "SELECT id FROM submodels WHERE model_id=? AND norm_submodel=? AND submodel_type=?")
        .get(mid, norm(r["Standard Sub-model or Variant"]),
             r["Classification Type"]) as { id: number }).id;
      for (const y of parseYearRanges(r["Confirmed Model Years"])) {
        insSubYear.run(sid, y, r["Validation Status"],
          r["Primary Source Name"], r["Primary Source URL"], null);
      }
    }
    if (frSub.rejected > 0) {
      throw new Error(`Sub-model rows referencing unknown models: ${frSub.rejected}`);
    }

    // ---------------- sub-model review candidates ----------------
    const revRows = readCsv(files.submodelReview!);
    const frRev = fileRep(files.submodelReview!, revRows.length);
    for (const r of revRows) {
      // candidate uniqueness for sub-model reviews includes the value
      const exists = db.prepare(`SELECT 1 FROM validation_reviews
        WHERE candidate_make=? AND candidate_model=? AND candidate_submodel=?`)
        .get(r["Candidate Make"], r["Candidate Model"], r["Candidate Value"]);
      if (exists) { frRev.updated++; continue; }
      db.prepare(`INSERT INTO validation_reviews (candidate_make, candidate_model,
        candidate_submodel, candidate_model_years, issue_type, reason_not_approved,
        primary_source_name, primary_source_url, secondary_source_name,
        secondary_source_url, recommended_next_action, review_status, notes,
        possible_classification)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(r["Candidate Make"], r["Candidate Model"], r["Candidate Value"],
          r["Candidate Model Years"] ?? "", r["Issue Type"],
          r["Reason Not Approved"], r["Primary Source Name"] ?? "",
          r["Primary Source URL"] ?? "", r["Secondary Source Name"] ?? "",
          r["Secondary Source URL"] ?? "", r["Recommended Next Action"] ?? "",
          r["Review Status"] ?? "Pending", r["Notes"] ?? "",
          r["Possible Classification"] ?? "");
      frRev.imported++;
    }

    // ---------------- hierarchy aliases ----------------
    const alRows = readCsv(files.hierarchyAliases!);
    const frAl = fileRep(files.hierarchyAliases!, alRows.length);
    for (const r of alRows) {
      const mid = modelId.get(`${r["Canonical Make"]}|${norm(r["Canonical Model"])}`) ?? null;
      let sid: number | null = null;
      if (mid && r["Canonical Sub-model or Variant"]) {
        const s = db.prepare(
          "SELECT id FROM submodels WHERE model_id=? AND norm_submodel=? AND submodel_type=?")
          .get(mid, norm(r["Canonical Sub-model or Variant"]),
               r["Canonical Classification Type"]) as { id: number } | undefined;
        sid = s?.id ?? null;
      }
      const mkId = mid ? (db.prepare("SELECT make_id FROM models WHERE id=?")
        .get(mid) as { make_id: number }).make_id : null;
      const res = db.prepare(`
        INSERT INTO aliases (raw_or_alias_make, raw_or_alias_model,
          raw_or_alias_submodel, canonical_make_id, canonical_model_id,
          canonical_submodel_id, alias_type, source_file_or_source_name,
          confidence, notes, norm_make, norm_model)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(norm_make, norm_model, alias_type) DO NOTHING`)
        .run(r["Raw Make"], r["Raw Model"], r["Raw Sub-model or Variant"] ?? "",
          mkId, mid, sid, r["Alias Type"], r["Source"] ?? "",
          r["Confidence"] ?? "", r["Notes"] ?? "",
          norm(r["Raw Make"]), norm(r["Raw Model"] + " " +
            (r["Raw Sub-model or Variant"] ?? "")));
      res.changes ? frAl.imported++ : frAl.updated++;
    }

    // ---------------- import log ----------------
    for (const fr of report.files) {
      db.prepare(`INSERT INTO import_runs (input_filename, input_file_hash, rows_read,
        rows_imported, rows_updated, rows_rejected, validation_status, error_log, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(fr.file, fr.hash, fr.rows, fr.imported, fr.updated, fr.rejected,
          fr.errors.length ? "Completed with warnings" : "Validated",
          fr.errors.slice(0, 50).join("\n") || null, "Phase 2 hierarchy import");
    }
    db.prepare(`INSERT INTO catalog_meta (key, value) VALUES ('catalog_version','V2')
      ON CONFLICT(key) DO UPDATE SET value='V2'`).run();

    // ---------------- mandatory validations ----------------
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const bad: string[] = [];
    if (n(`SELECT COUNT(*) n FROM submodels s LEFT JOIN models m ON m.id=s.model_id
           WHERE m.id IS NULL`) > 0) bad.push("orphan submodels");
    if (n(`SELECT COUNT(*) n FROM submodel_years sy LEFT JOIN submodels s
           ON s.id=sy.submodel_id WHERE s.id IS NULL`) > 0) bad.push("orphan submodel years");
    if (n(`SELECT COUNT(*) n FROM submodels WHERE review_status='Approved'
           AND validation_status NOT IN
           ('Fully Verified','Government Verified','Manufacturer Verified')`) > 0) {
      bad.push("approved submodel with non-approved validation status");
    }
    if (bad.length) throw new Error("V2 mandatory validation failed: " + bad.join("; "));
  });

  try {
    withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, tx);
  } catch (e) {
    report.status = "ROLLED_BACK";
    throw Object.assign(e as Error, { report });
  }
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  report.totals = {
    approved_submodels: n(`SELECT COUNT(*) n FROM submodels WHERE review_status='Approved'
      AND validation_status IN ('Fully Verified','Government Verified','Manufacturer Verified')`),
    submodel_years: n("SELECT COUNT(*) n FROM submodel_years"),
    review_rows: n("SELECT COUNT(*) n FROM validation_reviews"),
    aliases: n("SELECT COUNT(*) n FROM aliases"),
  };
  return report;
}
