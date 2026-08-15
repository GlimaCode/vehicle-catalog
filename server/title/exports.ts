/**
 * Title Optimizer exports and reporting.
 *
 * Audit mode (the default) preserves the original Title column untouched and
 * appends optimization columns. Replacement mode writes the approved title into
 * the mapped Title column and changes nothing else - every other source column
 * is emitted byte-for-byte as it was read.
 *
 * All output passes through the Version 5.1 formula-injection protection.
 */
import ExcelJS from "exceljs";
import type Database from "better-sqlite3";
import { neutralize, needsNeutralizing } from "../security/formula.js";
import { titleLength } from "./text.js";
import { titleProjectStats } from "./project.js";

export type TitleExportMode = "audit" | "replacement";

export const AUDIT_COLUMNS = [
  "Original Title", "Optimized Title", "Original Character Count",
  "Optimized Character Count", "Characters Removed", "Title Optimization Status",
  "Applied Title Rules", "Title Optimization Notes",
];

interface ExportPlan {
  headers: string[];
  titleHeader: string;
  titleIndex: number;
  mode: TitleExportMode;
  maxCharacters: number;
}

function buildPlan(db: Database.Database, projectId: number, mode: TitleExportMode)
  : ExportPlan {
  const project = db.prepare("SELECT * FROM title_optimization_projects WHERE id=?")
    .get(projectId) as Record<string, any>;
  if (!project) throw new Error(`Title project ${projectId} not found`);
  const mapping = JSON.parse(String(project.mapping_json ?? "null"));
  const first = db.prepare(`SELECT source_json FROM title_optimization_rows
    WHERE project_id=? ORDER BY row_number LIMIT 1`).pluck().get(projectId) as
    string | undefined;
  const headers = first ? Object.keys(JSON.parse(first)) : [];
  const titleCol = mapping?.columns?.find((c: any) => c.field === "Title");
  const titleIndex = titleCol ? Number(titleCol.index) : -1;
  return {
    headers, titleIndex, mode,
    titleHeader: headers[titleIndex] ?? "Title",
    maxCharacters: Number(project.max_characters ?? 80),
  };
}

/** Rows in stored order. Row order is never changed by the optimizer. */
function* iterateRows(db: Database.Database, projectId: number) {
  const stmt = db.prepare(`SELECT * FROM title_optimization_rows
    WHERE project_id=? ORDER BY row_number`);
  for (const row of stmt.iterate(projectId)) yield row as Record<string, any>;
}

function exportValues(plan: ExportPlan, row: Record<string, any>): string[] {
  const source = JSON.parse(String(row.source_json ?? "{}")) as Record<string, string>;
  const values = plan.headers.map((h) => source[h] ?? "");
  const finalTitle = String(row.final_title ?? row.proposed_title ?? row.original_title);
  const excluded = Number(row.excluded) === 1;

  if (plan.mode === "replacement") {
    // Only the mapped Title column may change, and never for an excluded row.
    if (plan.titleIndex >= 0 && !excluded) values[plan.titleIndex] = finalTitle;
    return values;
  }
  // Audit mode: the original Title column is left exactly as it was read.
  const rules = (JSON.parse(String(row.applied_rules ?? "[]")) as string[]).join("; ");
  const notes = [
    ...(JSON.parse(String(row.removed_information ?? "[]")) as string[])
      .map((r) => `Removed: ${r}`),
    ...(JSON.parse(String(row.validation_warnings ?? "[]")) as string[]),
    row.notes ? String(row.notes) : "",
  ].filter(Boolean).join(" | ");
  return [...values,
    String(row.original_title),
    excluded ? String(row.original_title) : finalTitle,
    String(row.original_length),
    String(excluded ? row.original_length : titleLength(finalTitle)),
    String(excluded ? 0 : row.characters_removed),
    String(row.title_status),
    rules,
    notes,
  ];
}

function headerRow(plan: ExportPlan): string[] {
  return plan.mode === "replacement" ? [...plan.headers]
    : [...plan.headers, ...AUDIT_COLUMNS];
}

const csvCell = (v: string) => {
  const { value } = neutralize(v);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

export interface TitleProtectionStats { neutralizedCells: number }

/** Streams the export as CSV. Memory stays flat regardless of row count. */
export function streamTitleCsv(db: Database.Database, projectId: number,
  mode: TitleExportMode, write: (chunk: string) => void): TitleProtectionStats {
  const plan = buildPlan(db, projectId, mode);
  let neutralized = 0;
  write(`${headerRow(plan).map(csvCell).join(",")}\r\n`);
  for (const row of iterateRows(db, projectId)) {
    const values = exportValues(plan, row);
    for (const v of values) if (needsNeutralizing(v)) neutralized++;
    write(`${values.map(csvCell).join(",")}\r\n`);
  }
  return { neutralizedCells: neutralized };
}

export function exportTitleCsv(db: Database.Database, projectId: number,
  mode: TitleExportMode): { csv: string; protection: TitleProtectionStats } {
  const parts: string[] = [];
  const protection = streamTitleCsv(db, projectId, mode, (c) => parts.push(c));
  return { csv: parts.join(""), protection };
}

/** Writes an XLSX export, forcing risky values to explicit text cells. */
export async function exportTitleXlsx(db: Database.Database, projectId: number,
  mode: TitleExportMode): Promise<{ wb: ExcelJS.Workbook;
    protection: TitleProtectionStats }> {
  const plan = buildPlan(db, projectId, mode);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(mode === "audit" ? "Title Audit" : "Optimized");
  ws.addRow(headerRow(plan));
  ws.getRow(1).font = { bold: true };
  let neutralized = 0;
  for (const row of iterateRows(db, projectId)) {
    const values = exportValues(plan, row);
    const added = ws.addRow(values);
    values.forEach((v, i) => {
      if (needsNeutralizing(v)) {
        neutralized++;
        const cell = added.getCell(i + 1);
        cell.value = String(v);     // explicit string cell, never a formula
        cell.numFmt = "@";
      }
    });
  }
  return { wb, protection: { neutralizedCells: neutralized } };
}

/** Builds the 11-sheet Title Optimization Report. */
export async function buildTitleReport(db: Database.Database, projectId: number)
  : Promise<ExcelJS.Workbook> {
  const project = db.prepare("SELECT * FROM title_optimization_projects WHERE id=?")
    .get(projectId) as Record<string, any>;
  const stats = titleProjectStats(db, projectId);
  const max = Number(project.max_characters ?? 80);
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Vehicle Catalog - Title Optimizer";

  const sheet = (name: string, headers: string[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    return ws;
  };
  const safe = (ws: ExcelJS.Worksheet, values: (string | number)[]) => {
    const row = ws.addRow(values);
    values.forEach((v, i) => {
      if (typeof v === "string" && needsNeutralizing(v)) {
        const cell = row.getCell(i + 1);
        cell.value = v;
        cell.numFmt = "@";
      }
    });
    return row;
  };

  // 1. Summary
  const summary = sheet("Summary", ["Metric", "Value"]);
  const ruleCounts = db.prepare(`SELECT rule_id, COUNT(*) n
    FROM title_optimization_changes WHERE project_id=? GROUP BY rule_id
    ORDER BY n DESC`).all(projectId) as { rule_id: string; n: number }[];
  const byMake = db.prepare(`SELECT COALESCE(json_extract(source_json,'$.Make'),'')
      mk, COUNT(*) n FROM title_optimization_rows WHERE project_id=?
    GROUP BY mk ORDER BY n DESC`).all(projectId) as { mk: string; n: number }[];
  for (const [k, v] of [
    ["Input row count", project.row_count],
    ["Titles processed", stats.inputRows],
    ["Already within limit", stats.withinLimit],
    ["Titles optimized", stats.optimized],
    ["Manual review required", stats.manualReview],
    ["Unable to reach limit", stats.unableToReach],
    ["Excluded", stats.excluded],
    ["Average original length", stats.avgOriginalLength],
    ["Average optimized length", stats.avgOptimizedLength],
    ["Maximum original length", stats.maxOriginalLength],
    ["Maximum optimized length", stats.maxOptimizedLength],
    ["Total characters removed", stats.totalCharactersRemoved],
    ["Maximum characters allowed", max],
    ["Character counting method", "Unicode code points"],
  ] as [string, unknown][]) summary.addRow([k, v as string | number]);
  summary.addRow([]);
  summary.addRow(["Count by applied rule", ""]);
  for (const r of ruleCounts) summary.addRow([r.rule_id, r.n]);
  summary.addRow([]);
  summary.addRow(["Count by Make", ""]);
  for (const r of byMake.slice(0, 100)) safe(summary, [r.mk || "(unmapped)", r.n]);
  summary.addRow([]);
  summary.addRow(["Count by Model", ""]);
  const byModel = db.prepare(`SELECT COALESCE(json_extract(source_json,'$.Model'),'')
      md, COUNT(*) n FROM title_optimization_rows WHERE project_id=?
    GROUP BY md ORDER BY n DESC`).all(projectId) as { md: string; n: number }[];
  for (const r of byModel.slice(0, 200)) safe(summary, [r.md || "(unmapped)", r.n]);
  summary.getColumn(1).width = 34;
  summary.getColumn(2).width = 18;

  // 2-6. Status sheets
  const detailHeaders = ["Row", "Original Title", "Original Characters",
    "Optimized Title", "Optimized Characters", "Characters Removed",
    "Applied Rules", "Removed Information", "Preserved Information",
    "Validation Warnings", "Status", "User Decision", "Notes"];
  const statusSheets: [string, string[]][] = [
    ["Optimized Titles", ["Optimized", "Optimized with Warning"]],
    ["Already Within Limit", ["Already Within Limit"]],
    ["Manual Review", ["Manual Review Required"]],
    ["Unable to Reach Limit", ["Unable to Reach Limit"]],
    ["Excluded", ["Excluded"]],
  ];
  for (const [name, statuses] of statusSheets) {
    const ws = sheet(name, detailHeaders);
    const stmt = db.prepare(`SELECT * FROM title_optimization_rows
      WHERE project_id=? AND title_status IN (${statuses.map(() => "?").join(",")})
      ORDER BY row_number`);
    for (const r of stmt.iterate(projectId, ...statuses)) {
      const row = r as Record<string, any>;
      safe(ws, [row.row_number, String(row.original_title), row.original_length,
        String(row.final_title ?? row.proposed_title ?? ""),
        Number(row.final_length ?? row.proposed_length ?? 0),
        row.characters_removed,
        (JSON.parse(String(row.applied_rules ?? "[]")) as string[]).join("; "),
        (JSON.parse(String(row.removed_information ?? "[]")) as string[]).join("; "),
        (JSON.parse(String(row.preserved_information ?? "[]")) as string[]).join("; "),
        (JSON.parse(String(row.validation_warnings ?? "[]")) as string[]).join(" | "),
        String(row.title_status), String(row.user_decision ?? ""),
        String(row.notes ?? "")]);
    }
    ws.getColumn(2).width = 60;
    ws.getColumn(4).width = 60;
  }

  // 7. Rule Usage
  const ruleWs = sheet("Rule Usage",
    ["Rule ID", "Rule Name", "Stage", "Times Applied", "Characters Saved", "Enabled"]);
  const usage = db.prepare(`SELECT c.rule_id, c.rule_name, c.stage, COUNT(*) n,
      SUM(c.characters_saved) saved
    FROM title_optimization_changes c WHERE c.project_id=?
    GROUP BY c.rule_id, c.rule_name, c.stage ORDER BY c.stage, n DESC`)
    .all(projectId) as Record<string, any>[];
  const enabledMap = new Map((db.prepare(
    "SELECT rule_id, enabled FROM title_rules").all() as Record<string, any>[])
    .map((r) => [r.rule_id as string, Number(r.enabled) === 1]));
  for (const u of usage) {
    ruleWs.addRow([u.rule_id, u.rule_name, u.stage, u.n, u.saved,
      enabledMap.get(u.rule_id) === false ? "No" : "Yes"]);
  }
  ruleWs.getColumn(2).width = 40;

  // 8. Abbreviation Usage
  const abbrWs = sheet("Abbreviation Usage", ["Full Value", "Abbreviated Value",
    "Applicable Field", "Minimum Characters Saved", "Ambiguity Risk",
    "Approval Status", "Times Applied", "Notes"]);
  const abbrRows = db.prepare(`SELECT full_value, abbreviated_value, applicable_field,
    minimum_characters_saved, ambiguity_risk, approval_status, notes
    FROM title_abbreviation_mappings
    WHERE project_id IS NULL OR project_id=? ORDER BY ambiguity_risk, full_value`)
    .all(projectId) as Record<string, any>[];
  const applied = db.prepare(`SELECT removed_phrase, COUNT(*) n
    FROM title_optimization_changes WHERE project_id=? AND rule_id='S4_ABBREVIATE'
    GROUP BY removed_phrase`).all(projectId) as { removed_phrase: string; n: number }[];
  const appliedMap = new Map(applied.map((a) =>
    [String(a.removed_phrase ?? "").split(" -> ")[0].toLowerCase(), a.n]));
  for (const a of abbrRows) {
    abbrWs.addRow([a.full_value, a.abbreviated_value, a.applicable_field,
      a.minimum_characters_saved, a.ambiguity_risk, a.approval_status,
      appliedMap.get(String(a.full_value).toLowerCase()) ?? 0, a.notes ?? ""]);
  }
  abbrWs.getColumn(8).width = 44;

  // 9. Template
  const tplWs = sheet("Template", ["Property", "Value"]);
  const tpl = project.template_id
    ? db.prepare("SELECT * FROM title_templates WHERE id=?")
      .get(project.template_id) as Record<string, any> | undefined
    : undefined;
  tplWs.addRow(["Template", tpl?.name ?? "(none - rule-based optimization only)"]);
  tplWs.addRow(["Pattern", tpl?.pattern ?? ""]);
  tplWs.addRow(["Required fields", tpl?.required_fields ?? "[]"]);
  tplWs.addRow(["Optional fields", tpl?.optional_fields ?? "[]"]);
  tplWs.addRow(["Field priority", tpl?.field_priority ?? "[]"]);
  tplWs.addRow(["Maximum characters", max]);
  tplWs.getColumn(1).width = 22;
  tplWs.getColumn(2).width = 80;

  // 10. Character Distribution
  const distWs = sheet("Character Distribution",
    ["Bucket", "Original Titles", "Optimized Titles"]);
  const buckets = [[0, 40], [41, 60], [61, 70], [71, 79], [80, 80], [81, 100],
    [101, 150], [151, 100000]];
  for (const [lo, hi] of buckets) {
    const o = db.prepare(`SELECT COUNT(*) FROM title_optimization_rows
      WHERE project_id=? AND original_length BETWEEN ? AND ?`)
      .pluck().get(projectId, lo, hi) as number;
    const n = db.prepare(`SELECT COUNT(*) FROM title_optimization_rows
      WHERE project_id=? AND COALESCE(final_length, proposed_length) BETWEEN ? AND ?`)
      .pluck().get(projectId, lo, hi) as number;
    distWs.addRow([hi === 100000 ? `${lo}+`
      : lo === hi ? `${lo} (exactly at limit)` : `${lo}-${hi}`, o, n]);
  }
  distWs.getColumn(1).width = 24;

  // 11. Validation Warnings
  const warnWs = sheet("Validation Warnings", ["Row", "Status", "Warning",
    "Original Title", "Proposed Title"]);
  for (const r of iterateRows(db, projectId)) {
    const warnings = JSON.parse(String(r.validation_warnings ?? "[]")) as string[];
    for (const w of warnings) {
      safe(warnWs, [r.row_number, String(r.title_status), w,
        String(r.original_title), String(r.final_title ?? r.proposed_title ?? "")]);
    }
  }
  warnWs.getColumn(3).width = 70;
  warnWs.getColumn(4).width = 50;

  return wb;
}
