/**
 * Project outputs: standardized CSV/XLSX (audit mode by default), change
 * report workbook, review-only workbook, value-mapping CSV and JSON report.
 * Source row order is preserved unless a sort order is explicitly requested.
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { PROJECT_EXPORT_DIR } from "../db.js";
import { toCsv } from "../exporter.js";
import { neutralizeRow, needsNeutralizing,
  isTrustedHyperlinkField } from "../security/formula.js";
import { writeFileAtomic, writeViaTemp } from "../security/atomic.js";
import { sanitizeDisplayName, resolveInside } from "../security/filenames.js";
import { HIERARCHY_FIELDS, projectStats, projectOutcome, type NormalizedRow,
  type ProjectMapping } from "./project.js";

export type ExportMode = "audit" | "replacement";

const AUDIT_COLUMNS = ["Original Make", "Standard Make", "Make Match Status",
  "Original Model", "Standard Model", "Model Match Status", "Original Trim",
  "Standard Trim", "Hierarchy Classification", "Hierarchy Match Status",
  "Original Year", "Normalized Year", "Year Validation Status",
  "Row Review Status", "Standardization Notes"];

interface LoadedRow {
  rowNumber: number;
  original: Record<string, string>;
  nr: NormalizedRow;
  excluded: boolean;
  review: boolean;
}

/**
 * Stream project rows one at a time (better-sqlite3 `.iterate()`), so exports
 * of 100k+ rows never materialize the whole project in memory.
 */
function* iterateRows(db: Database.Database, projectId: number,
  opts: { includeExcluded?: boolean } = {}): Generator<LoadedRow> {
  const stmt = db.prepare(`SELECT row_number, original_json, normalized_json, excluded,
    review_required FROM standardization_rows WHERE project_id=?
    ${opts.includeExcluded ? "" : "AND excluded=0"} ORDER BY row_number`);
  for (const r of stmt.iterate(projectId) as Iterable<{ row_number: number;
    original_json: string; normalized_json: string; excluded: number;
    review_required: number }>) {
    yield { rowNumber: r.row_number,
      original: JSON.parse(r.original_json) as Record<string, string>,
      nr: JSON.parse(r.normalized_json) as NormalizedRow,
      excluded: !!r.excluded, review: !!r.review_required };
  }
}

/** First row only, used to derive the source header order. */
function firstRow(db: Database.Database, projectId: number): LoadedRow | null {
  for (const r of iterateRows(db, projectId, { includeExcluded: true })) return r;
  return null;
}

function loadRows(db: Database.Database, projectId: number, opts: {
  includeExcluded?: boolean; sort?: "source" | "make-model";
} = {}): LoadedRow[] {
  const rows = db.prepare(`SELECT row_number, original_json, normalized_json, excluded,
    review_required FROM standardization_rows WHERE project_id=? ORDER BY row_number`)
    .all(projectId) as { row_number: number; original_json: string;
      normalized_json: string; excluded: number; review_required: number }[];
  const out = rows
    .filter((r) => opts.includeExcluded || !r.excluded)
    .map((r) => ({ rowNumber: r.row_number,
      original: JSON.parse(r.original_json) as Record<string, string>,
      nr: JSON.parse(r.normalized_json) as NormalizedRow,
      excluded: !!r.excluded, review: !!r.review_required }));
  if (opts.sort === "make-model") {
    out.sort((a, b) =>
      String(a.nr.fields.Make?.value ?? a.nr.fields.Make?.raw ?? "")
        .localeCompare(String(b.nr.fields.Make?.value ?? b.nr.fields.Make?.raw ?? ""))
      || String(a.nr.fields.Model?.value ?? "").localeCompare(
        String(b.nr.fields.Model?.value ?? "")));
  }
  return out;
}

function firstHierarchy(nr: NormalizedRow) {
  for (const f of HIERARCHY_FIELDS) {
    if (nr.fields[f]) return { field: f, ...nr.fields[f] };
  }
  return null;
}

interface ExportPlan {
  headers: string[];
  sourceHeaders: string[];
  replaceable: Map<string, string>;
  /** Only populated when an explicit non-source sort was requested. */
  sorted: LoadedRow[] | null;
}

function exportPlan(db: Database.Database, projectId: number, mode: ExportMode,
  opts: { sort?: "source" | "make-model" } = {}): ExportPlan {
  const project = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
    .get(projectId) as { mapping_json: string };
  const mapping = JSON.parse(project.mapping_json ?? '{"columns":[]}') as ProjectMapping;
  const first = firstRow(db, projectId);
  const sourceHeaders = first ? Object.keys(first.original) : [];
  const replaceable = new Map<string, string>();     // header -> canonical field
  for (const c of mapping.columns) {
    if (c.field !== "Ignore" && c.field !== "Preserve as Custom Field") {
      replaceable.set(c.column, c.field);
    }
  }
  const headers = mode === "audit" ? [...sourceHeaders, ...AUDIT_COLUMNS] : [...sourceHeaders];
  // a non-source sort needs the rows in memory; source order streams
  const sorted = opts.sort === "make-model"
    ? loadRows(db, projectId, { sort: "make-model" }) : null;
  return { headers, sourceHeaders, replaceable, sorted };
}

