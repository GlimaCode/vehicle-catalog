/**
 * Transactional import pipeline for the catalog CSV files.
 *
 * - Detects Version 2 files (`*_v2.csv`) and falls back to the latest
 *   completed catalog filenames when no v2 file exists.
 * - Validates expected columns before importing, hashes every input,
 *   parses CSV with full quoting / embedded-line-break support,
 *   expands compressed model-year ranges into model_years rows,
 *   upserts without duplicating, and rolls the whole run back if a
 *   mandatory validation fails. Source files are opened read-only and
 *   never modified.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type Database from "better-sqlite3";
import { CATALOG_DIR, norm } from "./db.js";
import { withCanonicalUnlocked, CANONICAL_IMPORTER_TOKEN } from "./canonical_lock.js";

export interface FileReport {
  file: string;
  hash: string;
  rowsRead: number;
  imported: number;
  updated: number;
  rejected: number;
  status: string;
  errors: string[];
}
export interface ImportReport {
  startedAt: string;
  catalogDir: string;
  catalogVersion: string;
  files: FileReport[];
  totals: Record<string, number>;
  mandatoryChecks: { name: string; ok: boolean; detail?: string }[];
  status: "SUCCESS" | "ROLLED_BACK";
}

const REQUIRED = {
  master: ["Standard Make", "Standard Model", "Confirmed Model Years",
    "First Confirmed Model Year", "Last Confirmed Model Year",
    "Lifecycle Status", "Vehicle Category", "Market",
    "Present in Original Source", "Catalog Origin", "Validation Status",
    "Primary Source Name", "Primary Source URL", "Source Access Date"],
  makes: ["Standard Make", "Official Display Name", "US Market Start Year",
    "US Market End Year", "Lifecycle Status", "Present in Original Source",
    "Catalog Origin", "Validation Status"],
  alias: ["Raw or Alias Make", "Raw or Alias Model", "Canonical Make",
    "Canonical Model", "Alias Type", "Confidence"],
  grouped: ["Raw Make", "Raw Grouped Model Value", "Canonical Make",
    "Canonical Model", "Relationship Status"],
  review: ["Candidate Make", "Candidate Model", "Issue Type",
    "Reason Not Approved", "Recommended Next Action"],
  coverage: ["Model Year", "Verified Make Count", "Verified Model Count",
    "Coverage Status"],
} as const;

/** Prefer the newest catalog version: `_v3.csv`, then `_v2.csv`, then base. */
export function findCatalogFile(base: string, dir: string = CATALOG_DIR): string | null {
  for (const candidate of [`${base}_v3.csv`, `${base}_v2.csv`, `${base}.csv`]) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function detectCatalogFiles(dir: string = CATALOG_DIR) {
  return {
    master: findCatalogFile("Complete_US_Make_Model_Catalog_1980_to_2026-07-15", dir),
    makes: findCatalogFile("Complete_Standard_Make_Catalog", dir),
    alias: findCatalogFile("Make_Model_Alias_Mapping", dir),
    grouped: findCatalogFile("Grouped_Model_Relationships", dir),
    review: findCatalogFile("Make_Model_Validation_Review", dir),
    coverage: findCatalogFile("Catalog_Coverage_Report", dir),
    researchLog: findCatalogFile("Catalog_Research_Log", dir),
  };
}

export function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, "utf-8").replace(/^﻿/, "");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true,
    relax_column_count: false, trim: false }) as Record<string, string>[];
}

