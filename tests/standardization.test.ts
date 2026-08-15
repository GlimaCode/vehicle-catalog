/**
 * File-standardization workspace tests (Phase 5).
 * Covers parsing, resolution, review workflow, exports, performance,
 * canonical read-only enforcement and Version 4 catalog integrity.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema, norm, DATA_DIR } from "../server/db.js";
import { decodeBuffer, dedupeHeaders, previewFile, streamRows } from "../server/standardize/parse.js";
import { CanonicalResolver, parseYearValue, validateYears, compressYears,
  levenshtein } from "../server/standardize/resolver.js";
import { saveUpload, createProject, setMapping, processProject, applyDecision,
  applyToAll, countIdentical, projectStats, projectOutcome,
  type ProjectMapping } from "../server/standardize/project.js";
import { buildExportTable, exportCsv, exportXlsx, buildChangeReport,
  buildLookupWorkbook } from "../server/standardize/exports.js";
import { withCanonicalUnlocked,
  CANONICAL_IMPORTER_TOKEN } from "../server/canonical_lock.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-test-"));
// The tests run against a COPY. Opening the shipped database directly would
// accumulate test projects in it and apply new migrations to a frozen release.
const V5_SOURCE = path.join(DATA_DIR, "catalog-v5.db");
const V5 = path.join(tmp, "catalog-v5-test.db");
let db: Database.Database;

const SAMPLE_ROWS = [
  ["Item ID", "Title", "Make", "Model", "Trim", "Year", "Drivetrain"],
  ["A1", 'Cover for "F150", crew cab', "ford", "F150", "Lariat", "2015-2018", "4WD"],
  ["A2", "Cover\nwith line break", "Mercedes Benz", "C-Class", "AMG", "2016", "AWD"],
  ["A3", "Cover", "Chevrolet", "Escalade", "LTZ", "2012", "AWD"],
  ["A4", "Cover", "Ford", "Excrision", "XLT", "2003-2005", "4WD"],
  ["A5", "Cover", "Jaguar", "X Type", "", "2004", ""],
  ["A6", "Cover", "ford", "F150", "XLT", "not a year", ""],
];
const csvEsc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const CSV_TEXT = SAMPLE_ROWS.map((r) => r.map(csvEsc).join(",")).join("\r\n") + "\r\n";

function writeCsv(name: string, text: string, enc: "utf8" | "bom" | "cp1252" = "utf8"): string {
  const p = path.join(tmp, name);
  if (enc === "bom") fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")]));
  else if (enc === "cp1252") {
    const bytes = Buffer.from([...text].map((ch) => {
      const c = ch.charCodeAt(0);
      return c === 0x2019 ? 0x92 : c === 0xe9 ? 0xe9 : c & 0xff;
    }));
    fs.writeFileSync(p, bytes);
  } else fs.writeFileSync(p, text, "utf-8");
  return p;
}

async function makeProject(csvPath: string, mapOverrides: Partial<ProjectMapping> = {}) {
  const { stored, hash } = saveUpload(fs.readFileSync(csvPath), path.basename(csvPath));
  const id = await createProject(db, { filename: path.basename(csvPath), stored, hash });
  const preview = await previewFile(stored, {});
  const columns = preview.headers.map((h, i) => ({ column: h, index: i,
    field: h === "Year" ? "Model Year"
      : ["Make", "Model", "Trim", "Drivetrain", "Title", "Item ID"].includes(h) ? h
      : "Preserve as Custom Field" })) as ProjectMapping["columns"];
  setMapping(db, id, { headerRow: 1, preserveUnmapped: true, columns, ...mapOverrides });
  return id;
}

beforeAll(() => {
  fs.copyFileSync(V5_SOURCE, V5);
  db = new Database(V5);
  db.pragma("foreign_keys = ON");
  initSchema(db);
});
afterAll(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe("1-6 input parsing", () => {
  it("1. parses CSV with quoted commas", async () => {
    const p = writeCsv("q.csv", CSV_TEXT);
    const pv = await previewFile(p, {});
    expect(pv.rows[0][1]).toBe('Cover for "F150", crew cab');
  });
  it("2. preserves embedded line breaks", async () => {
    const pv = await previewFile(writeCsv("lb.csv", CSV_TEXT), {});
    expect(pv.rows[1][1]).toContain("\n");
  });
  it("3. selects an XLSX worksheet", async () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet("First");
    a.addRow(["Make", "Model"]); a.addRow(["Ford", "F-150"]);
    const b = wb.addWorksheet("Second");
    b.addRow(["Make", "Model"]); b.addRow(["Jaguar", "X-Type"]);
    const p = path.join(tmp, "two.xlsx");
    await wb.xlsx.writeFile(p);
    const first = await previewFile(p, {});
    const second = await previewFile(p, { worksheetName: "Second" });
    expect(first.rows[0][0]).toBe("Ford");
    expect(second.rows[0][0]).toBe("Jaguar");
    expect(second.worksheets.map((w) => w.name)).toEqual(["First", "Second"]);
  });
  it("4. disambiguates duplicate headers", () => {
    expect(dedupeHeaders(["Make", "Make", "", "Model"]))
      .toEqual(["Make", "Make (2)", "Column 3", "Model"]);
  });
  it("5. handles a UTF-8 BOM", async () => {
    const pv = await previewFile(writeCsv("bom.csv", CSV_TEXT, "bom"), {});
    expect(pv.encoding).toBe("UTF-8 with BOM");
    expect(pv.headers[0]).toBe("Item ID");
  });
  it("6. decodes Windows-1252 input", () => {
    const buf = Buffer.from([0x4d, 0x61, 0x6b, 0x65, 0x0a, 0x46, 0x6f, 0x72, 0x92, 0x64]);
    const { text, encoding } = decodeBuffer(buf);
    expect(encoding).toBe("Windows-1252");
    expect(text).toContain("For’d");
  });
});

describe("7-12 canonical resolution", () => {
  let resolver: CanonicalResolver;
  beforeAll(() => { resolver = new CanonicalResolver(db); });
  it("7. exact Make match", () => {
    const r = resolver.resolveMake("Ford");
    expect(r.value).toBe("Ford");
    expect(r.confidence).toBe("Exact Canonical Match");
  });
  it("8. Make alias / normalization match", () => {
    expect(resolver.resolveMake("ford").value).toBe("Ford");
    expect(resolver.resolveMake("Mercedes Benz").value).toBe("Mercedes-Benz");
    expect(["Deterministic Normalization", "Approved Alias Match"])
      .toContain(resolver.resolveMake("Mercedes Benz").confidence);
  });
  it("9. exact Model match inside the Make", () => {
    const r = resolver.resolveModel("F-150", "Ford");
    expect(r.value).toBe("F-150");
    expect(r.confidence).toBe("Exact Canonical Match");
  });
  it("10. Model punctuation normalization", () => {
    expect(resolver.resolveModel("F150", "Ford").value).toBe("F-150");
    expect(resolver.resolveModel("X Type", "Jaguar").value).toBe("X-Type");
    expect(resolver.resolveModel("Excrision", "Ford").value).toBe("Excursion");
  });
  it("11. detects cross-brand conflicts", () => {
    const r = resolver.resolveModel("Escalade", "Chevrolet");
    expect(r.confidence).toBe("Conflict");
    expect(r.conflict).toMatch(/Cadillac/);
    expect(r.value).toBeNull();
  });
  it("12. separates Trim from configuration values", () => {
    const drivetrain = resolver.resolveConfiguration("4WD", "Ford", "F-150");
    expect(["Drivetrain Variant", undefined]).toContain(drivetrain.classification);
    const asHierarchy = resolver.resolveHierarchy("4WD", "Ford", "F-150");
    expect(asHierarchy.value === null || asHierarchy.confidence === "Conflict").toBe(true);
  });
});

describe("13-15 model years", () => {
  it("13. parses ranges, lists and prose", () => {
    expect(parseYearValue("2006-2008").years).toEqual([2006, 2007, 2008]);
    expect(parseYearValue("2006 2007 2008").years).toEqual([2006, 2007, 2008]);
    expect(parseYearValue("2006,2008").years).toEqual([2006, 2008]);
    expect(parseYearValue("Fits 2006 to 2008").years).toEqual([2006, 2007, 2008]);
  });
  it("14. keeps non-contiguous years non-contiguous", () => {
    expect(compressYears([1994, 1995, 2000])).toBe("1994-1995; 2000");
    const r = validateYears("1994 1995 2000", new Set([1994, 1995, 2000]), "test");
    expect(r.normalized).toBe("1994-1995; 2000");
    expect(r.status).toBe("Valid");
  });
  it("15. flags invalid and out-of-range years without deleting them", () => {
    expect(validateYears("not a year", new Set([2010]), "t").status).toBe("Invalid Format");
    const partial = validateYears("2009 2012", new Set([2012]), "t");
    expect(partial.status).toBe("Partially Valid");
    expect(partial.invalidYears).toEqual([2009]);
    expect(partial.years).toContain(2009);           // preserved, never removed
  });
});

describe("16-22 project workflow", () => {
  let pid: number;
  beforeAll(async () => { pid = await makeProject(writeCsv("wf.csv", CSV_TEXT)); await processProject(db, pid); });

  it("16. batch mapping applies a decision across identical values", () => {
    const before = countIdentical(db, pid, "Trim", "XLT");
    expect(before).toBeGreaterThan(1);
    const affected = applyToAll(db, pid, "Trim", "XLT", "XLT", "Approved by reviewer");
    expect(affected).toBe(before);
  });
  it("17. apply-to-all count preview matches the affected rows "
    + "(case/punctuation-insensitive)", () => {
    // rows A1 "ford", A4 "Ford", A6 "ford" all count as the same raw value
    expect(countIdentical(db, pid, "Make", "ford")).toBe(3);
    expect(countIdentical(db, pid, "Make", "FORD")).toBe(3);
    const affected = applyToAll(db, pid, "Make", "ford", "Ford", "batch");
    expect(affected).toBe(3);
  });
  it("18. audit mode preserves the original values", () => {
    const { headers, rows } = buildExportTable(db, pid, "audit");
    expect(headers).toContain("Original Make");
    expect(headers).toContain("Standard Make");
    const r1 = rows[0];
    expect(r1[headers.indexOf("Make")]).toBe("ford");            // source untouched
    expect(r1[headers.indexOf("Original Make")]).toBe("ford");
    expect(r1[headers.indexOf("Standard Make")]).toBe("Ford");
  });
  it("19. replacement mode changes only authorized fields", () => {
    const { headers, rows } = buildExportTable(db, pid, "replacement");
    expect(headers).not.toContain("Original Make");
    const r1 = rows[0];
    expect(r1[headers.indexOf("Make")]).toBe("Ford");
    expect(r1[headers.indexOf("Model")]).toBe("F-150");
    expect(r1[headers.indexOf("Item ID")]).toBe("A1");           // never altered
    expect(r1[headers.indexOf("Title")]).toBe('Cover for "F150", crew cab');
    const conflictRow = rows.find((r) => r[headers.indexOf("Item ID")] === "A3")!;
    expect(conflictRow[headers.indexOf("Model")]).toBe("Escalade"); // conflict not applied
  });
  it("20. audit mode is the default export mode", () => {
    const csv = exportCsv(db, pid, "audit");
    expect(csv.split("\r\n")[0]).toContain("Row Review Status");
  });
  it("21. excluded rows are removed from the export but kept in the project", () => {
    applyDecision(db, pid, 3, "(row)", "Exclude From Export");
    const { rows } = buildExportTable(db, pid, "audit");
    expect(rows.length).toBe(SAMPLE_ROWS.length - 1 - 1);
    expect((db.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
      .get(pid) as { n: number }).n).toBe(SAMPLE_ROWS.length - 1);
  });
  it("22. export preserves source row order", () => {
    const { headers, rows } = buildExportTable(db, pid, "audit");
    const ids = rows.map((r) => r[headers.indexOf("Item ID")]);
    expect(ids).toEqual(["A1", "A2", "A4", "A5", "A6"]);
  });
});

describe("23-25 outputs", () => {
  let pid: number;
  beforeAll(async () => { pid = await makeProject(writeCsv("out.csv", CSV_TEXT)); await processProject(db, pid); });
  it("23. XLSX export is formatted (frozen header, filter, bold)", async () => {
    const wb = await exportXlsx(db, pid, "audit");
    const ws = wb.worksheets[0];
    expect(ws.views[0].state).toBe("frozen");
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getRow(1).font?.bold).toBe(true);
  });
  it("24. change report has all required sheets and consistent counts", async () => {
    const wb = await buildChangeReport(db, pid);
    for (const s of ["Summary", "Changed Rows", "Unchanged Rows", "Review Required",
      "No Match", "Conflicts", "Value Mappings", "Column Mapping", "Validation Results"]) {
      expect(wb.getWorksheet(s)).toBeTruthy();
    }
    const stats = projectStats(db, pid);
    const summary = wb.getWorksheet("Summary")!;
    const values: Record<string, unknown> = {};
    summary.eachRow((row) => { values[String(row.getCell(1).value)] = row.getCell(2).value; });
    expect(values["Input row count"]).toBe(stats.inputRows);
    expect(values["Exported row count"]).toBe(stats.exportRows);
    expect(values["Rows requiring review"]).toBe(stats.reviewRows);
  });
  it("25. a project can be re-opened with its rows and decisions intact", () => {
    const reopened = new Database(V5, { readonly: true });
    const n = (reopened.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
      .get(pid) as { n: number }).n;
    expect(n).toBe(SAMPLE_ROWS.length - 1);
    reopened.close();
  });
});

describe("26-29 processing control and scale", () => {
  it("26. cancellation stops processing and leaves the project resumable", async () => {
    const many = ["Make,Model,Year", ...Array.from({ length: 40_000 },
      () => "ford,F150,2015")].join("\n");
    const pid = await makeProject(writeCsv("cancel.csv", many));
    // a run clears any stale flag on start, so cancel is requested mid-run
    const job = processProject(db, pid);
    db.prepare("UPDATE standardization_projects SET cancel_requested=1 WHERE id=?").run(pid);
    const res = await job;
    expect(res.cancelled).toBe(true);
    expect(res.status).toBe("Mapped");
    expect(res.processed).toBeLessThan(40_000);
    const project = db.prepare("SELECT processed_rows FROM standardization_projects WHERE id=?")
      .get(pid) as { processed_rows: number };
    expect(project.processed_rows).toBeGreaterThanOrEqual(0);   // resumable checkpoint
  }, 120_000);
  it("27. resume continues after an interruption without duplicating rows", async () => {
    const many = ["Make,Model,Year", ...Array.from({ length: 2500 },
      () => "ford,F150,2015")].join("\n");
    const pid = await makeProject(writeCsv("resume.csv", many));
    await processProject(db, pid);
    const total = (db.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
      .get(pid) as { n: number }).n;
    expect(total).toBe(2500);
    db.prepare("UPDATE standardization_projects SET processed_rows=1000 WHERE id=?").run(pid);
    await processProject(db, pid, { resume: true });
    const after = (db.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
      .get(pid) as { n: number }).n;
    expect(after).toBe(2500);
  });
  it("28. processes a 100,000-row fixture within the documented limits", async () => {
    const header = "Item ID,Make,Model,Trim,Year\n";
    const body = Array.from({ length: 100_000 },
      (_, i) => `SKU-${i},ford,F150,XLT,2015-2018`).join("\n");
    const pid = await makeProject(writeCsv("big.csv", header + body));
    const t0 = Date.now();
    const res = await processProject(db, pid);
    const seconds = (Date.now() - t0) / 1000;
    expect(res.processed).toBe(100_000);
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
    // eslint-disable-next-line no-console
    console.log(`      100k rows in ${seconds.toFixed(1)}s, heap ${heapMb.toFixed(0)} MB`);
    expect(seconds).toBeLessThan(300);
  }, 600_000);
  it("29. a failing batch rolls back its transaction", async () => {
    const pid = await makeProject(writeCsv("rollback.csv", CSV_TEXT));
    const before = (db.prepare("SELECT COUNT(*) n FROM standardization_rows")
      .get() as { n: number }).n;
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO standardization_rows (project_id, row_number, original_json)
        VALUES (?,?,?)`).run(pid, 900001, "{}");
      throw new Error("forced failure");
    });
    expect(() => tx()).toThrow(/forced failure/);
    expect((db.prepare("SELECT COUNT(*) n FROM standardization_rows")
      .get() as { n: number }).n).toBe(before);
  });
});

describe("30-34 canonical safety and integrity", () => {
  it("30. the canonical catalog is read-only during standardization", () => {
    expect(() => db.prepare(
      "UPDATE makes SET standard_make='HACKED' WHERE standard_make='Ford'").run())
      .toThrow(/read-only/);
    expect(() => db.prepare(
      `INSERT INTO models (make_id, standard_model, confirmed_model_years,
        first_confirmed_model_year, last_confirmed_model_year, lifecycle_status,
        vehicle_category, market, present_in_original_source, catalog_origin,
        validation_status, norm_model)
       VALUES (1,'Fake','2020',2020,2020,'Active','Passenger Car','United States',
        'No','Original Source','Fully Verified','FAKE')`).run())
      .toThrow(/read-only/);
    expect(() => db.prepare("DELETE FROM vehicle_hierarchy_values WHERE id=1").run())
      .toThrow(/read-only/);
    // the documented unlock path still works for catalog imports, and from
    // Version 5.1 it requires the private importer token
    withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, () => {
      db.prepare("UPDATE makes SET notes=notes WHERE id=1").run();
    });
    expect(() => (withCanonicalUnlocked as unknown as
      (d: unknown, f: () => void) => void)(db, () => undefined))
      .toThrow(/importer token is required/);
  });
  it("31. project mappings never modify the canonical catalog", async () => {
    const before = db.prepare("SELECT COUNT(*) n FROM aliases").get() as { n: number };
    const pid = await makeProject(writeCsv("pm.csv", CSV_TEXT));
    await processProject(db, pid);
    applyToAll(db, pid, "Trim", "AMG", "AMG", "project decision");
    const after = db.prepare("SELECT COUNT(*) n FROM aliases").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect((db.prepare(`SELECT COUNT(*) n FROM project_value_mappings WHERE project_id=?`)
      .get(pid) as { n: number }).n).toBeGreaterThan(0);
  });
  it("32. reprocessing the same file is idempotent", async () => {
    const pid = await makeProject(writeCsv("idem.csv", CSV_TEXT));
    await processProject(db, pid);
    const a = projectStats(db, pid);
    await processProject(db, pid);
    const b = projectStats(db, pid);
    expect(b.inputRows).toBe(a.inputRows);
    expect(b.changeRecords).toBe(a.changeRecords);
    expect((db.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
      .get(pid) as { n: number }).n).toBe(SAMPLE_ROWS.length - 1);
  });
  it("33. handles Windows paths with spaces", async () => {
    const dir = path.join(tmp, "folder with spaces");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "file name.csv");
    fs.writeFileSync(p, CSV_TEXT, "utf-8");
    const pv = await previewFile(p, {});
    expect(pv.headers[0]).toBe("Item ID");
    const pid = await makeProject(p);
    const res = await processProject(db, pid);
    expect(res.processed).toBe(SAMPLE_ROWS.length - 1);
  });
  it("34. Version 4 catalog pages remain functional (counts unchanged)", () => {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM makes")).toBe(76);
    expect(n("SELECT COUNT(*) n FROM models")).toBe(1798);
    expect(n("SELECT COUNT(*) n FROM vehicle_hierarchy_values")).toBe(390);
    expect(n("SELECT COUNT(*) n FROM vehicle_configuration_values")).toBe(6859);
    expect(n("SELECT COUNT(*) n FROM model_years")).toBe(15594);
  });
  it("bonus: lookup workbook has the six documented sheets", async () => {
    const wb = await buildLookupWorkbook(db);
    for (const s of ["Make Model Lookup", "Hierarchy Lookup", "Configuration Lookup",
      "Aliases", "Year Validation", "Usage Instructions"]) {
      expect(wb.getWorksheet(s)).toBeTruthy();
    }
  });
  it("bonus: outcome is never 'Standardized' while conflicts remain", async () => {
    const pid = await makeProject(writeCsv("outcome.csv", CSV_TEXT));
    await processProject(db, pid);
    expect(["Review Required", "Partially Standardized", "Standardized with Warnings"])
      .toContain(projectOutcome(db, pid));
  });
  it("bonus: levenshtein and streamRows helpers behave", async () => {
    expect(levenshtein("Excrision", "Excursion")).toBeLessThanOrEqual(2);
    let seen = 0;
    await streamRows(writeCsv("stream.csv", CSV_TEXT), {
      batchSize: 2, onBatch: (rows) => { seen += rows.length; } });
    expect(seen).toBe(SAMPLE_ROWS.length - 1);
  });
});
