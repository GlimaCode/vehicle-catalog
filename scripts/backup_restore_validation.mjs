/**
 * Backup and restore round-trip validation.
 *
 * Builds a realistic project (CSV + XLSX metadata, mapping, exact/alias
 * matches, a conflict, review decisions, batch mappings and generated
 * exports), backs the database up, hashes it, destroys the working database,
 * restores it, then verifies every decision and regenerates the exports and
 * compares them byte-for-byte with the pre-backup output.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { initSchema } from "../server/db.ts";
import { saveUpload, createProject, setMapping, processProject, applyDecision,
  applyToAll, projectStats, projectOutcome } from "../server/standardize/project.ts";
import { previewFile } from "../server/standardize/parse.ts";
import { exportCsvWithStats, writeChangeReportToFile } from "../server/standardize/exports.ts";
import { withLock } from "../server/security/locks.ts";

const WORK = path.resolve("bench", "backup-restore");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const DB_PATH = path.join(WORK, "working.db");
const BACKUP_PATH = path.join(WORK, "backup.db");
fs.copyFileSync("data/catalog-v5.1.db", DB_PATH);

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const checks = [];
const check = (name, ok, detail = "") =>
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });

let db = new Database(DB_PATH);
initSchema(db);

// ---------------------------------------------------------------- realistic project
const CSV = [
  "Item ID,Title,Make,Model,Trim,Year",
  'A1,"Cover, deluxe",ford,F150,XLT,2018',
  "A2,Cover,Mercedes Benz,C-Class,AMG,2016",
  "A3,Cover,Chevrolet,Escalade,Platinum,2012",
  "A4,Cover,Ford,Excrision,XLT,2004",
  "A5,Cover,ford,F150,XLT,2019",
].join("\r\n") + "\r\n";
const csvFile = path.join(WORK, "realistic.csv");
fs.writeFileSync(csvFile, CSV, "utf-8");

const up = saveUpload(fs.readFileSync(csvFile), "realistic.csv");
const projectId = await createProject(db, { filename: "realistic.csv", stored: up.stored,
  hash: up.hash, storageId: up.storageId, projectName: "Backup/restore validation" });
const preview = await previewFile(up.stored, {});
setMapping(db, projectId, { headerRow: 1, preserveUnmapped: true,
  columns: preview.headers.map((h, i) => ({ column: h, index: i,
    field: h === "Year" ? "Model Year"
      : ["Make", "Model", "Trim", "Title", "Item ID"].includes(h) ? h
      : "Preserve as Custom Field" })) });
await processProject(db, projectId);

// review decisions + batch mapping
applyDecision(db, projectId, 3, "Model", "Keep Original", undefined,
  "Cross-brand conflict kept for manual follow-up");
const affected = applyToAll(db, projectId, "Trim", "XLT", "XLT",
  "Approved by reviewer during validation");
const beforeStats = projectStats(db, projectId);
const beforeOutcome = projectOutcome(db, projectId);
const beforeCsv = exportCsvWithStats(db, projectId, "audit").csv;
const beforeReport = path.join(WORK, "before_changes.xlsx");
await writeChangeReportToFile(db, projectId, beforeReport);
const beforeDecisions = db.prepare(`SELECT row_number, field_name, original_value,
  new_value, change_source, user_decision FROM standardization_changes
  WHERE project_id=? ORDER BY id`).all(projectId);
check("Realistic project built (matches, conflict, decisions, batch mapping)",
  beforeStats.inputRows === 5 && affected >= 2 && beforeDecisions.length > 0,
  `rows=${beforeStats.inputRows} batchAffected=${affected} changes=${beforeDecisions.length}`);

// ---------------------------------------------------------------- backup
db.pragma("wal_checkpoint(TRUNCATE)");
db.prepare("VACUUM INTO ?").run(BACKUP_PATH);
const backupHash = sha(BACKUP_PATH);
check("Backup created and hashed", fs.existsSync(BACKUP_PATH) && backupHash.length === 64,
  backupHash.slice(0, 16));

// restore must refuse while a job is active
let refused = false;
await withLock("process", projectId, "Processing project (simulated)", async () => {
  try {
    await withLock("global", undefined, "Restore database", async () => { /* unreachable */ });
  } catch (e) {
    refused = /Cannot start "Restore database"/.test(String(e));
  }
});
check("Restore refuses to run while a job is active", refused);

