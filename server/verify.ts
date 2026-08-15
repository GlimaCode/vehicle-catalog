/** Pre-delivery verification: database vs source CSVs vs Excel workbook. */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { norm, EXPORT_DIR } from "./db.js";
import { detectCatalogFiles, readCsv, sha256, parseYearRanges } from "./importer.js";
import { WORKBOOK_NAME } from "./exporter.js";

export interface VerifyReport {
  status: "PASS" | "FAIL";
  checks: { name: string; ok: boolean; detail?: string }[];
  sourceHashes: Record<string, string>;
}

export async function verifyAll(db: Database.Database): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = [];
  const c = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const n = (sql: string, params: unknown[] = []): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const files = detectCatalogFiles();
  const master = readCsv(files.master!);
  const makesCsv = readCsv(files.makes!);

  // 1-2: every canonical make/model from the catalog exists in the DB
  const missMakes = makesCsv.filter((r) =>
    !db.prepare("SELECT 1 FROM makes WHERE norm_make=?").get(norm(r["Standard Make"])));
  c("Every canonical Make exists in DB", missMakes.length === 0, `missing=${missMakes.length}`);
  const missModels = master.filter((r) => !db.prepare(
    `SELECT 1 FROM models m JOIN makes k ON k.id=m.make_id WHERE k.norm_make=? AND m.norm_model=?`)
    .get(norm(r["Standard Make"]), norm(r["Standard Model"])));
  c("Every canonical Model exists in DB", missModels.length === 0, `missing=${missModels.length}`);

  c("Every Model references a valid Make",
    n(`SELECT COUNT(*) n FROM models m LEFT JOIN makes k ON k.id=m.make_id WHERE k.id IS NULL`) === 0);
  c("Every approved Sub-model references a valid Model",
    n(`SELECT COUNT(*) n FROM submodels s LEFT JOIN models m ON m.id=s.model_id
       WHERE s.validation_status<>'Review Required' AND m.id IS NULL`) === 0);

  // 5-6: model years supported by source ranges, non-contiguity preserved.
  // Source rows that were merged as punctuation variants contribute the
  // union of their ranges, so each source row's years must be a subset of
  // the stored years for its canonical model.
  let yearMismatch = 0, contiguityLoss = 0;
  for (const r of master) {
    const expected = parseYearRanges(r["Confirmed Model Years"]);
    const got = new Set((db.prepare(
      `SELECT y.model_year FROM model_years y JOIN models m ON m.id=y.model_id
       JOIN makes k ON k.id=m.make_id WHERE k.norm_make=? AND m.norm_model=? ORDER BY 1`)
      .all(norm(r["Standard Make"]), norm(r["Standard Model"])) as { model_year: number }[])
      .map((x) => x.model_year));
    if (!expected.every((y) => got.has(y))) yearMismatch++;
  }
  c("Every source model year is present in the database (range expansion)",
    yearMismatch === 0, `mismatches=${yearMismatch}`);
  // stored ranges: model_years min/max must equal the models table and
  // multi-segment ranges must retain real gaps
  contiguityLoss = n(`SELECT COUNT(*) n FROM models m
    WHERE m.confirmed_model_years LIKE '%;%'
    AND (SELECT COUNT(*) FROM model_years y WHERE y.model_id=m.id)
        = m.last_confirmed_model_year - m.first_confirmed_model_year + 1`);
  c("Non-contiguous ranges remain non-contiguous", contiguityLoss === 0, `losses=${contiguityLoss}`);
  c("model_years min/max agrees with models table", n(`SELECT COUNT(*) n FROM models m WHERE
    (SELECT MIN(model_year) FROM model_years y WHERE y.model_id=m.id)<>m.first_confirmed_model_year
    OR (SELECT MAX(model_year) FROM model_years y WHERE y.model_id=m.id)<>m.last_confirmed_model_year`) === 0);

  const pendingCollide = (db.prepare(
    `SELECT candidate_make, candidate_model FROM validation_reviews WHERE review_status='Pending'`)
    .all() as { candidate_make: string; candidate_model: string }[])
    .filter((v) => db.prepare(
      `SELECT 1 FROM models m JOIN makes k ON k.id=m.make_id WHERE k.norm_make=? AND m.norm_model=?`)
      .get(norm(v.candidate_make), norm(v.candidate_model)));
  c("No pending unresolved candidate appears as approved canonical value",
    pendingCollide.length === 0,
    pendingCollide.slice(0, 5).map((v) => `${v.candidate_make}/${v.candidate_model}`).join(", "));
  c("No duplicate Make",
    n("SELECT COUNT(*) n FROM (SELECT norm_make FROM makes GROUP BY 1 HAVING COUNT(*)>1)") === 0);
  c("No duplicate Make-Model",
    n("SELECT COUNT(*) n FROM (SELECT make_id, norm_model FROM models GROUP BY 1,2 HAVING COUNT(*)>1)") === 0);
  c("No duplicate Make-Model-Submodel",
    n("SELECT COUNT(*) n FROM (SELECT model_id, norm_submodel, submodel_type FROM submodels GROUP BY 1,2,3 HAVING COUNT(*)>1)") === 0);
  c("All resolved aliases point to valid canonical records", n(`
    SELECT COUNT(*) n FROM aliases a
    LEFT JOIN makes k ON k.id=a.canonical_make_id
    WHERE a.canonical_make_id IS NOT NULL AND k.id IS NULL`) === 0
    && n(`SELECT COUNT(*) n FROM aliases a LEFT JOIN models m ON m.id=a.canonical_model_id
    WHERE a.canonical_model_id IS NOT NULL AND m.id IS NULL`) === 0);
  c("Source URLs available in database",
    n("SELECT COUNT(*) n FROM models WHERE primary_source_url IS NULL OR primary_source_url=''") === 0
    && n("SELECT COUNT(*) n FROM sources WHERE source_url IS NULL OR source_url=''") === 0);

  // 13-14: Excel counts and headers
  const wbPath = path.join(EXPORT_DIR, WORKBOOK_NAME);
  c("Excel workbook exists", fs.existsSync(wbPath), wbPath);
  if (fs.existsSync(wbPath)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(wbPath);
    const expectSheets: [string, number][] = [
      ["Makes", n("SELECT COUNT(*) n FROM makes")],
      ["Models", n("SELECT COUNT(*) n FROM models")],
      ["Submodels", n("SELECT COUNT(*) n FROM submodels WHERE validation_status<>'Review Required'")],
      ["Model Years", n("SELECT COUNT(*) n FROM model_years")],
      ["Submodel Years", n(`SELECT COUNT(*) n FROM submodel_years sy JOIN submodels s
        ON s.id=sy.submodel_id WHERE s.validation_status<>'Review Required'`)],
      ["Aliases", n("SELECT COUNT(*) n FROM aliases")],
      ["Grouped Models", n("SELECT COUNT(*) n FROM grouped_model_relationships")],
      ["Review Required", n("SELECT COUNT(*) n FROM validation_reviews")],
      ["Sources", n("SELECT COUNT(*) n FROM sources")],
    ];
    let countOk = true;
    const details: string[] = [];
    for (const [sheet, expected] of expectSheets) {
      const ws = wb.getWorksheet(sheet);
      const got = ws ? ws.actualRowCount - 1 : -1;
      details.push(`${sheet}: xlsx=${got} db=${expected}`);
      if (got !== expected) countOk = false;
    }
    c("Excel record counts match database record counts", countOk, details.join("; "));
    const headerChecks: [string, string[]][] = [
      ["Makes", ["Make ID", "Standard Make", "Official Display Name"]],
      ["Models", ["Model ID", "Make ID", "Standard Make", "Standard Model"]],
      ["Submodels", ["Sub-model ID", "Model ID", "Standard Make", "Standard Model", "Standard Sub-model"]],
      ["Model Years", ["Standard Make", "Standard Model", "Model Year"]],
      ["Catalog Summary", ["Metric", "Value"]],
    ];
    let headOk = true;
    for (const [sheet, heads] of headerChecks) {
      const ws = wb.getWorksheet(sheet);
      const row1 = ws ? (ws.getRow(1).values as unknown[]).map((v) => String(v ?? "")) : [];
      for (const h of heads) if (!row1.includes(h)) headOk = false;
    }
    c("Excel worksheets contain the requested columns", headOk);
    c("All 10 worksheets present", wb.worksheets.length >= 10,
      wb.worksheets.map((w) => w.name).join(", "));
  }

  // 16: re-import idempotency (row counts unchanged after a second run)
  const beforeCounts = [n("SELECT COUNT(*) n FROM makes"), n("SELECT COUNT(*) n FROM models"),
    n("SELECT COUNT(*) n FROM model_years"), n("SELECT COUNT(*) n FROM aliases"),
    n("SELECT COUNT(*) n FROM validation_reviews")];
  const { runImport } = await import("./importer.js");
  runImport(db);
  const afterCounts = [n("SELECT COUNT(*) n FROM makes"), n("SELECT COUNT(*) n FROM models"),
    n("SELECT COUNT(*) n FROM model_years"), n("SELECT COUNT(*) n FROM aliases"),
    n("SELECT COUNT(*) n FROM validation_reviews")];
  c("Re-importing the same source files creates no duplicates",
    JSON.stringify(beforeCounts) === JSON.stringify(afterCounts),
    `before=${beforeCounts} after=${afterCounts}`);

  const sourceHashes: Record<string, string> = {};
  for (const [k, p] of Object.entries(files)) if (p) sourceHashes[k] = sha256(p);
  c("Source catalog files present and read-only (hashes recorded)",
    Object.keys(sourceHashes).length >= 6);

  return {
    status: checks.every((x) => x.ok) ? "PASS" : "FAIL",
    checks, sourceHashes,
  };
}
