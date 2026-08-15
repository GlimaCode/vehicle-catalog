/**
 * Excel workbook and CSV export, generated programmatically from the
 * SQLite database. Formatting: frozen header rows, auto filters, bold
 * headers, sized columns, wrapped notes, hyperlinked source URLs, no
 * merged cells in data sheets, one normalized row per record.
 */
import ExcelJS from "exceljs";
import path from "node:path";
import type Database from "better-sqlite3";
import { EXPORT_DIR } from "./db.js";

export const WORKBOOK_NAME = "Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx";

type Row = Record<string, unknown>;

function addSheet(wb: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width?: number; wrap?: boolean; url?: boolean }[], rows: Row[]): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const r of rows) {
    const excelRow = ws.addRow(columns.map((c) => r[c.key] ?? ""));
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
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

export function buildWorkbook(db: Database.Database): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Make/Model Catalog Application";
  wb.created = new Date();
  const all = <T = Row>(sql: string, ...params: unknown[]): T[] =>
    db.prepare(sql).all(...params) as T[];

  addSheet(wb, "Makes", [
    { header: "Make ID", key: "id", width: 9 },
    { header: "Standard Make", key: "standard_make", width: 18 },
    { header: "Official Display Name", key: "official_display_name", width: 20 },
    { header: "US Market Start Year", key: "us_market_start_year", width: 12 },
    { header: "US Market End Year", key: "us_market_end_year", width: 12 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 14 },
    { header: "Model Count", key: "model_count", width: 11 },
    { header: "Sub-model Count", key: "submodel_count", width: 12 },
    { header: "Present in Original Source", key: "present_in_original_source", width: 12 },
    { header: "Catalog Origin", key: "catalog_origin", width: 26 },
    { header: "Validation Status", key: "validation_status", width: 18 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 40, url: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all(`SELECT k.*,
      (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id) model_count,
      (SELECT COUNT(*) FROM submodels s JOIN models m2 ON m2.id=s.model_id
        WHERE m2.make_id=k.id AND s.validation_status<>'Review Required') submodel_count
      FROM makes k ORDER BY k.standard_make`));

  addSheet(wb, "Models", [
    { header: "Model ID", key: "id", width: 9 },
    { header: "Make ID", key: "make_id", width: 9 },
    { header: "Standard Make", key: "standard_make", width: 16 },
    { header: "Standard Model", key: "standard_model", width: 26 },
    { header: "Confirmed Model Years", key: "confirmed_model_years", width: 26 },
    { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 12 },
    { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 12 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 16 },
    { header: "Vehicle Category", key: "vehicle_category", width: 18 },
    { header: "Market", key: "market", width: 13 },
    { header: "Sub-model Count", key: "submodel_count", width: 12 },
    { header: "Present in Original Source", key: "present_in_original_source", width: 12 },
    { header: "Catalog Origin", key: "catalog_origin", width: 26 },
    { header: "Validation Status", key: "validation_status", width: 18 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 40, url: true },
    { header: "Notes", key: "notes", width: 70, wrap: true },
  ], all(`SELECT m.*, k.standard_make,
      (SELECT COUNT(*) FROM submodels s WHERE s.model_id=m.id
        AND s.validation_status<>'Review Required') submodel_count
      FROM models m JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model, m.first_confirmed_model_year`));

  addSheet(wb, "Submodels", [
    { header: "Sub-model ID", key: "id", width: 10 },
    { header: "Model ID", key: "model_id", width: 9 },
    { header: "Standard Make", key: "standard_make", width: 16 },
    { header: "Standard Model", key: "standard_model", width: 22 },
    { header: "Standard Sub-model", key: "standard_submodel", width: 22 },
    { header: "Sub-model Type", key: "submodel_type", width: 14 },
    { header: "Confirmed Model Years", key: "confirmed_model_years", width: 22 },
    { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 12 },
    { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 12 },
    { header: "Validation Status", key: "validation_status", width: 16 },
    { header: "Source", key: "source_name", width: 30 },
    { header: "Notes", key: "notes", width: 70, wrap: true },
  ], all(`SELECT s.*, k.standard_make, m.standard_model
      FROM submodels s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
      WHERE s.validation_status<>'Review Required'
      ORDER BY k.standard_make, m.standard_model, s.standard_submodel, s.first_confirmed_model_year`));

  addSheet(wb, "Model Years", [
    { header: "Standard Make", key: "standard_make", width: 16 },
    { header: "Standard Model", key: "standard_model", width: 26 },
    { header: "Model Year", key: "model_year", width: 11 },
    { header: "Vehicle Category", key: "vehicle_category", width: 18 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 16 },
    { header: "Validation Status", key: "validation_status", width: 18 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ], all(`SELECT k.standard_make, m.standard_model, y.model_year, m.vehicle_category,
      m.lifecycle_status, y.validation_status, y.source_url
      FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      ORDER BY y.model_year, k.standard_make, m.standard_model`));

  addSheet(wb, "Submodel Years", [
    { header: "Standard Make", key: "standard_make", width: 16 },
    { header: "Standard Model", key: "standard_model", width: 22 },
    { header: "Standard Sub-model", key: "standard_submodel", width: 22 },
    { header: "Sub-model Type", key: "submodel_type", width: 14 },
    { header: "Model Year", key: "model_year", width: 11 },
    { header: "Validation Status", key: "validation_status", width: 16 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ], all(`SELECT k.standard_make, m.standard_model, s.standard_submodel, s.submodel_type,
      sy.model_year, sy.validation_status, sy.source_url
      FROM submodel_years sy JOIN submodels s ON s.id=sy.submodel_id
      JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
      WHERE s.validation_status<>'Review Required'
      ORDER BY k.standard_make, m.standard_model, s.standard_submodel, sy.model_year`));

  addSheet(wb, "Aliases", [
    { header: "Raw or Alias Make", key: "raw_or_alias_make", width: 16 },
    { header: "Raw or Alias Model", key: "raw_or_alias_model", width: 30 },
    { header: "Raw or Alias Sub-model", key: "raw_or_alias_submodel", width: 16 },
    { header: "Canonical Make", key: "canonical_make", width: 16 },
    { header: "Canonical Model", key: "canonical_model", width: 26 },
    { header: "Canonical Sub-model", key: "canonical_submodel", width: 16 },
    { header: "Alias Type", key: "alias_type", width: 26 },
    { header: "Confidence", key: "confidence", width: 11 },
    { header: "Source", key: "source_file_or_source_name", width: 34 },
    { header: "Notes", key: "notes", width: 80, wrap: true },
  ], all(`SELECT a.*, k.standard_make canonical_make,
      COALESCE(m.standard_model,'') canonical_model, '' canonical_submodel
      FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
      LEFT JOIN models m ON m.id=a.canonical_model_id
      ORDER BY a.raw_or_alias_make, a.raw_or_alias_model`));

  addSheet(wb, "Grouped Models", [
    { header: "Raw Make", key: "raw_make", width: 16 },
    { header: "Raw Grouped Model Value", key: "raw_grouped_model_value", width: 40 },
    { header: "Canonical Make", key: "canonical_make", width: 16 },
    { header: "Canonical Model", key: "canonical_model", width: 24 },
    { header: "Relationship Status", key: "relationship_status", width: 24 },
    { header: "Evidence", key: "evidence", width: 44, wrap: true },
    { header: "Notes", key: "notes", width: 70, wrap: true },
  ], all(`SELECT g.*, COALESCE(k.standard_make,'') canonical_make,
      COALESCE(m.standard_model,'') canonical_model
      FROM grouped_model_relationships g
      LEFT JOIN makes k ON k.id=g.canonical_make_id
      LEFT JOIN models m ON m.id=g.canonical_model_id
      ORDER BY g.raw_make, g.raw_grouped_model_value`));

  addSheet(wb, "Review Required", [
    { header: "Candidate Make", key: "candidate_make", width: 16 },
    { header: "Candidate Model", key: "candidate_model", width: 26 },
    { header: "Candidate Sub-model", key: "candidate_submodel", width: 16 },
    { header: "Candidate Years", key: "candidate_model_years", width: 18 },
    { header: "Issue Type", key: "issue_type", width: 28 },
    { header: "Reason Not Approved", key: "reason_not_approved", width: 60, wrap: true },
    { header: "Review Status", key: "review_status", width: 14 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 30, url: true },
    { header: "Recommended Next Action", key: "recommended_next_action", width: 44, wrap: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all("SELECT * FROM validation_reviews ORDER BY candidate_make, candidate_model"));

  addSheet(wb, "Sources", [
    { header: "Source Name", key: "source_name", width: 44 },
    { header: "Source URL", key: "source_url", width: 60, url: true },
    { header: "Source Type", key: "source_type", width: 22 },
    { header: "Evidence Type", key: "evidence_type", width: 32 },
    { header: "Access Date", key: "access_date", width: 12 },
    { header: "Known Limitations", key: "known_limitations", width: 60, wrap: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all("SELECT * FROM sources ORDER BY source_name"));

  const g = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM catalog_meta").all() as
    { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const groupRows = (sql: string): [string, number][] =>
    (db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]);
  const summary: [string, string | number][] = [
    ["Catalog version", meta.catalog_version ?? ""],
    ["Research cutoff", meta.research_cutoff ?? ""],
    ["Export timestamp", new Date().toISOString()],
    ["Total Makes", g("SELECT COUNT(*) n FROM makes")],
    ["Total Models", g("SELECT COUNT(*) n FROM models")],
    ["Total approved Sub-models", g("SELECT COUNT(*) n FROM submodels WHERE validation_status<>'Review Required'")],
    ["Sub-model candidates awaiting review", g("SELECT COUNT(*) n FROM submodels WHERE validation_status='Review Required'")],
    ["Total model-year records", g("SELECT COUNT(*) n FROM model_years")],
    ["Total aliases", g("SELECT COUNT(*) n FROM aliases")],
    ["Total unresolved candidates", g("SELECT COUNT(*) n FROM validation_reviews")],
  ];
  for (const [label, sql] of [
    ["Models by lifecycle status", "SELECT lifecycle_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by validation status", "SELECT validation_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by vehicle category", "SELECT vehicle_category k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Models by decade of first year", `SELECT (first_confirmed_model_year/10*10) || 's' k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 1`],
  ] as const) {
    for (const [k, n] of groupRows(sql)) summary.push([`${label}: ${k}`, n]);
  }
  const ws = wb.addWorksheet("Catalog Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ header: "Metric", key: "m", width: 52 }, { header: "Value", key: "v", width: 34 }];
  ws.getRow(1).font = { bold: true };
  for (const [m, v] of summary) ws.addRow([m, v]);
  return wb;
}

export async function writeWorkbook(db: Database.Database, outPath?: string): Promise<string> {
  const wb = buildWorkbook(db);
  const p = outPath ?? path.join(EXPORT_DIR, WORKBOOK_NAME);
  await wb.xlsx.writeFile(p);
  return p;
}

/** Serialize rows to CSV (RFC 4180 quoting). */
export function toCsv(rows: Row[], columns: { header: string; key: string }[]): string {
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}
