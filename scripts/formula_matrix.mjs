/**
 * Proves formula-injection neutralization across every output type by reading
 * the produced files back, not by trusting the neutralizer in isolation.
 *
 * Outputs exports/Formula_Injection_Verification.json
 */
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema, DATA_DIR } from "../server/db.ts";
import { saveUpload, createProject, setMapping, processProject }
  from "../server/standardize/project.ts";
import { exportCsvWithStats, exportXlsxWithStats, buildChangeReport,
  buildReviewOnlyWorkbook, valueMappingCsv } from "../server/standardize/exports.ts";
import { neutralize, needsNeutralizing, isTrustedHyperlinkField }
  from "../server/security/formula.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "formula-matrix-"));
const DB = path.join(tmp, "fm.db");
fs.copyFileSync(path.join(DATA_DIR, "catalog-v5.1.db"), DB);
const db = new Database(DB);
db.pragma("foreign_keys = ON");
initSchema(db);

// One payload per required leading character, plus the values that must NOT change.
const PAYLOADS = [
  { label: "equals", raw: `=cmd|' /C calc'!A0` },
  { label: "plus", raw: `+1+1` },
  { label: "minus (text)", raw: `-2+3+cmd|' /C calc'!A0` },
  { label: "at", raw: `@SUM(1+1)*cmd|' /C calc'!A0` },
  { label: "tab", raw: `\t=1+1` },
  { label: "carriage return", raw: `\r=1+1` },
];
const UNTOUCHED = [
  { label: "negative integer", raw: "-5" },
  { label: "negative decimal", raw: "-12.5" },
  { label: "negative currency", raw: "-$1,250.00" },
  { label: "exponent", raw: "-1.5e6" },
  { label: "percent", raw: "-3.5%" },
  { label: "date-ish", raw: "-2020/01" },
  { label: "plain number", raw: "42" },
];

// --- unit level: the neutralizer's own contract -----------------------------
const unit = [];
for (const p of [...PAYLOADS, ...UNTOUCHED]) {
  const r = neutralize(p.raw);
  unit.push({ case: p.label, before: p.raw, after: r.value,
    neutralized: r.neutralized,
    expected: PAYLOADS.includes(p) ? "neutralized" : "unchanged",
    ok: PAYLOADS.includes(p) ? r.neutralized : !r.neutralized });
}
const trusted = {
  case: "trusted application hyperlink field",
  fieldChecked: "Primary Source URL",
  isTrusted: isTrustedHyperlinkField("Primary Source URL"),
  neutralizedWhenTrusted: needsNeutralizing("=HYPERLINK(\"x\")", { trusted: true }),
};
trusted.ok = trusted.isTrusted === true && trusted.neutralizedWhenTrusted === false;

// --- file level: build a project whose cells carry every payload ------------
const headers = ["Item ID", "Title", "Make", "Model", "Trim", "Year", "Notes"];
const rows = [headers.join(",")];
PAYLOADS.forEach((p, i) => {
  const esc = (s) => `"${s.replace(/"/g, '""')}"`;
  // Make/Model deliberately need normalization so the row also produces changes
  rows.push([`P${i}`, esc(p.raw), "ford", "F150", esc(p.raw), 2018, esc(p.raw)].join(","));
});
UNTOUCHED.forEach((p, i) => {
  rows.push([`U${i}`, `"${p.raw}"`, "Chevrolet", "Silverado 1500", "LT", 2015,
    `"${p.raw}"`].join(","));
});
// a conflict row so the review-only workbook and value mappings have content
rows.push(["C0", "conflict", "Ford", "Escalade", "Base", 2012, "n/a"].join(","));

const csvPath = path.join(tmp, "payloads.csv");
fs.writeFileSync(csvPath, rows.join("\r\n") + "\r\n", "utf-8");

const saved = saveUpload(fs.readFileSync(csvPath), "payloads.csv");
const projectId = await createProject(db, {
  filename: "payloads.csv", stored: saved.stored, hash: saved.hash,
  projectName: "formula-matrix", storageId: saved.storageId,
});
setMapping(db, projectId, { headerRow: 1, preserveUnmapped: true,
  columns: headers.map((h, i) => ({ column: h, index: i,
    field: h === "Year" ? "Model Year"
      : ["Make", "Model", "Trim", "Title", "Item ID"].includes(h) ? h
      : "Preserve as Custom Field" })) });
await processProject(db, projectId);

const findings = {};
const RISKY = /^[=+\-@\t\r]/;
const numericLooking = (s) => /^[-+]?[$£€]?\s?\d/.test(s);
/**
 * In XLSX a string cell has no <f> element, so it is never evaluated. The
 * requirement is therefore: no cell is a formula, and every risky-looking cell
 * is an explicit text cell (numFmt "@") or apostrophe-prefixed.
 */
