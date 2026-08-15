/** End-to-end smoke test of the standardization pipeline (no HTTP). */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { initSchema } from "../server/db.ts";

const dbPath = process.env.CATALOG_DB ?? "data/catalog-v5.db";
const db = new Database(dbPath);
initSchema(db);

const { saveUpload, createProject, setMapping, processProject, projectStats,
  projectOutcome } = await import("../server/standardize/project.ts");
const { previewFile } = await import("../server/standardize/parse.ts");
const { exportCsv } = await import("../server/standardize/exports.ts");

const file = path.join("samples", "sample_vehicle_listings.csv");
const { stored, hash } = saveUpload(fs.readFileSync(file), "sample_vehicle_listings.csv");
const preview = await previewFile(stored, {});
console.log("preview:", preview.format, preview.encoding, preview.headers.join(" | "),
  "rows:", preview.rowCount);

const id = await createProject(db, { filename: "sample_vehicle_listings.csv", stored, hash,
  projectName: "Smoke test" });
setMapping(db, id, { headerRow: 1, preserveUnmapped: true,
  columns: preview.headers.map((h, i) => ({ column: h, index: i,
    field: h === "Year" ? "Model Year"
      : ["Make", "Model", "Trim", "Drivetrain", "Title", "Item ID"].includes(h) ? h
      : "Preserve as Custom Field" })) });
const result = await processProject(db, id);
console.log("processed:", result);
console.log("stats:", JSON.stringify(projectStats(db, id), null, 1));
console.log("outcome:", projectOutcome(db, id));

for (const r of db.prepare(`SELECT row_number, normalized_json FROM standardization_rows
  WHERE project_id=? ORDER BY row_number`).all(id)) {
  const nr = JSON.parse(r.normalized_json);
  const f = (k) => nr.fields[k] ? `${nr.fields[k].raw} -> ${nr.fields[k].value ?? "?"} [${nr.fields[k].confidence}]` : "-";
  console.log(`row ${r.row_number}: MAKE ${f("Make")} | MODEL ${f("Model")} | TRIM ${f("Trim")} | YEAR ${nr.year?.status ?? "-"} ${nr.year?.normalized ?? ""}`);
  if (nr.reviewReasons.length) console.log(`   review: ${nr.reviewReasons.join(" ; ")}`);
}
console.log("\n--- audit csv (first 3 lines) ---");
console.log(exportCsv(db, id, "audit").split("\r\n").slice(0, 3).join("\n"));
db.close();