function buildExportRow(r: LoadedRow, headers: string[],
  replaceable: Map<string, string>, mode: ExportMode): string[] {
  const sourceHeaders = mode === "audit"
    ? headers.slice(0, headers.length - AUDIT_COLUMNS.length) : headers;
  const hier = firstHierarchy(r.nr);
  const base = sourceHeaders.map((h) => {
    const value = r.original[h] ?? "";
    if (mode !== "replacement") return value;
    const field = replaceable.get(h);
    if (!field) return value;                        // custom/ignored columns untouched
    if (field === "Model Year" || field === "Year Range") {
      return r.nr.year?.status === "Valid" && r.nr.year.normalized
        ? r.nr.year.normalized : value;
    }
    const f = r.nr.fields[field];
    return f?.applied && f.value ? f.value : value;  // only approved values replace
  });
  if (mode === "replacement") return base;
  return [...base,
    r.nr.fields.Make?.raw ?? "", r.nr.fields.Make?.applied ? r.nr.fields.Make.value ?? "" : "",
    r.nr.fields.Make?.confidence ?? "",
    r.nr.fields.Model?.raw ?? "", r.nr.fields.Model?.applied ? r.nr.fields.Model.value ?? "" : "",
    r.nr.fields.Model?.confidence ?? "",
    hier?.raw ?? "", hier?.applied ? hier.value ?? "" : "",
    hier?.classification ?? "", hier?.confidence ?? "",
    r.nr.year?.raw ?? "", r.nr.year?.normalized ?? "", r.nr.year?.status ?? "",
    r.excluded ? "Excluded" : r.review ? "Review Required" : "Standardized",
    [r.nr.reviewReasons.join("; "), r.nr.year?.note].filter(Boolean).join(" | "),
  ];
}

/** Build the exported table (headers + rows) for the requested mode. */
export function buildExportTable(db: Database.Database, projectId: number,
  mode: ExportMode, opts: { sort?: "source" | "make-model" } = {}):
  { headers: string[]; rows: string[][] } {
  const plan = exportPlan(db, projectId, mode, opts);
  const rows: string[][] = [];
  const source = plan.sorted ?? [...iterateRows(db, projectId)];
  for (const r of source) rows.push(buildExportRow(r, plan.headers, plan.replaceable, mode));
  return { headers: plan.headers, rows };
}

/** Last-export formula-protection statistics, surfaced in reports. */
export interface ProtectionStats { neutralizedCells: number; neutralizedColumns: string[] }

const csvEscape = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Stream a standardized CSV row-by-row into `write`.
 * Memory stays flat regardless of project size.
 */
export function streamExportCsv(db: Database.Database, projectId: number,
  mode: ExportMode, write: (chunk: string) => void,
  opts: { sort?: "source" | "make-model" } = {}): ProtectionStats {
  const { headers, replaceable, sorted } = exportPlan(db, projectId, mode, opts);
  const outHeaders = [...headers, "Formula Injection Protection Applied"];
  write(outHeaders.map(csvEscape).join(",") + "\r\n");
  let neutralized = 0;
  const columns = new Set<string>();
  const emit = (r: LoadedRow) => {
    const values = buildExportRow(r, headers, replaceable, mode);
    const res = neutralizeRow(headers, values);
    neutralized += res.neutralizedCount;
    res.neutralizedColumns.forEach((c) => columns.add(c));
    write([...res.values, res.neutralizedCount > 0 ? "Yes" : "No"]
      .map(csvEscape).join(",") + "\r\n");
  };
  if (sorted) for (const r of sorted) emit(r);
  else for (const r of iterateRows(db, projectId)) emit(r);
  return { neutralizedCells: neutralized, neutralizedColumns: [...columns] };
}

export function exportCsvWithStats(db: Database.Database, projectId: number,
  mode: ExportMode, opts: { sort?: "source" | "make-model" } = {}):
  { csv: string; protection: ProtectionStats } {
  const parts: string[] = [];
  const protection = streamExportCsv(db, projectId, mode, (c) => parts.push(c), opts);
  return { csv: parts.join(""), protection };
}

export function exportCsv(db: Database.Database, projectId: number, mode: ExportMode,
  opts: { sort?: "source" | "make-model" } = {}): string {
  return exportCsvWithStats(db, projectId, mode, opts).csv;
}

function styleSheet(ws: ExcelJS.Worksheet, widths: number[] = []) {
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getRow(1).font = { bold: true };
  const cols = ws.columnCount;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, cols) } };
  ws.columns.forEach((c, i) => { c.width = widths[i] ?? Math.min(38, Math.max(12, (c.header?.length ?? 10) + 4)); });
}

