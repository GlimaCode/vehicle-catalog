/** Version 3 Excel workbook: 25 worksheets, hierarchy/configuration separated. */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type Database from "better-sqlite3";
import { EXPORT_DIR, CATALOG_DIR } from "./db.js";

export const WORKBOOK_V3 = "Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v3.xlsx";
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

function csvRows(file: string): Row[] {
  const p = path.join(CATALOG_DIR, file);
  if (!fs.existsSync(p)) return [];
  return parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""),
    { columns: true, skip_empty_lines: true, bom: true }) as Row[];
}

const VALUE_COLS: ColSpec[] = [
  { header: "Standard Make", key: "standard_make", width: 15 },
  { header: "Standard Model", key: "standard_model", width: 22 },
  { header: "Value", key: "value", width: 20 },
  { header: "Classification Type", key: "classification_type", width: 20 },
  { header: "Confirmed Model Years", key: "confirmed_model_years", width: 24 },
  { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 11 },
  { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 11 },
  { header: "Validation Status", key: "validation_status", width: 17 },
  { header: "Source Organization Count", key: "source_organization_count", width: 11 },
  { header: "Source Dataset Count", key: "source_dataset_count", width: 11 },
  { header: "Primary Source", key: "source_url", width: 40, url: true },
  { header: "Raw Source Value", key: "raw_source_value", width: 30, wrap: true },
  { header: "Notes", key: "notes", width: 55, wrap: true },
];

export function buildWorkbookV3(db: Database.Database): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "US Vehicle Catalog Application (V3)";
  const all = <T = Row>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...p) as T[];
  const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const valueSql = (table: string, filter = "") => `
    SELECT s.*, k.standard_make, m.standard_model
    FROM ${table} s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
    ${filter} ORDER BY k.standard_make, m.standard_model, s.classification_type, s.value`;

  // 1. Vehicle Hierarchy (hierarchy values only)
  sheet(wb, "Vehicle Hierarchy", VALUE_COLS, all(valueSql("vehicle_hierarchy_values")));
  // 2. Vehicle Configurations
  sheet(wb, "Vehicle Configurations", VALUE_COLS, all(valueSql("vehicle_configuration_values")));

  // 3-4. Makes / Models
  sheet(wb, "Makes", [
    { header: "Make ID", key: "id", width: 8 },
    { header: "Standard Make", key: "standard_make", width: 17 },
    { header: "Official Display Name", key: "official_display_name", width: 19 },
    { header: "US Market Start Year", key: "us_market_start_year", width: 11 },
    { header: "US Market End Year", key: "us_market_end_year", width: 11 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 13 },
    { header: "Model Count", key: "model_count", width: 10 },
    { header: "Hierarchy Value Count", key: "hier_count", width: 11 },
    { header: "Configuration Value Count", key: "conf_count", width: 11 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Notes", key: "notes", width: 55, wrap: true },
  ], all(`SELECT k.*,
      (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id) model_count,
      (SELECT COUNT(*) FROM vehicle_hierarchy_values s JOIN models m2 ON m2.id=s.model_id
        WHERE m2.make_id=k.id) hier_count,
      (SELECT COUNT(*) FROM vehicle_configuration_values s JOIN models m3 ON m3.id=s.model_id
        WHERE m3.make_id=k.id) conf_count
      FROM makes k ORDER BY k.standard_make`));
  sheet(wb, "Models", [
    { header: "Model ID", key: "id", width: 8 },
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 24 },
    { header: "Confirmed Model Years", key: "confirmed_model_years", width: 24 },
    { header: "First Confirmed Model Year", key: "first_confirmed_model_year", width: 11 },
    { header: "Last Confirmed Model Year", key: "last_confirmed_model_year", width: 11 },
    { header: "Lifecycle Status", key: "lifecycle_status", width: 14 },
    { header: "Vehicle Category", key: "vehicle_category", width: 17 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Source Organization Count", key: "source_organization_count", width: 11 },
    { header: "Source Dataset Count", key: "source_dataset_count", width: 11 },
    { header: "Primary Source", key: "primary_source_url", width: 40, url: true },
    { header: "Secondary Source", key: "secondary_source_url", width: 34, url: true },
    { header: "Notes", key: "notes", width: 60, wrap: true },
  ], all(`SELECT m.*, k.standard_make FROM models m JOIN makes k ON k.id=m.make_id
      ORDER BY k.standard_make, m.standard_model`));

  // 5-15. per-classification sheets
  const classSheets: [string, string, string][] = [
    ["Submodels", "vehicle_hierarchy_values", "Sub-model"],
    ["Trims", "vehicle_hierarchy_values", "Trim"],
    ["Series", "vehicle_hierarchy_values", "Series"],
    ["Editions", "vehicle_hierarchy_values", "Edition"],
    ["Generations", "vehicle_hierarchy_values", "Generation"],
    ["Chassis", "vehicle_hierarchy_values", "Chassis"],
    ["Engines", "vehicle_configuration_values", "Engine Variant"],
    ["Drivetrains", "vehicle_configuration_values", "Drivetrain Variant"],
    ["Body Styles", "vehicle_configuration_values", "Body Style"],
    ["Packages", "vehicle_configuration_values", "Package"],
    ["Commercial Configurations", "vehicle_configuration_values", "Commercial Configuration"],
  ];
  for (const [name, table, type] of classSheets) {
    sheet(wb, name, VALUE_COLS,
      all(valueSql(table, `WHERE s.classification_type='${type}'`)));
  }

  // 16-18. year matrices
  sheet(wb, "Model Years", [
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 24 },
    { header: "Model Year", key: "model_year", width: 10 },
    { header: "Vehicle Category", key: "vehicle_category", width: 17 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ], all(`SELECT k.standard_make, m.standard_model, y.model_year, m.vehicle_category,
      y.validation_status, y.source_url
      FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      ORDER BY y.model_year, k.standard_make, m.standard_model`));
  const yearMatrix = (table: string, yt: string, fk: string) => all(`
    SELECT k.standard_make, m.standard_model, s.value, s.classification_type,
      sy.model_year, sy.validation_status, sy.source_url
    FROM ${yt} sy JOIN ${table} s ON s.id=sy.${fk}
    JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
    ORDER BY sy.model_year, k.standard_make, m.standard_model, s.value`);
  const YEAR_COLS: ColSpec[] = [
    { header: "Standard Make", key: "standard_make", width: 15 },
    { header: "Standard Model", key: "standard_model", width: 22 },
    { header: "Value", key: "value", width: 20 },
    { header: "Classification Type", key: "classification_type", width: 20 },
    { header: "Model Year", key: "model_year", width: 10 },
    { header: "Validation Status", key: "validation_status", width: 17 },
    { header: "Source", key: "source_url", width: 44, url: true },
  ];
  sheet(wb, "Hierarchy Years", YEAR_COLS,
    yearMatrix("vehicle_hierarchy_values", "hierarchy_value_years", "hierarchy_value_id"));
  sheet(wb, "Configuration Years", YEAR_COLS,
    yearMatrix("vehicle_configuration_values", "configuration_value_years",
      "configuration_value_id"));

  // 19-21. aliases / review / sources
  sheet(wb, "Aliases", [
    { header: "Raw or Alias Make", key: "raw_or_alias_make", width: 15 },
    { header: "Raw or Alias Model", key: "raw_or_alias_model", width: 28 },
    { header: "Raw or Alias Sub-model", key: "raw_or_alias_submodel", width: 18 },
    { header: "Canonical Make", key: "canonical_make", width: 15 },
    { header: "Canonical Model", key: "canonical_model", width: 24 },
    { header: "Alias Type", key: "alias_type", width: 26 },
    { header: "Confidence", key: "confidence", width: 10 },
    { header: "Notes", key: "notes", width: 55, wrap: true },
  ], all(`SELECT a.*, COALESCE(k.standard_make,'') canonical_make,
      COALESCE(m.standard_model,'') canonical_model
      FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
      LEFT JOIN models m ON m.id=a.canonical_model_id
      ORDER BY a.raw_or_alias_make, a.raw_or_alias_model`));
  sheet(wb, "Review Required", [
    { header: "Candidate Make", key: "candidate_make", width: 15 },
    { header: "Candidate Model", key: "candidate_model", width: 22 },
    { header: "Candidate Sub-model", key: "candidate_submodel", width: 18 },
    { header: "Possible Classification", key: "possible_classification", width: 18 },
    { header: "Priority", key: "priority", width: 26 },
    { header: "Candidate Years", key: "candidate_model_years", width: 15 },
    { header: "Issue Type", key: "issue_type", width: 26 },
    { header: "Reason Not Approved", key: "reason_not_approved", width: 52, wrap: true },
    { header: "Review Status", key: "review_status", width: 13 },
    { header: "Primary Source", key: "primary_source_url", width: 38, url: true },
    { header: "Notes", key: "notes", width: 45, wrap: true },
  ], all("SELECT * FROM validation_reviews ORDER BY priority, candidate_make, candidate_model"));
  sheet(wb, "Sources", [
    { header: "Source Organization", key: "source_organization", width: 14 },
    { header: "Source Dataset", key: "source_dataset", width: 30 },
    { header: "Source Name", key: "source_name", width: 44 },
    { header: "Source URL", key: "source_url", width: 55, url: true },
    { header: "Evidence Type", key: "evidence_type", width: 34 },
    { header: "Access Date", key: "access_date", width: 12 },
    { header: "Known Limitations", key: "known_limitations", width: 55, wrap: true },
  ], all("SELECT * FROM sources ORDER BY source_organization, source_dataset"));

  // 22-24. audits + delta (from the audit CSV outputs)
  const tax = csvRows("Vehicle_Value_Taxonomy_Audit.csv");
  sheet(wb, "Taxonomy Audit",
    Object.keys(tax[0] ?? { none: "" }).map((h) => ({ header: h, key: h,
      width: h.includes("Notes") || h.includes("Evidence") ? 45 : 18,
      wrap: h.includes("Notes") || h.includes("Evidence") })), tax);
  const cov = csvRows("Vehicle_Coverage_1980_1983_Audit.csv");
  sheet(wb, "1980-1983 Audit",
    Object.keys(cov[0] ?? { none: "" }).map((h) => ({ header: h, key: h,
      width: h.includes("Notes") ? 45 : 18, wrap: h.includes("Notes") })), cov);
  const delta = csvRows("Application_Data_V2_to_V3_Delta.csv");
  sheet(wb, "V2 to V3 Changes",
    [{ header: "Change Type", key: "Change Type", width: 30 },
     { header: "Standard Make", key: "Standard Make", width: 16 },
     { header: "Item", key: "Item", width: 40 },
     { header: "Detail", key: "Detail", width: 90, wrap: true }], delta);

  // 25. summary with per-classification counts
  const meta = Object.fromEntries((db.prepare("SELECT key, value FROM catalog_meta").all() as
    { key: string; value: string }[]).map((r) => [r.key, r.value]));
  const summary: [string, string | number][] = [
    ["Catalog version", meta.catalog_version ?? "V3"],
    ["Research cutoff", meta.research_cutoff ?? "2026-07-15"],
    ["Export timestamp", new Date().toISOString()],
    ["Total Makes", n("SELECT COUNT(*) n FROM makes")],
    ["Total Models", n("SELECT COUNT(*) n FROM models")],
    ["Total model-year records", n("SELECT COUNT(*) n FROM model_years")],
    ["Hierarchy-year records", n("SELECT COUNT(*) n FROM hierarchy_value_years")],
    ["Configuration-year records", n("SELECT COUNT(*) n FROM configuration_value_years")],
    ["Unresolved candidates", n("SELECT COUNT(*) n FROM validation_reviews")],
  ];
  for (const [label, sql] of [
    ["Hierarchy", `SELECT classification_type k, COUNT(*) n FROM vehicle_hierarchy_values GROUP BY 1 ORDER BY 2 DESC`],
    ["Configuration", `SELECT classification_type k, COUNT(*) n FROM vehicle_configuration_values GROUP BY 1 ORDER BY 2 DESC`],
    ["Models by validation", "SELECT validation_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"],
    ["Candidates by priority", "SELECT COALESCE(NULLIF(priority,''),'(unprioritized)') k, COUNT(*) n FROM validation_reviews GROUP BY 1 ORDER BY 2 DESC"],
  ] as const) {
    for (const r of all<{ k: string; n: number }>(sql)) summary.push([`${label}: ${r.k}`, r.n]);
  }
  const ws = wb.addWorksheet("Catalog Summary", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ header: "Metric", key: "m", width: 56 }, { header: "Value", key: "v", width: 32 }];
  ws.getRow(1).font = { bold: true };
  for (const [m, v] of summary) ws.addRow([m, v]);
  return wb;
}

export async function writeWorkbookV3(db: Database.Database, outPath?: string): Promise<string> {
  const wb = buildWorkbookV3(db);
  const p = outPath ?? path.join(EXPORT_DIR, WORKBOOK_V3);
  await wb.xlsx.writeFile(p);
  return p;
}