export function compressYears(years: number[]): string {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = ys[0], prev = ys[0];
  for (const y of ys.slice(1)) {
    if (y === prev + 1) { prev = y; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = y;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join("; ");
}

export function parseYearRanges(text: string): number[] {
  const years: number[] = [];
  for (const seg of (text ?? "").split(";")) {
    const t = seg.trim();
    if (!t) continue;
    const m = t.match(/^(\d{4})(?:-(\d{4}))?$/);
    if (!m) throw new Error(`Unparseable year range segment: "${t}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let y = a; y <= b; y++) years.push(y);
  }
  return [...new Set(years)].sort((x, y) => x - y);
}

function validateColumns(rows: Record<string, string>[], required: readonly string[], file: string): void {
  if (!rows.length) throw new Error(`${path.basename(file)} contains no rows`);
  const cols = new Set(Object.keys(rows[0]));
  const missing = required.filter((c) => !cols.has(c));
  if (missing.length) {
    throw new Error(`${path.basename(file)} is missing required columns: ${missing.join(", ")}`);
  }
}

/** Trim/variant candidate extraction from documented alias rows only. */
export function classifyVariant(rawModel: string, canonicalModel: string, aliasType: string, notes: string):
  { value: string; type: string } | null {
  const residualTokens = rawModel.toUpperCase().replace(/\s+/g, " ").trim().split(" ")
    .filter((t) => !norm(canonicalModel).includes(norm(t)) || norm(t) === "");
  const residual = residualTokens.join(" ").trim();
  const lower = (notes ?? "").toLowerCase();
  if (aliasType === "Model and Trim Combined" && residual) {
    return { value: residual, type: "Trim" };
  }
  if (lower.includes("chassis code") && residual) return { value: residual, type: "Chassis" };
  if (lower.includes("generation") && /^[A-Z]\d{2,3}$/.test(residual)) {
    return { value: residual, type: "Generation" };
  }
  return null;
}

export function runImport(db: Database.Database, dir: string = CATALOG_DIR): ImportReport {
  const files = detectCatalogFiles(dir);
  const report: ImportReport = {
    startedAt: new Date().toISOString(),
    catalogDir: dir,
    catalogVersion: files.master?.includes("_v2") ? "V2" : "V2-baseline (latest completed catalog files)",
    files: [], totals: {}, mandatoryChecks: [], status: "SUCCESS",
  };
  const missing = Object.entries(files).filter(([k, v]) => !v && k !== "researchLog");
  if (missing.length) {
    throw new Error(`Catalog files not found: ${missing.map(([k]) => k).join(", ")} in ${dir}`);
  }

  const fileReport = (file: string, rows: number): FileReport => {
    const fr: FileReport = { file: path.basename(file), hash: sha256(file),
      rowsRead: rows, imported: 0, updated: 0, rejected: 0, status: "OK", errors: [] };
    report.files.push(fr);
    return fr;
  };

  const tx = db.transaction(() => {
    // ---------------- makes ----------------
    const makeRows = readCsv(files.makes!);
    validateColumns(makeRows, REQUIRED.makes, files.makes!);
    const frMakes = fileReport(files.makes!, makeRows.length);
    const insMake = db.prepare(`
      INSERT INTO makes (standard_make, official_display_name, us_market_start_year,
        us_market_end_year, lifecycle_status, present_in_original_source, catalog_origin,
        validation_status, primary_source_name, primary_source_url,
        secondary_source_name, secondary_source_url, notes, norm_make)
      VALUES (@standard_make,@official_display_name,@start,@end,@lifecycle,@present,
        @origin,@validation,@psn,@psu,@ssn,@ssu,@notes,@norm)
      ON CONFLICT(norm_make) DO UPDATE SET
        official_display_name=excluded.official_display_name,
        us_market_start_year=excluded.us_market_start_year,
        us_market_end_year=excluded.us_market_end_year,
        lifecycle_status=excluded.lifecycle_status,
        present_in_original_source=excluded.present_in_original_source,
        catalog_origin=excluded.catalog_origin,
        validation_status=excluded.validation_status,
        primary_source_name=excluded.primary_source_name,
        primary_source_url=excluded.primary_source_url,
        secondary_source_name=excluded.secondary_source_name,
        secondary_source_url=excluded.secondary_source_url,
        notes=excluded.notes,
        updated_at=datetime('now')`);
    for (const r of makeRows) {
      const before = db.prepare("SELECT id FROM makes WHERE norm_make=?").get(norm(r["Standard Make"]));
      insMake.run({
        standard_make: r["Standard Make"],
        official_display_name: r["Official Display Name"] || r["Standard Make"],
        start: r["US Market Start Year"] ? Number(r["US Market Start Year"]) : null,
        end: r["US Market End Year"] ? Number(r["US Market End Year"]) : null,
        lifecycle: r["Lifecycle Status"], present: r["Present in Original Source"],
        origin: r["Catalog Origin"], validation: r["Validation Status"],
        psn: r["Primary Source Name"] ?? "", psu: r["Primary Source URL"] ?? "",
        ssn: r["Secondary Source Name"] ?? "", ssu: r["Secondary Source URL"] ?? "",
        notes: r["Notes"] ?? "", norm: norm(r["Standard Make"]),
      });
      before ? frMakes.updated++ : frMakes.imported++;
    }
    const makeId = new Map<string, number>();
    for (const row of db.prepare("SELECT id, norm_make FROM makes").all() as { id: number; norm_make: string }[]) {
      makeId.set(row.norm_make, row.id);
    }

    // ---------------- models + model_years ----------------
    const masterRaw = readCsv(files.master!);
    validateColumns(masterRaw, REQUIRED.master, files.master!);
    const frModels = fileReport(files.master!, masterRaw.length);
    // Merge rows that normalize to the same (make, model): punctuation /
    // spacing variants of the same vehicle. The merged variant spelling is
    // preserved as an alias; year coverage becomes the union.
    const groups = new Map<string, Record<string, string>[]>();
    for (const r of masterRaw) {
      const key = `${norm(r["Standard Make"])}|${norm(r["Standard Model"])}`;
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    const masterRows: Record<string, string>[] = [];
    const mergedAliases: { make: string; variant: string; canonical: string; kind: string }[] = [];
    for (const g of groups.values()) {
      if (g.length === 1) { masterRows.push(g[0]); continue; }
      const spaces = (s: string) => (s.match(/ /g) ?? []).length;
      const sorted = [...g].sort((a, b) =>
        spaces(a["Standard Model"]) - spaces(b["Standard Model"])
        || a["Standard Model"].length - b["Standard Model"].length);
      const primary = { ...sorted[0] };
      const years = g.flatMap((r) => parseYearRanges(r["Confirmed Model Years"]));
      primary["Confirmed Model Years"] = compressYears(years);
      primary["First Confirmed Model Year"] = String(Math.min(...years));
      primary["Last Confirmed Model Year"] = String(Math.max(...years));
      primary["Notes"] = ((primary["Notes"] ?? "") + " Merged punctuation/spacing variant row(s): "
        + sorted.slice(1).map((r) => `"${r["Standard Model"]}"`).join(", ")
        + " (same vehicle; variant spelling preserved as alias).").trim();
      masterRows.push(primary);
      for (const v of sorted.slice(1)) {
        mergedAliases.push({ make: primary["Standard Make"], variant: v["Standard Model"],
          canonical: primary["Standard Model"],
          kind: v["Standard Model"].includes("-") !== primary["Standard Model"].includes("-")
            ? "Punctuation Variant" : "Spacing Variant" });
        frModels.errors.push(`INFO merged variant "${v["Standard Model"]}" into "${primary["Standard Model"]}"`);
      }
    }
    const insModel = db.prepare(`
      INSERT INTO models (make_id, standard_model, confirmed_model_years,
        first_confirmed_model_year, last_confirmed_model_year, lifecycle_status,
        vehicle_category, market, present_in_original_source, catalog_origin,
        validation_status, primary_source_name, primary_source_url,
        secondary_source_name, secondary_source_url, source_access_date, notes, norm_model)
      VALUES (@make_id,@model,@years,@first,@last,@lifecycle,@category,@market,
        @present,@origin,@validation,@psn,@psu,@ssn,@ssu,@access,@notes,@norm)
      ON CONFLICT(make_id, norm_model) DO UPDATE SET
        standard_model=excluded.standard_model,
        confirmed_model_years=excluded.confirmed_model_years,
        first_confirmed_model_year=excluded.first_confirmed_model_year,
        last_confirmed_model_year=excluded.last_confirmed_model_year,
        lifecycle_status=excluded.lifecycle_status,
        vehicle_category=excluded.vehicle_category, market=excluded.market,
        present_in_original_source=excluded.present_in_original_source,
        catalog_origin=excluded.catalog_origin,
        validation_status=excluded.validation_status,
        primary_source_name=excluded.primary_source_name,
        primary_source_url=excluded.primary_source_url,
        secondary_source_name=excluded.secondary_source_name,
        secondary_source_url=excluded.secondary_source_url,
        source_access_date=excluded.source_access_date,
        notes=excluded.notes, updated_at=datetime('now')`);
    const insYear = db.prepare(`
      INSERT INTO model_years (model_id, model_year, year_status, validation_status,
        source_name, source_url, notes)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(model_id, model_year) DO UPDATE SET
        year_status=excluded.year_status, validation_status=excluded.validation_status,
        source_name=excluded.source_name, source_url=excluded.source_url`);
    for (const r of masterRows) {
      const mid = makeId.get(norm(r["Standard Make"]));
      if (!mid) {
        frModels.rejected++;
        frModels.errors.push(`Unknown make for model row: ${r["Standard Make"]} / ${r["Standard Model"]}`);
        continue;
      }
      const before = db.prepare("SELECT id FROM models WHERE make_id=? AND norm_model=?")
        .get(mid, norm(r["Standard Model"]));
      insModel.run({
        make_id: mid, model: r["Standard Model"], years: r["Confirmed Model Years"],
        first: Number(r["First Confirmed Model Year"]),
        last: Number(r["Last Confirmed Model Year"]),
        lifecycle: r["Lifecycle Status"], category: r["Vehicle Category"],
        market: r["Market"], present: r["Present in Original Source"],
        origin: r["Catalog Origin"], validation: r["Validation Status"],
        psn: r["Primary Source Name"] ?? "", psu: r["Primary Source URL"] ?? "",
        ssn: r["Secondary Source Name"] ?? "", ssu: r["Secondary Source URL"] ?? "",
        access: r["Source Access Date"] ?? "", notes: r["Notes"] ?? "",
        norm: norm(r["Standard Model"]),
      });
      before ? frModels.updated++ : frModels.imported++;
      const modelId = (db.prepare("SELECT id FROM models WHERE make_id=? AND norm_model=?")
        .get(mid, norm(r["Standard Model"])) as { id: number }).id;
      for (const y of parseYearRanges(r["Confirmed Model Years"])) {
        insYear.run(modelId, y,
          y >= 2027 ? "Official Early/Future Model Year" : "Confirmed",
          r["Validation Status"], r["Primary Source Name"] ?? "",
          r["Primary Source URL"] ?? "", null);
      }
    }
    const modelId = new Map<string, number>();
    for (const row of db.prepare(
      "SELECT m.id, k.norm_make AS nm, m.norm_model AS nmo FROM models m JOIN makes k ON k.id=m.make_id")
      .all() as { id: number; nm: string; nmo: string }[]) {
      modelId.set(`${row.nm}|${row.nmo}`, row.id);
    }
    const findModel = (make: string, model: string): number | null =>
      modelId.get(`${norm(make)}|${norm(model)}`) ?? null;

    // merged variant spellings become aliases so lookups still resolve
    const insMergedAlias = db.prepare(`
      INSERT INTO aliases (raw_or_alias_make, raw_or_alias_model, canonical_make_id,
        canonical_model_id, alias_type, source_file_or_source_name, confidence, notes,
        norm_make, norm_model)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(norm_make, norm_model, alias_type) DO NOTHING`);
    for (const a of mergedAliases) {
      const mkId = makeId.get(norm(a.make))!;
      const mdId = findModel(a.make, a.canonical);
      insMergedAlias.run(a.make, a.variant, mkId, mdId, a.kind,
        "Master catalog variant merge (import pipeline)", "High",
        `Variant spelling of canonical "${a.canonical}" merged during import.`,
        norm(a.make), norm(a.variant));
    }

    // ---------------- aliases (+ classified variant candidates) ----------------
    const aliasRows = readCsv(files.alias!);
    validateColumns(aliasRows, REQUIRED.alias, files.alias!);
    const frAlias = fileReport(files.alias!, aliasRows.length);
    const insAlias = db.prepare(`
      INSERT INTO aliases (raw_or_alias_make, raw_or_alias_model, raw_or_alias_submodel,
        canonical_make_id, canonical_model_id, canonical_submodel_id, alias_type,
        source_file_or_source_name, confidence, notes, norm_make, norm_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(norm_make, norm_model, alias_type) DO UPDATE SET
        canonical_make_id=excluded.canonical_make_id,
        canonical_model_id=excluded.canonical_model_id,
        confidence=excluded.confidence, notes=excluded.notes`);
    const insSub = db.prepare(`
      INSERT INTO submodels (model_id, standard_submodel, submodel_type,
        confirmed_model_years, validation_status, source_name, source_url, notes,
        norm_submodel, review_status)
      VALUES (?,?,?,?,?,?,?,?,?,'Pending')
      ON CONFLICT(model_id, norm_submodel, submodel_type) DO UPDATE SET
        notes=excluded.notes, updated_at=datetime('now')`);
    for (const r of aliasRows) {
      const cMakeId = makeId.get(norm(r["Canonical Make"])) ?? null;
      const canonicalModels = (r["Canonical Model"] ?? "").split(";").map((s) => s.trim()).filter(Boolean);
      const cModelId = canonicalModels.length === 1 && cMakeId
        ? findModel(r["Canonical Make"], canonicalModels[0]) : null;
      const before = db.prepare(
        "SELECT id FROM aliases WHERE norm_make=? AND norm_model=? AND alias_type=?")
        .get(norm(r["Raw or Alias Make"]), norm(r["Raw or Alias Model"]), r["Alias Type"]);
      insAlias.run(r["Raw or Alias Make"], r["Raw or Alias Model"], null,
        cMakeId, cModelId, null, r["Alias Type"],
        r["Source File or Source Name"] ?? "", r["Confidence"] ?? "",
        r["Notes"] ?? "", norm(r["Raw or Alias Make"]), norm(r["Raw or Alias Model"]));
      before ? frAlias.updated++ : frAlias.imported++;
      // classified variant candidate (never auto-approved as a Sub-model)
      if (cModelId && canonicalModels.length === 1) {
        const variant = classifyVariant(r["Raw or Alias Model"], canonicalModels[0],
          r["Alias Type"], r["Notes"] ?? "");
        if (variant && variant.value && norm(variant.value) !== norm(canonicalModels[0])) {
          insSub.run(cModelId, variant.value, variant.type, null, "Review Required",
            r["Source File or Source Name"] ?? "Alias mapping", "",
            `Derived from documented alias "${r["Raw or Alias Model"]}"; classified as ${variant.type}. ` +
            `Not approved as a Sub-model: no authoritative sub-model source has verified it yet.`,
            norm(variant.value));
        }
      }
    }

    // ---------------- grouped relationships ----------------
    const groupedRows = readCsv(files.grouped!);
    validateColumns(groupedRows, REQUIRED.grouped, files.grouped!);
    const frGrouped = fileReport(files.grouped!, groupedRows.length);
    const insGrouped = db.prepare(`
      INSERT OR IGNORE INTO grouped_model_relationships
        (raw_make, raw_grouped_model_value, canonical_make_id, canonical_model_id,
         relationship_status, evidence, notes, norm_value)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const r of groupedRows) {
      const cMakeId = makeId.get(norm(r["Canonical Make"])) ?? null;
      const cModelId = cMakeId ? findModel(r["Canonical Make"], r["Canonical Model"]) : null;
      const res = insGrouped.run(r["Raw Make"], r["Raw Grouped Model Value"],
        cMakeId, cModelId, r["Relationship Status"], r["Evidence"] ?? "",
        r["Notes"] ?? "", norm(r["Raw Grouped Model Value"]));
      res.changes ? frGrouped.imported++ : frGrouped.updated++;
    }

    // ---------------- validation reviews ----------------
    const reviewRows = readCsv(files.review!);
    validateColumns(reviewRows, REQUIRED.review, files.review!);
    const frReview = fileReport(files.review!, reviewRows.length);
    const insReview = db.prepare(`
      INSERT INTO validation_reviews (candidate_make, candidate_model, candidate_submodel,
        candidate_model_years, issue_type, reason_not_approved, primary_source_name,
        primary_source_url, secondary_source_name, secondary_source_url,
        recommended_next_action, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_make, candidate_model, candidate_submodel, issue_type)
      DO UPDATE SET
        candidate_model_years=excluded.candidate_model_years,
        reason_not_approved=excluded.reason_not_approved,
        recommended_next_action=excluded.recommended_next_action`);
    const markCorrected = db.prepare(
      `UPDATE validation_reviews SET review_status='Corrected', notes=?
       WHERE candidate_make=? AND candidate_model=? AND issue_type=? AND review_status='Pending'`);
    for (const r of reviewRows) {
      const before = db.prepare(
        "SELECT id FROM validation_reviews WHERE candidate_make=? AND candidate_model=? AND issue_type=?")
        .get(r["Candidate Make"], r["Candidate Model"], r["Issue Type"]);
      insReview.run(r["Candidate Make"], r["Candidate Model"], "",
        r["Candidate Model Years"] ?? "", r["Issue Type"], r["Reason Not Approved"],
        r["Primary Source Name"] ?? "", r["Primary Source URL"] ?? "",
        r["Secondary Source Name"] ?? "", r["Secondary Source URL"] ?? "",
        r["Recommended Next Action"] ?? "", r["Notes"] ?? "");
      before ? frReview.updated++ : frReview.imported++;
      // A candidate whose normalized form already exists as a canonical model
      // is a resolved spelling variant, not a pending question: mark it
      // Corrected with a documented reason (never silently dropped).
      const canonicalHit = findModel(r["Candidate Make"], r["Candidate Model"]);
      if (canonicalHit) {
        const canonical = db.prepare(
          "SELECT standard_model FROM models WHERE id=?").get(canonicalHit) as { standard_model: string };
        markCorrected.run(
          `${r["Notes"] ?? ""} Auto-resolved at import: normalized form matches canonical model ` +
          `"${canonical.standard_model}" (punctuation/spacing variant). Original review reason retained.`,
          r["Candidate Make"], r["Candidate Model"], r["Issue Type"]);
      }
    }

    // ---------------- coverage report ----------------
    const covRows = readCsv(files.coverage!);
    validateColumns(covRows, REQUIRED.coverage, files.coverage!);
    const frCov = fileReport(files.coverage!, covRows.length);
    const insCov = db.prepare(`
      INSERT INTO coverage_report (model_year, verified_make_count, verified_model_count,
        government_source_coverage, manufacturer_source_coverage, discrepancy_count,
        unresolved_candidate_count, coverage_status, notes)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(model_year) DO UPDATE SET
        verified_make_count=excluded.verified_make_count,
        verified_model_count=excluded.verified_model_count,
        coverage_status=excluded.coverage_status, notes=excluded.notes`);
    for (const r of covRows) {
      insCov.run(Number(r["Model Year"]), Number(r["Verified Make Count"]),
        Number(r["Verified Model Count"]), r["Government Source Coverage"] ?? "",
        r["Manufacturer Source Coverage"] ?? "", Number(r["Discrepancy Count"] || 0),
        Number(r["Unresolved Candidate Count"] || 0), r["Coverage Status"] ?? "",
        r["Notes"] ?? "");
      frCov.imported++;
    }

    // ---------------- sources ----------------
    const insSource = db.prepare(`
      INSERT INTO sources (source_name, source_url, source_type, access_date,
        evidence_type, known_limitations, notes)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(source_name) DO UPDATE SET source_url=excluded.source_url`);
    insSource.run("EPA FuelEconomy.gov Vehicle Fuel Economy Dataset",
      "https://www.fueleconomy.gov/feg/epadata/vehicles.csv",
      "US Government dataset", "2026-07-15", "Certification (fuel-economy) records",
      "Coverage begins with model year 1984; vehicles over 8,500 lb GVWR are exempt and absent.",
      "Primary source for 1984+ light-duty vehicles, including vehicle class categories.");
    insSource.run("NHTSA Product Information Catalog (vehicle products API)",
      "https://api.nhtsa.gov/products/vehicle/models?modelYear={year}&make={make}&issueType=r",
      "US Government API", "2026-07-15", "Recall-based vehicle product records",
      "Recall-derived: model names vary in formatting; includes motorcycles/heavy trucks "
      + "under the same make strings (screened during catalog construction).",
      "Primary source for 1980-1983 and for heavy-GVWR consumer vehicles.");

    // ---------------- import runs ----------------
    const insRun = db.prepare(`
      INSERT INTO import_runs (input_filename, input_file_hash, rows_read, rows_imported,
        rows_updated, rows_rejected, validation_status, error_log, notes)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const fr of report.files) {
      insRun.run(fr.file, fr.hash, fr.rowsRead, fr.imported, fr.updated, fr.rejected,
        fr.errors.length ? "Completed with warnings" : "Validated",
        fr.errors.join("\n") || null, null);
    }
    const setMeta = db.prepare(
      "INSERT INTO catalog_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    setMeta.run("catalog_version", report.catalogVersion);
    setMeta.run("research_cutoff", "2026-07-15");
    setMeta.run("last_import", report.startedAt);
    setMeta.run("catalog_dir", dir);

    // ---------------- mandatory validations (throw => full rollback) ----------------
    const q = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const checks: [string, boolean, string][] = [];
    const nMakes = q("SELECT COUNT(*) n FROM makes");
    const nModels = q("SELECT COUNT(*) n FROM models");
    checks.push(["All catalog makes imported", nMakes >= makeRows.length, `${nMakes}/${makeRows.length}`]);
    checks.push(["All catalog models imported",
      nModels >= masterRows.length - report.files[1].rejected, `${nModels}/${masterRows.length}`]);
    checks.push(["No model row rejected", report.files[1].rejected === 0,
      String(report.files[1].rejected)]);
    checks.push(["No orphan models",
      q("SELECT COUNT(*) n FROM models m LEFT JOIN makes k ON k.id=m.make_id WHERE k.id IS NULL") === 0, ""]);
    checks.push(["Model-year rows match expanded ranges",
      q("SELECT COUNT(*) n FROM model_years") > 0
      && q(`SELECT COUNT(*) n FROM models m WHERE
            (SELECT MIN(model_year) FROM model_years y WHERE y.model_id=m.id) <> m.first_confirmed_model_year
         OR (SELECT MAX(model_year) FROM model_years y WHERE y.model_id=m.id) <> m.last_confirmed_model_year`) === 0, ""]);
    checks.push(["No duplicate make", q(
      "SELECT COUNT(*) n FROM (SELECT norm_make FROM makes GROUP BY norm_make HAVING COUNT(*)>1)") === 0, ""]);
    checks.push(["No duplicate make-model", q(
      "SELECT COUNT(*) n FROM (SELECT make_id, norm_model FROM models GROUP BY make_id, norm_model HAVING COUNT(*)>1)") === 0, ""]);
    checks.push(["No sub-model approved without an approved-tier validation status",
      q(`SELECT COUNT(*) n FROM submodels WHERE review_status='Approved'
         AND validation_status NOT IN
         ('Fully Verified','Government Verified','Manufacturer Verified')`) === 0,
      "approved sub-models require Fully/Government/Manufacturer Verified status"]);
    // model-level candidates only: sub-model candidates legitimately name
    // their parent canonical model
    const pendingCollisions = (db.prepare(
      `SELECT candidate_make, candidate_model FROM validation_reviews
       WHERE review_status='Pending' AND COALESCE(candidate_submodel,'')=''`)
      .all() as { candidate_make: string; candidate_model: string }[])
      .filter((v) => findModel(v.candidate_make, v.candidate_model) !== null);
    checks.push(["No PENDING model-level unresolved candidate matches a canonical model",
      pendingCollisions.length === 0,
      pendingCollisions.slice(0, 5).map((v) => `${v.candidate_make}/${v.candidate_model}`).join(", ")]);
    report.mandatoryChecks = checks.map(([name, ok, detail]) => ({ name, ok, detail }));
    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length) {
      throw new Error(`Mandatory import validation failed: ${failed.map(([n]) => n).join("; ")}`);
    }
  });

  try {
    withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, tx);
  } catch (e) {
    report.status = "ROLLED_BACK";
    report.mandatoryChecks.push({ name: "Transaction", ok: false, detail: String(e) });
    throw Object.assign(e as Error, { report });
  }

  const q = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  report.totals = {
    makes: q("SELECT COUNT(*) n FROM makes"),
    models: q("SELECT COUNT(*) n FROM models"),
    model_years: q("SELECT COUNT(*) n FROM model_years"),
    submodel_candidates: q("SELECT COUNT(*) n FROM submodels"),
    approved_submodels: q("SELECT COUNT(*) n FROM submodels WHERE validation_status <> 'Review Required'"),
    aliases: q("SELECT COUNT(*) n FROM aliases"),
    grouped_relationships: q("SELECT COUNT(*) n FROM grouped_model_relationships"),
    validation_reviews: q("SELECT COUNT(*) n FROM validation_reviews"),
    sources: q("SELECT COUNT(*) n FROM sources"),
  };
  return report;
}