/**
 * Stream a standardized XLSX straight to a file using ExcelJS's streaming
 * writer, so large projects never build a whole workbook in memory.
 */
export async function streamExportXlsxToFile(db: Database.Database, projectId: number,
  mode: ExportMode, targetPath: string,
  opts: { sort?: "source" | "make-model" } = {}): Promise<ProtectionStats> {
  const plan = exportPlan(db, projectId, mode, opts);
  const headers = plan.headers;
  const outHeaders = [...headers, "Formula Injection Protection Applied"];
  let neutralized = 0;
  const columns = new Set<string>();
  await writeViaTemp(targetPath, async (tmp) => {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: tmp, useStyles: true });
    const ws = wb.addWorksheet("Standardized",
      { views: [{ state: "frozen", ySplit: 1 }] });
    const header = ws.addRow(outHeaders);
    header.font = { bold: true };
    header.commit();
    const yearCols = headers.map((h, i) => (/year/i.test(h) ? i + 1 : 0)).filter(Boolean);
    const emit = (r: LoadedRow) => {
      const values = buildExportRow(r, headers, plan.replaceable, mode);
      const risky = values.map((v, i) =>
        needsNeutralizing(v, { trusted: isTrustedHyperlinkField(headers[i] ?? "") }));
      const count = risky.filter(Boolean).length;
      neutralized += count;
      risky.forEach((isRisky, i) => { if (isRisky) columns.add(headers[i] ?? ""); });
      const row = ws.addRow([...values, count > 0 ? "Yes" : "No"]);
      for (const c of yearCols) {
        const cell = row.getCell(c);
        if (typeof cell.value === "string" && /^\d{4}$/.test(cell.value)) {
          cell.value = Number(cell.value);
          cell.numFmt = "0";
        }
      }
      risky.forEach((isRisky, i) => {
        if (!isRisky) return;
        const cell = row.getCell(i + 1);
        cell.value = String(values[i] ?? "");   // explicit text cell, never a formula
        cell.numFmt = "@";
      });
      row.commit();
    };
    if (plan.sorted) for (const r of plan.sorted) emit(r);
    else for (const r of iterateRows(db, projectId)) emit(r);
    ws.commit();
    await wb.commit();
  });
  return { neutralizedCells: neutralized, neutralizedColumns: [...columns] };
}

export async function exportXlsxWithStats(db: Database.Database, projectId: number,
  mode: ExportMode, opts: { sort?: "source" | "make-model" } = {}):
  Promise<{ wb: ExcelJS.Workbook; protection: ProtectionStats }> {
  const { headers, rows } = buildExportTable(db, projectId, mode, opts);
  const outHeaders = [...headers, "Formula Injection Protection Applied"];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Standardized");
  ws.addRow(outHeaders);
  const yearCols = headers.map((h, i) => (/year/i.test(h) ? i + 1 : 0)).filter(Boolean);
  const noteCols = headers.map((h, i) => (/note|status|reason/i.test(h) ? i + 1 : 0))
    .filter(Boolean);
  let neutralized = 0;
  const columns = new Set<string>();
  for (const r of rows) {
    // XLSX: the displayed text is preserved exactly. Risky values are written
    // as explicit text cells (never formula cells) and formatted as text, so
    // no spreadsheet application evaluates them.
    const risky = r.map((v, i) =>
      needsNeutralizing(v, { trusted: isTrustedHyperlinkField(headers[i] ?? "") }));
    const rowNeutralized = risky.filter(Boolean).length;
    neutralized += rowNeutralized;
    risky.forEach((isRisky, i) => { if (isRisky) columns.add(headers[i] ?? ""); });
    const row = ws.addRow([...r.map((v) => (v == null ? "" : String(v))),
      rowNeutralized > 0 ? "Yes" : "No"]);
    for (const c of yearCols) {
      const cell = row.getCell(c);
      // trusted numeric year cells stay real numbers and are never altered
      if (typeof cell.value === "string" && /^\d{4}$/.test(cell.value)) {
        cell.value = Number(cell.value);
        cell.numFmt = "0";
      }
    }
    for (const c of noteCols) row.getCell(c).alignment = { wrapText: true, vertical: "top" };
    risky.forEach((isRisky, i) => {
      if (!isRisky) return;
      const cell = row.getCell(i + 1);
      cell.value = String(r[i] ?? "");   // explicit string cell, never a formula
      cell.numFmt = "@";                 // text format
    });
  }
  styleSheet(ws);
  return { wb, protection: { neutralizedCells: neutralized, neutralizedColumns: [...columns] } };
}

export async function exportXlsx(db: Database.Database, projectId: number,
  mode: ExportMode, opts: { sort?: "source" | "make-model" } = {}): Promise<ExcelJS.Workbook> {
  return (await exportXlsxWithStats(db, projectId, mode, opts)).wb;
}