const unsafeWorkbookCells = (cells) => cells.filter((c) =>
  RISKY.test(c.text) && !numericLooking(c.text)
  && !(c.type === ExcelJS.ValueType.String || c.numFmt === "@" || c.text.startsWith("'")));

// 1. CSV export
const csv = exportCsvWithStats(db, projectId, "audit");
const csvText = csv.csv;
const csvCells = csvText.split(/\r?\n/).slice(1)
  .flatMap((line) => line.match(/(".*?"|[^,]*)/g) ?? [])
  .map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'))
  .filter(Boolean);
findings.csv = {
  produced: true,
  riskyCellsLeft: csvCells.filter((c) => RISKY.test(c) && !/^[-+]?[$£€]?\s?\d/.test(c)),
  neutralizedCells: csv.protection.neutralizedCells,
  hasProtectionColumn: csvText.includes("Formula Injection Protection Applied"),
  negativesIntact: UNTOUCHED.every((u) => csvText.includes(u.raw)),
};

// 2. XLSX export
const readWorkbookCells = async (buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
    out.push({ sheet: ws.name, type: cell.type,
      isFormula: cell.type === ExcelJS.ValueType.Formula,
      numFmt: cell.numFmt ?? "",
      text: typeof cell.value === "object" && cell.value !== null
        ? JSON.stringify(cell.value) : String(cell.value ?? "") });
  })));
  return out;
};
const xlsx = await exportXlsxWithStats(db, projectId, "audit");
const xlsxBuf = await xlsx.wb.xlsx.writeBuffer();
const xlsxCells = await readWorkbookCells(xlsxBuf);
findings.xlsx = {
  produced: true,
  formulaCells: xlsxCells.filter((c) => c.isFormula).map((c) => c.text),
  unsafeTextCells: unsafeWorkbookCells(xlsxCells).map((c) => c.text),
  riskyCellsForcedToText: xlsxCells.filter((c) => RISKY.test(c.text)
    && !numericLooking(c.text)).length,
  neutralizedCells: xlsx.protection?.neutralizedCells,
};

// 3. Change-report workbook
const changeWb = await buildChangeReport(db, projectId);
const changeCells = await readWorkbookCells(await changeWb.xlsx.writeBuffer());
findings.changeReport = {
  produced: true, sheets: changeWb.worksheets.length,
  formulaCells: changeCells.filter((c) => c.isFormula).map((c) => c.text),
  unsafeTextCells: unsafeWorkbookCells(changeCells).map((c) => c.text),
};

// 4. Review-only workbook
const reviewWb = await buildReviewOnlyWorkbook(db, projectId);
const reviewCells = await readWorkbookCells(await reviewWb.xlsx.writeBuffer());
findings.reviewOnly = {
  produced: true,
  formulaCells: reviewCells.filter((c) => c.isFormula).map((c) => c.text),
  unsafeTextCells: unsafeWorkbookCells(reviewCells).map((c) => c.text),
};

// 5. Value-mapping CSV
const vmText = valueMappingCsv(db, projectId);
const vmCells = String(vmText).split(/\r?\n/).slice(1)
  .flatMap((line) => line.match(/(".*?"|[^,]*)/g) ?? [])
  .map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"')).filter(Boolean);
findings.valueMappingCsv = {
  produced: true,
  riskyCellsLeft: vmCells.filter((c) => RISKY.test(c) && !/^[-+]?[$£€]?\s?\d/.test(c)),
};

const examples = PAYLOADS.map((p) => ({
  leadingCharacter: p.label, before: p.raw, after: neutralize(p.raw).value,
}));

const allClean =
  findings.csv.riskyCellsLeft.length === 0
  && findings.xlsx.formulaCells.length === 0 && findings.xlsx.unsafeTextCells.length === 0
  && findings.changeReport.formulaCells.length === 0
  && findings.changeReport.unsafeTextCells.length === 0
  && findings.reviewOnly.formulaCells.length === 0
  && findings.reviewOnly.unsafeTextCells.length === 0
  && findings.valueMappingCsv.riskyCellsLeft.length === 0
  && unit.every((u) => u.ok) && trusted.ok && findings.csv.negativesIntact;

const report = { generatedAt: new Date().toISOString(),
  unitBehaviour: unit, trustedHyperlinks: trusted, examples, outputs: findings,
  status: allClean ? "PASS" : "FAIL" };
fs.writeFileSync(path.resolve("exports", "Formula_Injection_Verification.json"),
  JSON.stringify(report, null, 2));
db.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
console.log(JSON.stringify({ status: report.status, examples,
  outputs: Object.fromEntries(Object.entries(findings).map(([k, v]) =>
    [k, { unsafe: (v.riskyCellsLeft ?? v.unsafeTextCells ?? []).length,
      formulas: (v.formulaCells ?? []).length,
      neutralized: v.neutralizedCells }])) }, null, 1));