// ---------------------------------------------------------------- destroy + restore
db.close();
fs.rmSync(DB_PATH);
for (const s of ["-wal", "-shm"]) {
  if (fs.existsSync(DB_PATH + s)) fs.rmSync(DB_PATH + s);
}
check("Working database removed", !fs.existsSync(DB_PATH));
fs.copyFileSync(BACKUP_PATH, DB_PATH);
db = new Database(DB_PATH);
initSchema(db);

// ---------------------------------------------------------------- verify
const afterStats = projectStats(db, projectId);
const afterOutcome = projectOutcome(db, projectId);
const afterDecisions = db.prepare(`SELECT row_number, field_name, original_value,
  new_value, change_source, user_decision FROM standardization_changes
  WHERE project_id=? ORDER BY id`).all(projectId);
const afterMappings = db.prepare("SELECT * FROM project_value_mappings WHERE project_id=?")
  .all(projectId);
check("Project reopens after restore",
  !!db.prepare("SELECT id FROM standardization_projects WHERE id=?").get(projectId));
check("Row and review counts match",
  JSON.stringify(beforeStats) === JSON.stringify(afterStats),
  `${JSON.stringify(beforeStats)} vs ${JSON.stringify(afterStats)}`);
check("Outcome matches", beforeOutcome === afterOutcome,
  `${beforeOutcome} vs ${afterOutcome}`);
check("Review decisions and batch mappings preserved",
  JSON.stringify(beforeDecisions) === JSON.stringify(afterDecisions)
  && afterMappings.length > 0,
  `changes ${beforeDecisions.length} -> ${afterDecisions.length}, mappings ${afterMappings.length}`);

const afterCsv = exportCsvWithStats(db, projectId, "audit").csv;
check("Regenerated CSV export is byte-identical", beforeCsv === afterCsv,
  `${beforeCsv.length} vs ${afterCsv.length} bytes`);
const afterReport = path.join(WORK, "after_changes.xlsx");
await writeChangeReportToFile(db, projectId, afterReport);
// XLSX embeds a creation timestamp, so compare the data instead of the bytes
const ExcelJS = (await import("exceljs")).default;
const readSheet = async (p) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.getWorksheet("Changed Rows");
  const out = [];
  ws.eachRow((row) => out.push(JSON.stringify(row.values)));
  return out.join("\n");
};
check("Regenerated change report matches", await readSheet(beforeReport) === await readSheet(afterReport));

const canonical = ["makes", "models", "vehicle_hierarchy_values",
  "vehicle_configuration_values", "model_years", "aliases"];
const counts = Object.fromEntries(canonical.map((t) =>
  [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
check("Canonical catalog intact after restore",
  counts.makes === 76 && counts.models === 1798 && counts.vehicle_hierarchy_values === 390
  && counts.vehicle_configuration_values === 6859 && counts.model_years === 15594,
  JSON.stringify(counts));
check("Restored database passes integrity check",
  db.pragma("integrity_check", { simple: true }) === "ok");

db.close();
const report = {
  generatedAt: new Date().toISOString(),
  workingDirectory: WORK,
  backup: { path: BACKUP_PATH, sha256: backupHash,
    sizeMB: Number((fs.statSync(BACKUP_PATH).size / 1024 / 1024).toFixed(1)) },
  projectId,
  beforeStats, afterStats, beforeOutcome, afterOutcome,
  canonicalCounts: counts,
  checks,
  status: checks.every((c) => c.ok) ? "PASS" : "FAIL",
};
fs.writeFileSync(path.resolve("exports", "Backup_Restore_Validation_Report.json"),
  JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status,
  failed: checks.filter((c) => !c.ok) }, null, 1));
console.log("Report: exports/Backup_Restore_Validation_Report.json");