export async function buildChangeReport(db: Database.Database, projectId: number):
  Promise<ExcelJS.Workbook> {
  const project = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
    .get(projectId) as Record<string, unknown>;
  const stats = projectStats(db, projectId);
  const outcome = projectOutcome(db, projectId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Vehicle Catalog - File Standardization";

  // every generated workbook gets the same protection: risky values are written
  // as explicit text cells, and the count is reported on the Summary sheet.
  let reportNeutralized = 0;
  const add = (name: string, headers: string[], rows: unknown[][], widths?: number[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    for (const r of rows) {
      const row = ws.addRow(r.map((v) => (v == null ? "" : v)));
      r.forEach((v, i) => {
        if (!needsNeutralizing(v, { trusted: isTrustedHyperlinkField(headers[i] ?? "") })) return;
        const cell = row.getCell(i + 1);
        cell.value = String(v);
        cell.numFmt = "@";
        reportNeutralized++;
      });
    }
    styleSheet(ws, widths);
    return ws;
  };

  const summary: [string, string | number][] = [
    ["Project", String(project.project_name)],
    ["Input file", String(project.input_filename)],
    ["Input file SHA-256", String(project.input_file_hash)],
    ["Worksheet", String(project.worksheet_name ?? "(CSV)")],
    ["Encoding", String(project.encoding)],
    ["Standardization outcome", outcome],
    ["Input row count", stats.inputRows],
    ["Exported row count", stats.exportRows],
    ["Excluded row count", stats.excluded],
    ["Exact matches", stats.confidence["Exact Canonical Match"] ?? 0],
    ["Alias matches", stats.confidence["Approved Alias Match"] ?? 0],
    ["Deterministic normalizations", stats.confidence["Deterministic Normalization"] ?? 0],
    ["Suggested matches accepted", (db.prepare(`SELECT COUNT(*) n FROM
      standardization_changes WHERE project_id=? AND change_source IN
      ('User decision','Batch mapping')`).get(projectId) as { n: number }).n],
    ["Unmatched Makes", stats.unmatchedMake],
    ["Unmatched Models", stats.unmatchedModel],
    ["Unmatched hierarchy values", stats.unmatchedHierarchy],
    ["Invalid year relationships", stats.invalidYear],
    ["Rows requiring review", stats.reviewRows],
    ["Total changed fields", stats.changedFields],
  ];
  const summarySheet = add("Summary", ["Metric", "Value"],
    summary.map(([a, b]) => [a, b]), [38, 60]);

  const rows = loadRows(db, projectId, { includeExcluded: true });
  const changed = new Set((db.prepare(`SELECT DISTINCT row_number n FROM
    standardization_changes WHERE project_id=? AND field_name <> '(row)'`)
    .all(projectId) as { n: number }[]).map((r) => r.n));
  const rowLine = (r: LoadedRow) => [r.rowNumber,
    r.nr.fields.Make?.raw ?? "", r.nr.fields.Make?.value ?? "",
    r.nr.fields.Model?.raw ?? "", r.nr.fields.Model?.value ?? "",
    firstHierarchy(r.nr)?.raw ?? "", firstHierarchy(r.nr)?.value ?? "",
    r.nr.year?.raw ?? "", r.nr.year?.normalized ?? "", r.nr.year?.status ?? "",
    r.excluded ? "Excluded" : r.review ? "Review Required" : "Standardized",
    r.nr.reviewReasons.join("; ")];
  const ROW_HEADERS = ["Row", "Original Make", "Standard Make", "Original Model",
    "Standard Model", "Original Hierarchy Value", "Standard Hierarchy Value",
    "Original Year", "Normalized Year", "Year Status", "Row Status", "Notes"];
  add("Changed Rows", ROW_HEADERS, rows.filter((r) => changed.has(r.rowNumber)).map(rowLine));
  add("Unchanged Rows", ROW_HEADERS, rows.filter((r) => !changed.has(r.rowNumber)).map(rowLine));
  add("Review Required", ROW_HEADERS, rows.filter((r) => r.review && !r.excluded).map(rowLine));
  add("No Match", ["Row", "Field", "Original Value", "Confidence", "Evidence"],
    rows.flatMap((r) => Object.entries(r.nr.fields)
      .filter(([, f]) => f.confidence === "No Match")
      .map(([field, f]) => [r.rowNumber, field, f.raw, f.confidence, f.evidence ?? ""])),
    [8, 14, 26, 22, 70]);
  add("Conflicts", ["Row", "Field", "Original Value", "Conflict", "Evidence"],
    rows.flatMap((r) => Object.entries(r.nr.fields)
      .filter(([, f]) => f.confidence === "Conflict")
      .map(([field, f]) => [r.rowNumber, field, f.raw, f.conflict ?? "", f.evidence ?? ""])),
    [8, 14, 26, 60, 60]);
  add("Value Mappings", ["Field", "Make Context", "Model Context", "Raw Value",
    "Canonical Value", "Decision", "Rows Affected", "Notes"],
    (db.prepare(`SELECT field_name, make_context, model_context, raw_value,
      canonical_value, decision, applied_row_count, notes FROM project_value_mappings
      WHERE project_id=? ORDER BY field_name, raw_value`).all(projectId) as
      Record<string, unknown>[]).map((m) => Object.values(m)));
  const mapping = JSON.parse(String(project.mapping_json ?? '{"columns":[]}')) as ProjectMapping;
  add("Column Mapping", ["Source Column", "Column Index", "Canonical Field", "Merge Strategy"],
    mapping.columns.map((c) => [c.column, c.index + 1, c.field, c.merge ?? ""]));
  add("Validation Results", ["Row", "Original Year", "Parsed Years", "Status", "Note"],
    rows.filter((r) => r.nr.year).map((r) => [r.rowNumber, r.nr.year!.raw,
      r.nr.year!.normalized, r.nr.year!.status, r.nr.year!.note]), [8, 22, 22, 22, 70]);
  summarySheet.addRow(["Formula Injection Protection Applied",
    reportNeutralized > 0 ? `Yes - ${reportNeutralized} cell(s) written as inert text`
      : "No risky values found"]);
  return wb;
}

const ROW_HEADERS = ["Row", "Original Make", "Standard Make", "Original Model",
  "Standard Model", "Original Hierarchy Value", "Standard Hierarchy Value",
  "Original Year", "Normalized Year", "Year Status", "Row Status", "Notes"];

function rowLineFor(r: LoadedRow): (string | number)[] {
  const h = firstHierarchy(r.nr);
  return [r.rowNumber,
    r.nr.fields.Make?.raw ?? "", r.nr.fields.Make?.value ?? "",
    r.nr.fields.Model?.raw ?? "", r.nr.fields.Model?.value ?? "",
    h?.raw ?? "", h?.value ?? "",
    r.nr.year?.raw ?? "", r.nr.year?.normalized ?? "", r.nr.year?.status ?? "",
    r.excluded ? "Excluded" : r.review ? "Review Required" : "Standardized",
    r.nr.reviewReasons.join("; ")];
}

/**
 * Streaming change report for large projects: sheets are written straight to
 * disk, and rows are streamed from SQLite, so memory stays flat.
 */
export async function writeChangeReportToFile(db: Database.Database, projectId: number,
  targetPath: string): Promise<{ neutralizedCells: number }> {
  const project = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
    .get(projectId) as Record<string, unknown>;
  const stats = projectStats(db, projectId);
  const outcome = projectOutcome(db, projectId);
  const changed = new Set((db.prepare(`SELECT DISTINCT row_number n FROM
    standardization_changes WHERE project_id=? AND field_name <> '(row)'`)
    .all(projectId) as { n: number }[]).map((r) => r.n));
  let neutralized = 0;

  await writeViaTemp(targetPath, async (tmp) => {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: tmp, useStyles: true });
    const sheet = (name: string, headers: string[]) => {
      const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
      const h = ws.addRow(headers);
      h.font = { bold: true };
      h.commit();
      return ws;
    };
    const safeRow = (ws: ExcelJS.Worksheet, headers: string[], values: unknown[]) => {
      const row = ws.addRow(values.map((v) => (v == null ? "" : v)));
      values.forEach((v, i) => {
        if (!needsNeutralizing(v, { trusted: isTrustedHyperlinkField(headers[i] ?? "") })) return;
        const cell = row.getCell(i + 1);
        cell.value = String(v);
        cell.numFmt = "@";
        neutralized++;
      });
      row.commit();
    };

    const summary = sheet("Summary", ["Metric", "Value"]);
    const summaryRows: [string, string | number][] = [
      ["Project", String(project.project_name)],
      ["Input file", String(project.display_filename ?? project.input_filename)],
      ["Input file SHA-256", String(project.input_file_hash)],
      ["Worksheet", String(project.worksheet_name ?? "(CSV)")],
      ["Encoding", String(project.encoding)],
      ["Standardization outcome", outcome],
      ["Input row count", stats.inputRows],
      ["Exported row count", stats.exportRows],
      ["Excluded row count", stats.excluded],
      ["Exact matches", stats.confidence["Exact Canonical Match"] ?? 0],
      ["Alias matches", stats.confidence["Approved Alias Match"] ?? 0],
      ["Deterministic normalizations", stats.confidence["Deterministic Normalization"] ?? 0],
      ["Suggested matches accepted", (db.prepare(`SELECT COUNT(*) n FROM
        standardization_changes WHERE project_id=? AND change_source IN
        ('User decision','Batch mapping')`).get(projectId) as { n: number }).n],
      ["Unmatched Makes", stats.unmatchedMake],
      ["Unmatched Models", stats.unmatchedModel],
      ["Unmatched hierarchy values", stats.unmatchedHierarchy],
      ["Invalid year relationships", stats.invalidYear],
      ["Rows requiring review", stats.reviewRows],
      ["Total changed fields", stats.changedFields],
    ];
    for (const r of summaryRows) safeRow(summary, ["Metric", "Value"], r);

    const changedWs = sheet("Changed Rows", ROW_HEADERS);
    const unchangedWs = sheet("Unchanged Rows", ROW_HEADERS);
    const reviewWs = sheet("Review Required", ROW_HEADERS);
    const noMatchWs = sheet("No Match",
      ["Row", "Field", "Original Value", "Confidence", "Evidence"]);
    const conflictWs = sheet("Conflicts",
      ["Row", "Field", "Original Value", "Conflict", "Evidence"]);
    const validationWs = sheet("Validation Results",
      ["Row", "Original Year", "Parsed Years", "Status", "Note"]);

    for (const r of iterateRows(db, projectId, { includeExcluded: true })) {
      const line = rowLineFor(r);
      safeRow(changed.has(r.rowNumber) ? changedWs : unchangedWs, ROW_HEADERS, line);
      if (r.review && !r.excluded) safeRow(reviewWs, ROW_HEADERS, line);
      for (const [field, f] of Object.entries(r.nr.fields)) {
        if (f.confidence === "No Match") {
          safeRow(noMatchWs, [], [r.rowNumber, field, f.raw, f.confidence, f.evidence ?? ""]);
        } else if (f.confidence === "Conflict") {
          safeRow(conflictWs, [], [r.rowNumber, field, f.raw, f.conflict ?? "",
            f.evidence ?? ""]);
        }
      }
      if (r.nr.year) {
        safeRow(validationWs, [], [r.rowNumber, r.nr.year.raw, r.nr.year.normalized,
          r.nr.year.status, r.nr.year.note]);
      }
    }
    for (const ws of [changedWs, unchangedWs, reviewWs, noMatchWs, conflictWs,
      validationWs]) ws.commit();

    const mapWs = sheet("Value Mappings", ["Field", "Make Context", "Model Context",
      "Raw Value", "Canonical Value", "Decision", "Rows Affected", "Notes"]);
    for (const m of db.prepare(`SELECT field_name, make_context, model_context, raw_value,
      canonical_value, decision, applied_row_count, notes FROM project_value_mappings
      WHERE project_id=? ORDER BY field_name, raw_value`).all(projectId) as
      Record<string, unknown>[]) {
      safeRow(mapWs, [], Object.values(m));
    }
    mapWs.commit();

    const mapping = JSON.parse(String(project.mapping_json ?? '{"columns":[]}')) as ProjectMapping;
    const colWs = sheet("Column Mapping",
      ["Source Column", "Column Index", "Canonical Field", "Merge Strategy"]);
    for (const c of mapping.columns) {
      safeRow(colWs, [], [c.column, c.index + 1, c.field, c.merge ?? ""]);
    }
    colWs.commit();

    summary.addRow(["Formula Injection Protection Applied",
      neutralized > 0 ? `Yes - ${neutralized} cell(s) written as inert text`
        : "No risky values found"]).commit();
    summary.commit();
    await wb.commit();
  });
  return { neutralizedCells: neutralized };
}

