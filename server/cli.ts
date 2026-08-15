/** CLI entry: db:init | catalog:import | export:excel | db:backup | db:restore | verify */
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb, initSchema, DB_PATH, BACKUP_DIR, EXPORT_DIR, DATA_DIR } from "./db.js";

function APP_ROOT_DATA(): string { return DATA_DIR; }
import { runImport, detectCatalogFiles } from "./importer.js";
import { writeWorkbook } from "./exporter.js";
import { verifyAll } from "./verify.js";

const cmd = process.argv[2];

async function main(): Promise<number> {
  switch (cmd) {
    case "db:init": {
      const db = getDb();
      initSchema(db);
      console.log(`Database initialized at ${DB_PATH}`);
      return 0;
    }
    case "catalog:import-if-present": {
      // Used by setup-windows.bat. A release ZIP ships a fully populated
      // database, so a missing catalog CSV set is normal, not an error.
      const db = getDb();
      initSchema(db);
      const files = detectCatalogFiles();
      const populated = (db.prepare("SELECT COUNT(*) n FROM makes")
        .get() as { n: number }).n > 0;
      if (!files.master || !files.makes) {
        console.log("No catalog CSV files found next to the application.");
        console.log(populated
          ? "The shipped database already contains the canonical catalog - "
            + "nothing to import."
          : "WARNING: the database has no canonical records and no catalog files "
            + "were found. Place the catalog CSVs in catalog-files/ and run "
            + "'npm run catalog:import'.");
        return 0;
      }
      if (populated) {
        console.log("Canonical catalog already present; skipping import. "
          + "Run 'npm run catalog:import' explicitly to re-import.");
        return 0;
      }
      const report = runImport(db);
      console.log(`Imported catalog: ${JSON.stringify(report.totals)}`);
      return report.status === "SUCCESS" ? 0 : 1;
    }
    case "catalog:import": {
      const db = getDb();
      initSchema(db);
      const files = detectCatalogFiles();
      console.log("Detected catalog files:");
      for (const [k, v] of Object.entries(files)) console.log(`  ${k}: ${v ?? "(not found)"}`);
      const report = runImport(db);
      let v2report: unknown = null;
      let v3report: unknown = null;
      const { detectV3Files, runImportV3 } = await import("./importer_v3.js");
      if (detectV3Files().hierarchy) {
        v3report = runImportV3(db);
        console.log("Phase 3 hierarchy/configuration import:", JSON.stringify(
          (v3report as { totals: unknown }).totals));
        const { detectV4Files, runImportV4 } = await import("./importer_v4.js");
        if (detectV4Files().hierarchy) {
          const v4 = runImportV4(db);
          console.log("Phase 4 hierarchy research import:",
            JSON.stringify(v4.totals));
        }
      } else {
        const { detectV2Files, runImportV2 } = await import("./importer_v2.js");
        if (detectV2Files().submodels) {
          v2report = runImportV2(db);
          console.log("Phase 2 hierarchy import:", JSON.stringify(
            (v2report as { totals: unknown }).totals));
        }
      }
      const out = path.join(EXPORT_DIR, "last_import_report.json");
      fs.writeFileSync(out, JSON.stringify({ base: report, v2: v2report,
        v3: v3report }, null, 2));
      console.log(JSON.stringify({ status: report.status, totals: report.totals }, null, 2));
      console.log(`Full import report: ${out}`);
      return report.status === "SUCCESS" ? 0 : 1;
    }
    case "export:excel": {
      const db = getDb();
      const p = await writeWorkbook(db);
      console.log(`Workbook written: ${p}`);
      return 0;
    }
    case "export:excel-v2": {
      const { writeWorkbookV2 } = await import("./exporter_v2.js");
      const db = getDb();
      const p = await writeWorkbookV2(db);
      console.log(`V2 workbook written: ${p}`);
      return 0;
    }
    case "export:excel-v3": {
      const { writeWorkbookV3 } = await import("./exporter_v3.js");
      const db = getDb();
      const p = await writeWorkbookV3(db);
      console.log(`V3 workbook written: ${p}`);
      return 0;
    }
    case "export:lookup": {
      const { buildLookupWorkbook } = await import("./standardize/exports.js");
      const db = getDb();
      const wb = await buildLookupWorkbook(db);
      const p = path.join(EXPORT_DIR, "Canonical Vehicle Lookup.xlsx");
      await wb.xlsx.writeFile(p);
      console.log(`Lookup workbook written: ${p}`);
      return 0;
    }
    case "export:excel-v4": {
      const { writeWorkbookV4 } = await import("./exporter_v4.js");
      const db = getDb();
      const p = await writeWorkbookV4(db);
      console.log(`V4 workbook written: ${p}`);
      return 0;
    }
    case "delta:v2": {
      const { generateAppDelta } = await import("./delta_v2.js");
      console.log(`Delta written: ${generateAppDelta()}`);
      return 0;
    }
    case "verify:v2": {
      const { verifyV2 } = await import("./verify_v2.js");
      const report = await verifyV2();
      const extra = process.argv[3]
        ? JSON.parse(fs.readFileSync(process.argv[3], "utf-8").replace(/^﻿/, ""))
        : {};
      const full = { ...report, ...extra, generated_at: new Date().toISOString() };
      const out = path.join(APP_ROOT_DATA(), "app_verification_report_v2.json");
      fs.writeFileSync(out, JSON.stringify(full, null, 2));
      console.log(JSON.stringify(full, null, 1));
      console.log(`Report: ${out}`);
      return report.status === "PASS" ? 0 : 1;
    }
    case "db:backup": {
      const db = getDb();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = process.argv[3] ?? path.join(BACKUP_DIR, `catalog-${stamp}.db`);
      db.prepare("VACUUM INTO ?").run(dest);
      console.log(`Backup written: ${dest}`);
      return 0;
    }
    case "db:restore": {
      const src = process.argv[3];
      if (!src || !fs.existsSync(src)) {
        console.error("Usage: npm run db:restore -- <backup-file.db>");
        return 1;
      }
      closeDb();
      for (const suffix of ["", "-wal", "-shm"]) {
        const p = DB_PATH + suffix;
        if (fs.existsSync(p)) fs.rmSync(p);
      }
      fs.copyFileSync(src, DB_PATH);
      console.log(`Restored ${src} -> ${DB_PATH}`);
      return 0;
    }
    case "verify": {
      const db = getDb();
      const report = await verifyAll(db);
      console.log(JSON.stringify(report, null, 2));
      return report.status === "PASS" ? 0 : 1;
    }
    default:
      console.error("Unknown command. Use: db:init | catalog:import | export:excel | db:backup | db:restore | verify");
      return 1;
  }
}

main().then((code) => process.exit(code));
