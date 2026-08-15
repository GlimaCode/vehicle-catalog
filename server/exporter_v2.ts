/**
 * Version 2 Excel workbook: 21 worksheets with the year-level vehicle
 * hierarchy as the principal user-facing sheet, one classification sheet per
 * variant type, and the V1-to-V2 change log.
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { EXPORT_DIR, CATALOG_DIR } from "./db.js";

export const WORKBOOK_V2 =
  "Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15_v2.xlsx";
const APPROVED = `s.review_status='Approved' AND s.validation_status IN
  ('Fully Verified','Government Verified','Manufacturer Verified')`;

type Row = Record<string, unknown>;
type ColSpec = { header: string; key: string; width?: number; wrap?: boolean; url?: boolean };

function sheet(wb: ExcelJS.Workbook, name: string, columns: ColSpec[], rows: Row[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const r of rows) {
    const row = ws.addRow(columns.map((c) => r[c.key] ?? ""));
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.wrap) cell.alignment = { wrapText: true, vertical: "top" };
      const v = r[c.key];
      if (c.url && typeof v === "string" && v.startsWith("http")) {
        cell.value = { text: v, hyperlink: v };
        cell.font = { color: { argb: "FF1155CC" }, underline: true };
      }
    });
  }
  return ws;
}

const SUB_COLS: ColSpec[] = [
  { header: "Standard Make", key: "standard_make", width: 15 },
  { header: "Standard Model", key: "standard_model", width: 22 },
  { header: "Standard Sub-model or Variant", key: "standard_submodel", width: 22 },
  { header: "Classification Type", key: "submodel_type", width: 18 },
  { header: "Confirmed Model Years", key: "confirmed_model_years", width: 24 },
  { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 11 },
  { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 11 },
  { header: "Lifecycle Status", key: "lifecycle_status", width: 13 },
  { header: "Validation Status", key: "validation_status", width: 17 },
  { header: "Primary Source", key: "source_url", width: 42, url: true },
  { header: "Secondary Source", key: "secondary_source_url", width: 34, url: true },
  { header: "Raw Source Value", key: "raw_source_value", width: 30, wrap: true },
  { header: "Notes", key: "notes", width: 60, wrap: true },
];

export function buildWorkbookV2(db: Database.Database): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Make/Model Catalog Application (V2)";
  const all = <T = Row>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...p) as T[];
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  // ---- 1. Vehicle Hierarchy (principal sheet) ----
  const hierRows: Row[] = [];
  const subYearRows = all(`
    SELECT sy.model_year, k.standard_make, m.standard_model,
      s.standard_submodel, s.submodel_type, m.vehicle_category,
      m.lifecycle_status, sy.validation_status, s.source_url primary_source,
      s.secondary_source_url secondary_source, m.present_in_original_source,
      s.catalog_origin, s.notes
    FROM submodel_years sy
    JOIN submodels s ON s.id=sy.submodel_id
    JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
    WHERE ${APPROVED}`);
  const covered = new Set(subYearRows.map((r) =>
    `${(r as Row).model_year}|${(r as Row).standard_make}|${(r as Row).standard_model}`));
  hierRows.push(...subYearRows);
  for (const r of all(`
    SELECT y.model_year, k.standard_make, m.standard_model,
      '' standard_submodel, '' submodel_type, m.vehicle_category,
      m.lifecycle_status, y.validation_status, y.source_url primary_source,
      m.secondary_source_url secondary_source, m.present_in_original_source,
      m.catalog_origin, 'No approved Sub-model data available' notes
    FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id`)) {
    const key = `${(r as Row).model_year}|${(r as Row).standard_make}|${(r as Row).standard_model}`;
    if (!covered.has(key)) hierRows.push(r);
  }
  hierRows.sort((a, b) =>
    Number(a.model_year) - Number(b.model_year)
    || String(a.standard_make).localeCompare(String(b.standard_make))
    || String(a.standard_model).localeCompare(String(b.standard_model))
    || String(a.submodel_type).localeCompare(String(b.submodel_type))
    || String(a.standard_submodel).localeCompare(String(b.standard_submodel)));
  sheet(wb, "Vehicle Hierarchy", [
    { header: "Model Year", key: "model_year", width: 10 },
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 22 },
    { header: "Standard Sub-model or Variant", key: "standard_submodel", width: 22 },
    { header: "Classification Type", key: "submodel_type", width: 18 },
    { header: "Vehicle Category", key: "vehicle_category", width: 17 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 13 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Primary Source", key: "primary_source", width: 42, url: true },
    { header: "Secondary Source", key: "secondary_source", width: 34, url: true },
    { header: "Present in Original Source", key: "present_in_original_source", width: 11 },
    { header: "Catalog Origin", key: "catalog_origin", width: 26 },
    { header: "Notes", key: "notes", width: 44, wrap: true },
  ], hierRows);

  // ---- 2-3. Makes / Models ----
  sheet(wb, "Makes", [
    { header: "Make ID", key: "id", width: 8 },
    { header: "Standard Make", key: "standard_make", width: 17 },
    { header: "Official Display Name", key: "official_display_name", width: 19 },
    { header: "US Market Start Year", key: "us_market_start_year", width: 11 },
    { header: "US Market End Year", key: "us_market_end_year", width: 11 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 13 },
    { header: "Model Count", key: "model_count", width: 10 },
    { header: "Approved Variant Count", key: "variant_count", width: 12 },
    { header: "Present in Original Source", key: "present_in_original_source", width: 11 },
    { header: "Catalog Origin", key: "catalog_origin", width: 26 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Primary Source", key: "primary_source_url", width: 42, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 34, url: true },
    { header: "Notes", key: "notes", width: 55, wrap: true },
  ], all(`SELECT k.*,
      (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id) model_count,
      (SELECT COUNT(*) FROM submodels s JOIN models m2 ON m2.id=s.model_id
        WHERE m2.make_id=k.id AND ${APPROVED}) variant_count
      FROM makes k ORDER BY k.standard_make`));
  sheet(wb, "Models", [
    { header: "Model ID", key: "id", width: 8 },
    { header: "Make ID", key: "make_id", width: 8 },
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 24 },
    { header: "Confirmed Model Years", key: "confirmed_model_years", width: 24 },
    { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 11 },
    { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 11 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 14 },
    { header: "Vehicle Category", key: "vehicle_category", width: 17 },
    { header: "Market", key: "market", width: 12 },
    { header: "Approved Variant Count", key: "variant_count", width: 12 },
    { header: "Present in Original Source", key: "present_in_original_source", width: 11 },
    { header: "Catalog Origin", key: "catalog_origin", width: 26 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Primary Source", key: "primary_source_url", width: 42, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 34, url: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all(`SELECT m.*, k.standard_make,
      (SELECT COUNT(*) FROM submodels s WHERE s.model_id=m.id AND ${APPROVED}) variant_count
      FROM models m JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model, m.first_confirmed_model_year`));

  // ---- 4-13. classification sheets ----
  const classSheets: [string, string][] = [
    ["Submodels", "Sub-model"], ["Trims", "Trim"], ["Series", "Series"],
    ["Generations", "Generation"], ["Chassis", "Chassis"],
    ["Editions", "Edition"], ["Body Styles", "Body Style"],
    ["Engine Variants", "Engine Variant"],
    ["Drivetrain Variants", "Drivetrain Variant"], ["Packages", "Package"],
  ];
  for (const [name, type] of classSheets) {
    sheet(wb, name, SUB_COLS, all(`
      SELECT s.*, k.standard_make, m.standard_model
      FROM submodels s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
      WHERE ${APPROVED} AND s.submodel_type=?
      ORDER BY k.standard_make, m.standard_model, s.standard_submodel`, type));
  }

  // ---- 14-15. year matrices ----
  sheet(wb, "Model Years", [
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 24 },
    { header: "Model Year", key: "model_year", width: 10 },
    { header: "Vehicle Category", key: "vehicle_category", width: 17 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 14 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ], all(`SELECT k.standard_make, m.standard_model, y.model_year,
      m.vehicle_category, m.lifecycle_status, y.validation_status, y.source_url
      FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      ORDER BY y.model_year, k.standard_make, m.standard_model`));
  sheet(wb, "Submodel Years", [
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 22 },
    { header: "Standard Sub-model or Variant", key: "standard_submodel", width: 22 },
    { header: "Classification Type", key: "submodel_type", width: 18 },
    { header: "Model Year", key: "model_year", width: 10 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ], all(`SELECT k.standard_make, m.standard_model, s.standard_submodel,
      s.submodel_type, sy.model_year, sy.validation_status, sy.source_url
      FROM submodel_years sy JOIN submodels s ON s.id=sy.submodel_id
      JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
      WHERE ${APPROVED}
      ORDER BY k.standard_make, m.standard_model, s.standard_submodel, sy.model_year`));

  // ---- 16-19. aliases / grouped / review / sources ----
  sheet(wb, "Aliases", [
    { header: "Raw or Alias Make", key: "raw_or_alias_make", width: 15 },
    { header: "Raw or Alias Model", key: "raw_or_alias_model", width: 28 },
    { header: "Raw or Alias Sub-model", key: "raw_or_alias_submodel", width: 18 },
    { header: "Canonical Make", key: "canonical_make", width: 15 },
    { header: "Canonical Model", key: "canonical_model", width: 24 },
    { header: "Canonical Sub-model", key: "canonical_submodel", width: 18 },
    { header: "Alias Type", key: "alias_type", width: 26 },
    { header: "Confidence", key: "confidence", width: 10 },
    { header: "Source", key: "source_file_or_source_name", width: 30 },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all(`SELECT a.*, COALESCE(k.standard_make,'') canonical_make,
      COALESCE(m.standard_model,'') canonical_model,
      COALESCE(s.standard_submodel,'') canonical_submodel
      FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
      LEFT JOIN models m ON m.id=a.canonical_model_id
      LEFT JOIN submodels s ON s.id=a.canonical_submodel_id
      ORDER BY a.raw_or_alias_make, a.raw_or_alias_model`));
  sheet(wb, "Grouped Models", [
    { header: "Raw Make", key: "raw_make", width: 15 },
    { header: "Raw Grouped Model Value", key: "raw_grouped_model_value", width: 38 },
    { header: "Canonical Make", key: "canonical_make", width: 15 },
    { header: "Canonical Model", key: "canonical_model", width: 22 },
    { header: "Relationship Status", key: "relationship_status", width: 22 },
    { header: "Evidence", key: "evidence", width: 42, wrap: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all(`SELECT g.*, COALESCE(k.standard_make,'') canonical_make,
      COALESCE(m.standard_model,'') canonical_model
      FROM grouped_model_relationships g
      LEFT JOIN makes k ON k.id=g.canonical_make_id
      LEFT JOIN models m ON m.id=g.canonical_model_id
      ORDER BY g.raw_make, g.raw_grouped_model_value`));
  sheet(wb, "Review Required", [
    { header: "Candidate Make", key: "candidate_make", width: 15 },
    { header: "Candidate Model", key: "candidate_model", width: 24 },
    { header: "Candidate Sub-model", key: "candidate_submodel", width: 18 },
    { header: "Possible Classification", key: "possible_classification", width: 18 },
    { header: "Candidate Years", key: "candidate_model_years", width: 16 },
    { header: "Issue Type", key: "issue_type", width: 28 },
    { header: "Reason Not Approved", key: "reason_not_approved", width: 55, wrap: true },
    { header: "Review Status", key: "review_status", width: 13 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Recommended Next Action", key: "recommended_next_action", width: 42, wrap: true },
    { header: "Notes", key: "notes", width: 50, wrap: true },
  ], all("SELECT * FROM validation_reviews ORDER BY candidate_make, candidate_model, candidate_submodel"));
  sheet(wb, "Sources", [
    { header: "Source Name", key: "source_name", width: 44 },
    { header: "Source URL", key: "source_url", width: 58, url: true },
    { header: "Source Type", key: "source_type", width: 22 },
    { header: "Evidence Type", key: "evidence_type", width: 32 },
    { header: "Access Date", key: "access_date", width: 12 },
    { header: "Known Limitations", key: "known_limitations", width: 58, wrap: true },
    { header: "Notes", key: "notes", width: 55, wrap: true },
  ], all("SELECT * FROM sources ORDER BY source_name"));

  // ---- 20. Catalog Summary ----
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM catalog_meta").all() as
    { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const summary: [string, string | number][] = [
    ["Catalog version", meta.catalog_version ?? "V2"],
    ["Research cutoff", meta.research_cutoff ?? "2026-07-15"],
    ["Export timestamp", new Date().toISOString()],
    ["Total Makes", n("SELECT COUNT(*) n FROM makes")],
    ["Total Models", n("SELECT COUNT(*) n FROM models")],
    ["Total approved Sub-models & variants",
      n(`SELECT COUNT(*) n FROM submodels s WHERE ${APPROVED}`)],
    ["Total model-year records", n("SELECT COUNT(*) n FROM model_years")],
    ["Total sub-model-year records", n(`SELECT COUNT(*) n FROM submodel_years sy
      JOIN submodels s ON s.id=sy.submodel_id WHERE ${APPROVED}`)],
    ["Total aliases", n("SELECT COUNT(*) n FROM aliases")],
    ["Total unresolved candidates", n("SELECT COUNT(*) n FROM validation_reviews")],
  ];
  for (const [label, sql] of [
    ["Approved variants by classification",
      `SELECT submodel_type k, COUNT(*) n FROM submodels s WHERE ${APPROVED} GROUP BY 1 ORDER BY 2 DESC`],
    ["Approved variants by validation status",
      `SELECT s.validation_status k, COUNT(*) n FROM submodels s WHERE ${APPROVED} GROUP BY 1`],
    ["Models by lifecycle", "SELECT lifecycle_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by validation", "SELECT validation_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by category", "SELECT vehicle_category k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by decade", `SELECT (first_confirmed_model_year/10*10) || 's' k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 1`],
  ] as const) {
    for (const r of all<{ k: string; n: number }>(sql)) summary.push([`${label}: ${r.k}`, r.n]);
  }
  const ws = wb.addWorksheet("Catalog Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ header: "Metric", key: "m", width: 56 }, { header: "Value", key: "v", width: 32 }];
  ws.getRow(1).font = { bold: true };
  for (const [m, v] of summary) ws.addRow([m, v]);

  // ---- 21. V1 to V2 Changes ----
  const deltaPath = path.join(CATALOG_DIR, "Catalog_V1_to_V2_Delta.csv");
  const deltaRows: Row[] = [];
  if (fs.existsSync(deltaPath)) {
    const text = fs.readFileSync(deltaPath, "utf-8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    const heads = lines[0].split(",");
    for (const line of lines.slice(1)) {
      // simple parse acceptable: delta file has quoted fields
      const cells: string[] = [];
      let cur = "", inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
        else cur += ch;
      }
      cells.push(cur);
      deltaRows.push(Object.fromEntries(heads.map((h, i) => [h, cells[i] ?? ""])));
    }
  }
  sheet(wb, "V1 to V2 Changes", [
    { header: "Change Type", key: "Change Type", width: 26 },
    { header: "Standard Make", key: "Standard Make", width: 16 },
    { header: "Item", key: "Item", width: 40 },
    { header: "Detail", key: "Detail", width: 90, wrap: true },
  ], deltaRows);

  return wb;
}

export async function writeWorkbookV2(db: Database.Database, outPath?: string): Promise<string> {
  const wb = buildWorkbookV2(db);
  const p = outPath ?? path.join(EXPORT_DIR, WORKBOOK_V2);
  await wb.xlsx.writeFile(p);
  return p;
}