export async function buildReviewOnlyWorkbook(db: Database.Database, projectId: number):
  Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Review Required");
  ws.addRow(["Row", "Field", "Original Value", "Suggested Value", "Confidence",
    "Conflict / Reason", "Alternatives", "Evidence"]);
  const safeAdd = (values: unknown[]) => {
    const row = ws.addRow(values.map((v) => (v == null ? "" : v)));
    values.forEach((v, i) => {
      if (!needsNeutralizing(v)) return;
      const cell = row.getCell(i + 1);
      cell.value = String(v);
      cell.numFmt = "@";
    });
  };
  for (const r of loadRows(db, projectId, { includeExcluded: false })) {
    if (!r.review) continue;
    for (const [field, f] of Object.entries(r.nr.fields)) {
      if (f.applied || !f.raw) continue;
      safeAdd([r.rowNumber, field, f.raw, f.value ?? "", f.confidence,
        f.conflict ?? "", (f.alternatives ?? []).map((a) => a.value).join(" | "),
        f.evidence ?? ""]);
    }
    if (r.nr.year && !["Valid", "Missing"].includes(r.nr.year.status)) {
      safeAdd([r.rowNumber, "Model Year", r.nr.year.raw, r.nr.year.normalized,
        r.nr.year.status, r.nr.year.note, "", ""]);
    }
  }
  styleSheet(ws, [8, 14, 26, 26, 26, 50, 40, 60]);
  return wb;
}

export function valueMappingCsv(db: Database.Database, projectId: number): string {
  const raw = db.prepare(`SELECT field_name, make_context, model_context, raw_value,
    canonical_value, canonical_classification, decision, applied_row_count, notes
    FROM project_value_mappings WHERE project_id=? ORDER BY field_name, raw_value`)
    .all(projectId) as Record<string, unknown>[];
  // raw_value comes from the uploaded file, so it is neutralized for CSV
  const rows = raw.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of ["raw_value", "canonical_value", "notes"]) {
      out[k] = neutralizeRow([k], [r[k]]).values[0];
    }
    return out;
  });
  return toCsv(rows, [
    { header: "Field", key: "field_name" },
    { header: "Make Context", key: "make_context" },
    { header: "Model Context", key: "model_context" },
    { header: "Raw Value", key: "raw_value" },
    { header: "Canonical Value", key: "canonical_value" },
    { header: "Canonical Classification", key: "canonical_classification" },
    { header: "Decision", key: "decision" },
    { header: "Rows Affected", key: "applied_row_count" },
    { header: "Notes", key: "notes" }]);
}

export function jsonReport(db: Database.Database, projectId: number): Record<string, unknown> {
  const project = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
    .get(projectId) as Record<string, unknown>;
  return {
    project: { id: project.id, name: project.project_name,
      inputFilename: project.input_filename, inputFileHash: project.input_file_hash,
      format: project.input_format, worksheet: project.worksheet_name,
      encoding: project.encoding, status: project.status },
    outcome: projectOutcome(db, projectId),
    statistics: projectStats(db, projectId),
    valueMappings: db.prepare("SELECT * FROM project_value_mappings WHERE project_id=?")
      .all(projectId),
    changes: db.prepare(`SELECT row_number, field_name, original_value, new_value,
      change_source, confidence, user_decision FROM standardization_changes
      WHERE project_id=? ORDER BY row_number LIMIT 50000`).all(projectId),
    generatedAt: new Date().toISOString(),
    canonicalCatalogVersion: (db.prepare("SELECT value FROM catalog_meta WHERE key='catalog_version'")
      .get() as { value: string } | undefined)?.value ?? "unknown",
  };
}

export function projectExportDir(projectId: number): string {
  // project-scoped folder; the name is derived from the ID only, never from a
  // user-supplied filename, so one project cannot reach another's workspace
  const dir = resolveInside(PROJECT_EXPORT_DIR, `project-${Number(projectId)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write every project output atomically (temp file + rename). */
export async function writeAllOutputs(db: Database.Database, projectId: number,
  mode: ExportMode): Promise<{ directory: string; files: string[];
    protection: ProtectionStats }> {
  const dir = projectExportDir(projectId);
  const p = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
    .get(projectId) as Record<string, unknown>;
  const base = sanitizeDisplayName(String(p.display_filename ?? p.input_filename ?? "project"))
    .replace(/\.[^.]+$/, "");
  const files: string[] = [];

  // CSV is streamed to disk row-by-row (flat memory on any project size)
  const csvPath = resolveInside(dir, `${base}_standardized_${mode}.csv`);
  let csvProtection: ProtectionStats = { neutralizedCells: 0, neutralizedColumns: [] };
  await writeViaTemp(csvPath, (tmp) => {
    const out = fs.createWriteStream(tmp, { encoding: "utf-8" });
    csvProtection = streamExportCsv(db, projectId, mode, (chunk) => out.write(chunk));
    return new Promise<void>((resolve, reject) => {
      out.on("error", reject);
      out.end(() => resolve());
    });
  });
  files.push(csvPath);
  const csv = { protection: csvProtection };

  const xlsxPath = resolveInside(dir, `${base}_standardized_${mode}.xlsx`);
  const xlsxProtection = await streamExportXlsxToFile(db, projectId, mode, xlsxPath);
  const xlsx = { protection: xlsxProtection };
  files.push(xlsxPath);

  const changePath = resolveInside(dir, `${base}_Standardization_Changes.xlsx`);
  await writeChangeReportToFile(db, projectId, changePath);
  files.push(changePath);

  const reviewPath = resolveInside(dir, `${base}_review.xlsx`);
  const reviewWb = await buildReviewOnlyWorkbook(db, projectId);
  await writeViaTemp(reviewPath, (tmp) => reviewWb.xlsx.writeFile(tmp));
  files.push(reviewPath);

  const mapPath = resolveInside(dir, `${base}_value_mappings.csv`);
  writeFileAtomic(mapPath, valueMappingCsv(db, projectId));
  files.push(mapPath);

  const jsonPath = resolveInside(dir, `${base}_report.json`);
  writeFileAtomic(jsonPath, JSON.stringify({
    ...jsonReport(db, projectId),
    formulaInjectionProtection: {
      applied: csv.protection.neutralizedCells > 0 || xlsx.protection.neutralizedCells > 0,
      csvCellsNeutralized: csv.protection.neutralizedCells,
      xlsxCellsProtected: xlsx.protection.neutralizedCells,
      columns: [...new Set([...csv.protection.neutralizedColumns,
        ...xlsx.protection.neutralizedColumns])],
    },
  }, null, 2));
  files.push(jsonPath);

  return { directory: dir, files,
    protection: { neutralizedCells: csv.protection.neutralizedCells
      + xlsx.protection.neutralizedCells,
      neutralizedColumns: [...new Set([...csv.protection.neutralizedColumns,
        ...xlsx.protection.neutralizedColumns])] } };
}

/** Simplified lookup workbook for external data-validation workflows. */
export async function buildLookupWorkbook(db: Database.Database): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Vehicle Catalog - Canonical Vehicle Lookup";
  const all = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
  const add = (name: string, headers: string[], rows: unknown[][], widths?: number[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    styleSheet(ws, widths);
    return ws;
  };
  add("Make Model Lookup", ["Standard Make", "Standard Model", "Confirmed Model Years",
    "First Year", "Last Year", "Vehicle Category", "Lifecycle Status", "Validation Status"],
    all(`SELECT k.standard_make, m.standard_model, m.confirmed_model_years,
      m.first_confirmed_model_year, m.last_confirmed_model_year, m.vehicle_category,
      m.lifecycle_status, m.validation_status
      FROM models m JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model`).map((r) => Object.values(r)),
    [18, 26, 24, 10, 10, 18, 14, 18]);
  add("Hierarchy Lookup", ["Standard Make", "Standard Model", "Hierarchy Value",
    "Classification Type", "Confirmed Model Years", "Validation Status"],
    all(`SELECT k.standard_make, m.standard_model, s.value, s.classification_type,
      s.confirmed_model_years, s.validation_status
      FROM vehicle_hierarchy_values s JOIN models m ON m.id=s.model_id
      JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model, s.classification_type, s.value`)
      .map((r) => Object.values(r)), [18, 24, 22, 18, 24, 18]);
  add("Configuration Lookup", ["Standard Make", "Standard Model", "Configuration Value",
    "Classification Type", "Confirmed Model Years", "Validation Status"],
    all(`SELECT k.standard_make, m.standard_model, s.value, s.classification_type,
      s.confirmed_model_years, s.validation_status
      FROM vehicle_configuration_values s JOIN models m ON m.id=s.model_id
      JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model, s.classification_type, s.value`)
      .map((r) => Object.values(r)), [18, 24, 22, 18, 24, 18]);
  add("Aliases", ["Raw or Alias Make", "Raw or Alias Model", "Canonical Make",
    "Canonical Model", "Alias Type", "Confidence"],
    all(`SELECT a.raw_or_alias_make, a.raw_or_alias_model,
      COALESCE(k.standard_make,''), COALESCE(m.standard_model,''), a.alias_type,
      a.confidence FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
      LEFT JOIN models m ON m.id=a.canonical_model_id
      ORDER BY a.raw_or_alias_make, a.raw_or_alias_model`).map((r) => Object.values(r)),
    [20, 28, 18, 24, 26, 12]);
  add("Year Validation", ["Standard Make", "Standard Model", "Model Year"],
    all(`SELECT k.standard_make, m.standard_model, y.model_year
      FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model, y.model_year`).map((r) => Object.values(r)),
    [18, 26, 12]);
  const ws = wb.addWorksheet("Usage Instructions");
  ws.addRow(["Canonical Vehicle Lookup - usage"]);
  ws.getRow(1).font = { bold: true, size: 14 };
  for (const line of [
    "",
    "This simplified workbook is optimized for external lookup and Excel data-validation",
    "workflows. It does NOT replace the full Version 4 catalog workbook",
    "(Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v4.xlsx), which remains the complete record.",
    "",
    "Sheets:",
    "  Make Model Lookup      - one row per canonical Make + Model with confirmed years.",
    "  Hierarchy Lookup       - approved Sub-model / Trim / Series / Edition / Generation / Chassis.",
    "  Configuration Lookup   - Engine, Drivetrain, Body Style, Package, Commercial Configuration.",
    "  Aliases                - raw/alias spellings and the canonical values they resolve to.",
    "  Year Validation        - one row per Make + Model + valid model year.",
    "",
    "Typical use in Excel:",
    "  1. VLOOKUP/XLOOKUP a raw make against the Aliases sheet to obtain the canonical Make.",
    "  2. Use Data > Data Validation > List against a filtered Make Model Lookup range",
    "     to restrict Model entry to valid values for the chosen Make.",
    "  3. Validate a year with COUNTIFS over Year Validation (Make, Model, Year) > 0.",
    "  4. Hierarchy values are only valid for their listed Make + Model + years.",
    "",
    "Important: hierarchy values (Trim, Sub-model, ...) and configuration values",
    "(Engine, Drivetrain, Body Style, ...) are deliberately kept in separate sheets.",
    "A configuration value must never be used as a Sub-model or Model.",
  ]) ws.addRow([line]);
  ws.columns[0].width = 100;
  return wb;
}
