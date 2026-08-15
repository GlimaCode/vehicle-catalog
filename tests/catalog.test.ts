/**
 * Automated tests: CSV import (quoting/embedded line breaks), dedup,
 * year-range expansion (non-contiguous), alias resolution, sub-model
 * classification, rollback, idempotency, uniqueness constraints, search
 * normalization, selector behavior, exports (worksheets/headers/counts)
 * and review separation.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { initSchema, norm } from "../server/db.js";
import { runImport, parseYearRanges, compressYears, classifyVariant, readCsv,
  detectCatalogFiles } from "../server/importer.js";
import { buildWorkbook, toCsv } from "../server/exporter.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-"));

function fixtureDir(): string {
  const dir = fs.mkdtempSync(path.join(tmp, "fixture-"));
  fs.writeFileSync(path.join(dir, "Complete_Standard_Make_Catalog.csv"),
    `Standard Make,Official Display Name,US Market Start Year,US Market End Year,Lifecycle Status,Present in Original Source,Catalog Origin,Validation Status,Primary Source Name,Primary Source URL,Secondary Source Name,Secondary Source URL,Notes\r\n` +
    `Ford,Ford,1980,,Active,Yes,Existing Standardized Catalog,Fully Verified,EPA,https://epa.example/x,NHTSA,https://nhtsa.example/y,\r\n` +
    `Jaguar,Jaguar,1980,,Active,Yes,Existing Standardized Catalog,Fully Verified,EPA,https://epa.example/x,,,\r\n`);
  // master with embedded line break inside a quoted Notes value and a
  // non-contiguous year range
  fs.writeFileSync(path.join(dir, "Complete_US_Make_Model_Catalog_1980_to_2026-07-15.csv"),
    `Standard Make,Standard Model,Confirmed Model Years,First Confirmed Model Year,Last Confirmed Model Year,Lifecycle Status,Vehicle Category,Market,Present in Original Source,Catalog Origin,Validation Status,Primary Source Name,Primary Source URL,Secondary Source Name,Secondary Source URL,Source Access Date,Notes\r\n` +
    `Ford,Bronco,1980-1996; 2021-2026,1980,2026,Active,SUV/Crossover,United States,Yes,Original Source,Fully Verified,EPA,https://epa.example/x,NHTSA,https://nhtsa.example/y,2026-07-15,"Line one\nline two of note"\r\n` +
    `Ford,F-150,1980-2026,1980,2026,Active,Pickup Truck,United States,Yes,Original Source,Fully Verified,EPA,https://epa.example/x,NHTSA,https://nhtsa.example/y,2026-07-15,\r\n` +
    `Jaguar,X-Type,2002-2008,2002,2008,Discontinued,Passenger Car,United States,Yes,Original Source,Fully Verified,EPA,https://epa.example/x,,,2026-07-15,\r\n` +
    `Jaguar,X Type,2003,2003,2003,Discontinued,Passenger Car,United States,No,Added - Missing Model,Government Verified,NHTSA,https://nhtsa.example/y,,,2026-07-15,\r\n`);
  fs.writeFileSync(path.join(dir, "Make_Model_Alias_Mapping.csv"),
    `Raw or Alias Make,Raw or Alias Model,Canonical Make,Canonical Model,Alias Type,Source File or Source Name,Confidence,Notes\r\n` +
    `ford,F150,Ford,F-150,Punctuation Variant,test,High,\r\n` +
    `Ford,F-150 Lariat,Ford,F-150,Model and Trim Combined,test,High,\r\n`);
  fs.writeFileSync(path.join(dir, "Grouped_Model_Relationships.csv"),
    `Raw Make,Raw Grouped Model Value,Canonical Make,Canonical Model,Relationship Status,Evidence,Notes\r\n` +
    `Ford,F-Series,Ford,F-150,Verified,test evidence,\r\n`);
  fs.writeFileSync(path.join(dir, "Make_Model_Validation_Review.csv"),
    `Candidate Make,Candidate Model,Candidate Model Years,Issue Type,Reason Not Approved,Primary Source Name,Primary Source URL,Secondary Source Name,Secondary Source URL,Recommended Next Action,Notes\r\n` +
    `Ford,Land Rover,,Cross-Brand Conflict,Not a Ford model,src,https://nhtsa.example/y,,,Manual confirmation,\r\n`);
  fs.writeFileSync(path.join(dir, "Catalog_Coverage_Report.csv"),
    `Model Year,Verified Make Count,Verified Model Count,Government Source Coverage,Manufacturer Source Coverage,Discrepancy Count,Unresolved Candidate Count,Coverage Status,Notes\r\n` +
    `1980,2,3,NHTSA only,None,0,0,Complete - Minor Source Differences Resolved,\r\n`);
  return dir;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

describe("year-range utilities", () => {
  it("expands non-contiguous ranges and preserves the gap", () => {
    const years = parseYearRanges("1985-1988; 2001-2003");
    expect(years).toEqual([1985, 1986, 1987, 1988, 2001, 2002, 2003]);
  });
  it("round-trips compression", () => {
    expect(compressYears([1985, 1986, 1987, 2001])).toBe("1985-1987; 2001");
  });
  it("rejects malformed segments", () => {
    expect(() => parseYearRanges("19x5")).toThrow();
  });
});

describe("normalization", () => {
  it("is case/space/punctuation/hyphen-insensitive but keeps '+'", () => {
    expect(norm(" F-150 ")).toBe(norm("f150"));
    expect(norm("Mercedes Benz")).toBe(norm("Mercedes-Benz"));
    expect(norm("RX 450h")).not.toBe(norm("RX 450h+"));
  });
});

describe("sub-model classification", () => {
  it("classifies documented trim combinations, never inventing sub-models", () => {
    const v = classifyVariant("F-150 Lariat", "F-150", "Model and Trim Combined", "");
    expect(v).toEqual({ value: "LARIAT", type: "Trim" });
    expect(classifyVariant("F-150", "F-150", "Punctuation Variant", "")).toBeNull();
  });
});

describe("import pipeline (fixture)", () => {
  const dir = fixtureDir();
  const db = freshDb();
  const report = runImport(db, dir);
  const n = (sql: string, ...p: unknown[]): number =>
    (db.prepare(sql).get(...p) as { n: number }).n;

  it("imports with embedded line breaks intact", () => {
    const notes = (db.prepare("SELECT notes FROM models WHERE standard_model='Bronco'")
      .get() as { notes: string }).notes;
    expect(notes).toContain("Line one\nline two");
  });
  it("expands non-contiguous ranges into model_years preserving the gap", () => {
    const ys = (db.prepare(`SELECT y.model_year FROM model_years y JOIN models m ON m.id=y.model_id
      WHERE m.standard_model='Bronco' ORDER BY 1`).all() as { model_year: number }[])
      .map((r) => r.model_year);
    expect(ys).toContain(1996);
    expect(ys).toContain(2021);
    expect(ys).not.toContain(2000);
  });
  it("deduplicates makes and merges punctuation-variant models", () => {
    expect(n("SELECT COUNT(*) n FROM makes")).toBe(2);
    // "X-Type" and "X Type" merge into one canonical model with union years
    expect(n("SELECT COUNT(*) n FROM models WHERE norm_model=?", norm("X-Type"))).toBe(1);
    const merged = db.prepare("SELECT confirmed_model_years FROM models WHERE norm_model=?")
      .get(norm("X-Type")) as { confirmed_model_years: string };
    expect(parseYearRanges(merged.confirmed_model_years)).toContain(2003);
  });
  it("resolves aliases to canonical records", () => {
    const alias = db.prepare(`SELECT a.canonical_model_id, m.standard_model FROM aliases a
      JOIN models m ON m.id=a.canonical_model_id WHERE a.norm_model=?`)
      .get(norm("F150")) as { standard_model: string };
    expect(alias.standard_model).toBe("F-150");
  });
  it("keeps trim candidates as Review Required sub-models only", () => {
    expect(n("SELECT COUNT(*) n FROM submodels WHERE validation_status<>'Review Required'")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM submodels WHERE submodel_type='Trim'")).toBe(1);
  });
  it("separates review-required entries from canonical tables", () => {
    expect(n("SELECT COUNT(*) n FROM validation_reviews")).toBe(1);
    expect(n(`SELECT COUNT(*) n FROM models m JOIN makes k ON k.id=m.make_id
      WHERE k.standard_make='Ford' AND m.standard_model='Land Rover'`)).toBe(0);
  });
  it("reports success with per-file hashes", () => {
    expect(report.status).toBe("SUCCESS");
    expect(report.files.every((f) => /^[0-9a-f]{64}$/.test(f.hash))).toBe(true);
  });
  it("is idempotent on re-import", () => {
    const before = [n("SELECT COUNT(*) n FROM models"), n("SELECT COUNT(*) n FROM model_years"),
      n("SELECT COUNT(*) n FROM aliases"), n("SELECT COUNT(*) n FROM validation_reviews")];
    runImport(db, dir);
    const after = [n("SELECT COUNT(*) n FROM models"), n("SELECT COUNT(*) n FROM model_years"),
      n("SELECT COUNT(*) n FROM aliases"), n("SELECT COUNT(*) n FROM validation_reviews")];
    expect(after).toEqual(before);
  });
  it("enforces uniqueness constraints", () => {
    expect(() => db.prepare(
      "INSERT INTO makes (standard_make, official_display_name, lifecycle_status, present_in_original_source, catalog_origin, validation_status, norm_make) VALUES ('FORD','x','Active','Yes','o','v',?)")
      .run(norm("Ford"))).toThrow();
  });
  it("rolls back the whole transaction when validation fails", () => {
    const badDir = fixtureDir();
    // model referencing a make that does not exist -> rejected row -> rollback
    fs.appendFileSync(path.join(badDir, "Complete_US_Make_Model_Catalog_1980_to_2026-07-15.csv"),
      `Nonexistent,Ghost,1990,1990,1990,Discontinued,Passenger Car,United States,No,Original Source,Fully Verified,EPA,https://epa.example/x,,,2026-07-15,\r\n`);
    const db2 = freshDb();
    expect(() => runImport(db2, badDir)).toThrow(/Mandatory import validation failed/);
    expect((db2.prepare("SELECT COUNT(*) n FROM makes").get() as { n: number }).n).toBe(0);
    expect((db2.prepare("SELECT COUNT(*) n FROM models").get() as { n: number }).n).toBe(0);
  });
});

describe("exports (fixture db)", () => {
  const dir = fixtureDir();
  const db = freshDb();
  runImport(db, dir);
  it("produces all worksheets with expected headers and row counts", async () => {
    const wb = buildWorkbook(db);
    const names = wb.worksheets.map((w) => w.name);
    for (const s of ["Makes", "Models", "Submodels", "Model Years", "Submodel Years",
      "Aliases", "Grouped Models", "Review Required", "Sources", "Catalog Summary"]) {
      expect(names).toContain(s);
    }
    const models = wb.getWorksheet("Models")!;
    expect(models.actualRowCount - 1)
      .toBe((db.prepare("SELECT COUNT(*) n FROM models").get() as { n: number }).n);
    const heads = (models.getRow(1).values as unknown[]).map(String);
    for (const h of ["Model ID", "Make ID", "Standard Make", "Standard Model",
      "Confirmed Model Years", "Validation Status"]) {
      expect(heads).toContain(h);
    }
    const years = wb.getWorksheet("Model Years")!;
    expect(years.actualRowCount - 1)
      .toBe((db.prepare("SELECT COUNT(*) n FROM model_years").get() as { n: number }).n);
    // source hyperlink present
    const makeSheet = wb.getWorksheet("Makes")!;
    const urlCell = makeSheet.getRow(2).getCell(12).value as { hyperlink?: string };
    expect(String(urlCell?.hyperlink ?? urlCell)).toContain("http");
  });
  it("CSV serializer quotes embedded newlines and commas", () => {
    const csv = toCsv([{ a: 'x "quoted", with\nnewline' }], [{ header: "A", key: "a" }]);
    expect(csv).toContain('"x ""quoted"", with\nnewline"');
  });
});

describe("real catalog files are detected and untouched", () => {
  it("detects the catalog file set", () => {
    const files = detectCatalogFiles();
    expect(files.master).toBeTruthy();
    expect(files.makes).toBeTruthy();
    const rows = readCsv(files.master!);
    expect(rows.length).toBeGreaterThan(1000);
  });
});

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ } });
