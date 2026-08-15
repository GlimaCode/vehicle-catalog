/** Version 4 workbook: V3 structure + Trim Research Audit, Official Source
 *  Index, V3-to-V4 Changes, and per-outcome summary additions. */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type Database from "better-sqlite3";
import { EXPORT_DIR, CATALOG_DIR } from "./db.js";
import { buildWorkbookV3 } from "./exporter_v3.js";

export const WORKBOOK_V4 = "Complete_US_Vehicle_Catalog_1980_to_2026-07-15_v4.xlsx";
type Row = Record<string, unknown>;

function csvRows(file: string): Row[] {
  const p = path.join(CATALOG_DIR, file);
  if (!fs.existsSync(p)) return [];
  return parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, ""),
    { columns: true, skip_empty_lines: true, bom: true }) as Row[];
}

function addCsvSheet(wb: ExcelJS.Workbook, name: string, rows: Row[], wide: string[] = []) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  const heads = Object.keys(rows[0] ?? { "(empty)": "" });
  ws.columns = heads.map((h) => ({ header: h, key: h,
    width: wide.some((w) => h.includes(w)) ? 50 : 18 }));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: heads.length } };
  for (const r of rows) {
    const row = ws.addRow(heads.map((h) => r[h] ?? ""));
    heads.forEach((h, i) => {
      if (wide.some((w) => h.includes(w))) {
        row.getCell(i + 1).alignment = { wrapText: true, vertical: "top" };
      }
      const v = r[h];
      if (typeof v === "string" && v.startsWith("http")) {
        row.getCell(i + 1).value = { text: v, hyperlink: v };
      }
    });
  }
}

export function buildWorkbookV4(db: Database.Database): ExcelJS.Workbook {
  const wb = buildWorkbookV3(db);
  addCsvSheet(wb, "Trim Research Audit",
    csvRows("High_Priority_Trim_Research_Audit.csv"),
    ["Notes", "Evidence", "Action", "Document"]);
  addCsvSheet(wb, "Official Source Index",
    csvRows("Official_Hierarchy_Source_Index.csv"), ["Title", "Notes"]);
  addCsvSheet(wb, "V3 to V4 Changes",
    csvRows("Application_Data_V3_to_V4_Delta.csv"), ["Detail"]);

  // summary additions: outcomes of the 286-candidate research
  const audit = csvRows("High_Priority_Trim_Research_Audit.csv");
  const counts: Record<string, number> = {};
  for (const r of audit) {
    const k = String(r["Research Outcome"]);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const ws = wb.getWorksheet("Catalog Summary")!;
  ws.addRow(["--- V4 high-priority candidate research (286 candidates) ---", ""]);
  const approved = Object.entries(counts)
    .filter(([k]) => k.startsWith("Approved")).reduce((a, [, n]) => a + n, 0);
  const reclassCfg = Object.entries(counts)
    .filter(([k]) => /Engine|Drivetrain|Body/.test(k)).reduce((a, [, n]) => a + n, 0);
  ws.addRow(["Candidates approved (hierarchy + configuration)", approved]);
  ws.addRow(["Candidates reclassified as configuration", reclassCfg]);
  for (const [k, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    ws.addRow([`Outcome: ${k}`, n]);
  }
  return wb;
}

export async function writeWorkbookV4(db: Database.Database, outPath?: string): Promise<string> {
  const wb = buildWorkbookV4(db);
  const p = outPath ?? path.join(EXPORT_DIR, WORKBOOK_V4);
  await wb.xlsx.writeFile(p);
  return p;
}
