/** End-to-end check of the title pipeline against the sample file. */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema } from "../server/db.ts";
import { createTitleProject, saveTitleUpload, setTitleMapping,
  processTitleProject, titleProjectStats, applyTitleDecision }
  from "../server/title/project.ts";
import { exportTitleCsv, buildTitleReport } from "../server/title/exports.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(APP, "exports", "title-e2e-"));
const DB = path.join(TMP, "e2e.db");
fs.copyFileSync(path.join(APP, "data", "catalog-v6.db"), DB);
const db = new Database(DB);
db.pragma("foreign_keys = ON");
initSchema(db);

const sample = path.join(APP, "samples", "sample_titles.csv");
const saved = saveTitleUpload(fs.readFileSync(sample), "sample_titles.csv");
const projectId = await createTitleProject(db, {
  filename: "sample_titles.csv", stored: saved.stored, hash: saved.hash,
  storageId: saved.storageId });

const HEADERS = ["Item ID", "SKU", "Title", "Year", "Make", "Model", "Trim",
  "Material", "Color", "Variation", "Product Type", "Position", "Side", "Quantity"];
setTitleMapping(db, projectId, { headerRow: 1,
  columns: HEADERS.map((h, i) => ({ column: h, index: i,
    field: h === "Year" ? "Year Range" : h })) });

const result = await processTitleProject(db, projectId);
console.log("processed:", result.processed);
console.log("by status:", JSON.stringify(result.byStatus, null, 1));

const rows = db.prepare(`SELECT row_number, original_length, proposed_length,
  title_status, original_title, proposed_title FROM title_optimization_rows
  WHERE project_id=? ORDER BY row_number`).all(projectId);
for (const r of rows) {
  console.log(`\n${r.row_number}. ${r.title_status}  ${r.original_length} -> ${r.proposed_length}`);
  console.log(`   ${r.proposed_title}`);
}

console.log("\nstats:", JSON.stringify(titleProjectStats(db, projectId)));

// audit export must keep the original title intact
const audit = exportTitleCsv(db, projectId, "audit");
const auditHeader = audit.csv.split("\r\n")[0];
console.log("\naudit header:", auditHeader);
console.log("audit has Original Title column:", auditHeader.includes("Original Title"));

// replacement export must change only the Title column
const repl = exportTitleCsv(db, projectId, "replacement");
const rLines = repl.csv.split("\r\n").filter(Boolean);
const parse = (line) => line.match(/("(?:[^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0)
  .map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'));
const origLines = fs.readFileSync(sample, "utf-8").split("\r\n").filter(Boolean);
let diffs = 0;
for (let i = 1; i < rLines.length; i++) {
  const a = parse(origLines[i]);
  const b = parse(rLines[i]);
  for (let c = 0; c < a.length; c++) {
    if (c === 2) continue;                      // Title column may change
    if (a[c] !== b[c]) { diffs++; console.log(`  col ${c} row ${i}: ${a[c]} -> ${b[c]}`); }
  }
}
console.log("non-Title columns changed in replacement mode:", diffs);

const wb = await buildTitleReport(db, projectId);
console.log("report sheets:", wb.worksheets.length,
  wb.worksheets.map((w) => w.name).join(", "));

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
try { fs.rmSync(saved.stored, { force: true }); } catch { /* ignore */ }
