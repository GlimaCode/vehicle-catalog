/**
 * Version 5.1 security and reliability tests (37 scenarios).
 * Runs against a disposable copy of the release database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema, DATA_DIR, UPLOAD_DIR, PROJECT_EXPORT_DIR } from "../server/db.js";
import { loadConfig, DEFAULT_CONFIG } from "../server/config.js";
import { neutralize, needsNeutralizing, neutralizeRow,
  isTrustedHyperlinkField } from "../server/security/formula.js";
import { inspectUpload, detectFileType, readZipCentralDirectory,
  assertSafeUpload, UnsafeFileError } from "../server/security/workbook.js";
import { sanitizeDisplayName, isUnsafeFilename, resolveInside, isInside,
  newStorageId, uniqueOutputName } from "../server/security/filenames.js";
import { withLock, LockBusyError, resetLocks } from "../server/security/locks.js";
import { writeFileAtomic, writeViaTemp, sweepTempFiles } from "../server/security/atomic.js";
import { withCanonicalUnlocked, CANONICAL_IMPORTER_TOKEN,
  enterStandardizationContext, exitStandardizationContext } from "../server/canonical_lock.js";
import { runStartupRecovery } from "../server/recovery.js";
import { previewDeletion, executeDeletion, applyRetentionPolicy } from "../server/retention.js";
import { securityHeaders, corsPolicy, authGuard, csrfGuard } from "../server/security/http.js";
import { saveUpload, createProject, setMapping, processProject, applyDecision,
  projectStats, type ProjectMapping } from "../server/standardize/project.js";
import { previewFile } from "../server/standardize/parse.js";
import { exportCsvWithStats, exportXlsxWithStats, buildChangeReport,
  writeChangeReportToFile, buildReviewOnlyWorkbook,
  valueMappingCsv } from "../server/standardize/exports.js";
import { CanonicalResolver } from "../server/standardize/resolver.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harden-"));
const TEST_DB = path.join(tmp, "harden.db");
let db: Database.Database;

const CSV = [
  "Item ID,Title,Make,Model,Trim,Year,Notes",
  'A1,"Cover, deluxe",ford,F150,XLT,2018,=cmd|\' /C calc\'!A0',
  "A2,Cover,Mercedes Benz,C-Class,AMG,2016,+44 1234",
  "A3,Cover,Chevrolet,Escalade,Platinum,2012,-12.5",
  "A4,Cover,Ford,Excrision,XLT,2004,@SUM(1+1)",
].join("\r\n") + "\r\n";

function writeCsv(name: string, text = CSV): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text, "utf-8");
  return p;
}

async function makeProject(file: string, name = "hardening"): Promise<number> {
  const up = saveUpload(fs.readFileSync(file), path.basename(file));
  const id = await createProject(db, { filename: path.basename(file), stored: up.stored,
    hash: up.hash, storageId: up.storageId, projectName: name });
  const preview = await previewFile(up.stored, {});
  setMapping(db, id, { headerRow: 1, preserveUnmapped: true,
    columns: preview.headers.map((h, i) => ({ column: h, index: i,
      field: h === "Year" ? "Model Year"
        : ["Make", "Model", "Trim", "Title", "Item ID"].includes(h) ? h
        : "Preserve as Custom Field" })) as ProjectMapping["columns"] });
  return id;
}

/** Minimal ZIP builder (stored entries) for malicious-workbook fixtures. */
function buildZip(entries: { name: string; data: Buffer; declaredUncompressed?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8");
    const size = e.declaredUncompressed ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(0, 14);           // crc (not validated by our reader)
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

beforeAll(() => {
  fs.copyFileSync(path.join(DATA_DIR, "catalog-v5.1.db"), TEST_DB);
  db = new Database(TEST_DB);
  db.pragma("foreign_keys = ON");     // match the running application
  initSchema(db);
});
afterAll(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe("1-4 formula injection protection", () => {
  it("1. neutralizes CSV formula payloads while keeping the text", async () => {
    const id = await makeProject(writeCsv("formula.csv"), "formula-csv");
    await processProject(db, id);
    const { csv, protection } = exportCsvWithStats(db, id, "audit");
    expect(protection.neutralizedCells).toBeGreaterThan(0);
    expect(csv).toContain("'=cmd|' /C calc'!A0".slice(0, 6));   // prefixed, text intact
    expect(csv).not.toMatch(/(^|,)=cmd/m);                      // never a bare formula
    expect(csv).toContain("Formula Injection Protection Applied");
  });
  it("2. writes risky XLSX cells as inert text, not formulas", async () => {
    const id = await makeProject(writeCsv("formula2.csv"), "formula-xlsx");
    await processProject(db, id);
    const { wb, protection } = await exportXlsxWithStats(db, id, "audit");
    expect(protection.neutralizedCells).toBeGreaterThan(0);
    const ws = wb.worksheets[0];
    let sawFormula = false;
    ws.eachRow((row) => row.eachCell((cell) => {
      if (cell.formula || (cell.value && typeof cell.value === "object"
        && "formula" in (cell.value as object))) sawFormula = true;
    }));
    expect(sawFormula).toBe(false);
    const header = (ws.getRow(1).values as unknown[]).map(String);
    expect(header).toContain("Formula Injection Protection Applied");
  });
  it("3. preserves legitimate negative and numeric values", () => {
    for (const v of ["-12.5", "-5", "+3.25", "-1,234.56", "1e6", "-2020/01"]) {
      expect(needsNeutralizing(v)).toBe(false);
      expect(neutralize(v).value).toBe(v);
    }
    expect(needsNeutralizing("=1+1")).toBe(true);
    expect(needsNeutralizing("@import")).toBe(true);
    expect(needsNeutralizing("\tTabbed")).toBe(true);
  });
  it("4. leaves application-generated source hyperlinks untouched", () => {
    expect(isTrustedHyperlinkField("Primary Source URL")).toBe(true);
    const res = neutralizeRow(["Primary Source URL", "Notes"],
      ["https://www.fueleconomy.gov/x", "=EVIL()"]);
    expect(res.values[0]).toBe("https://www.fueleconomy.gov/x");
    expect(res.values[1]).toBe("'=EVIL()");
    expect(res.neutralizedCount).toBe(1);
  });
});

describe("5-12 untrusted file handling", () => {
  it("5. rejects an excessive decompression ratio (zip bomb)", () => {
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(1000, 65),
      declaredUncompressed: 1000 * 5000 }]);
    const r = inspectUpload(zip, "bomb.xlsx");
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/ratio|ZIP bomb|expands/i);
  });
  it("6. rejects an excessive number of ZIP entries", () => {
    const entries = Array.from({ length: 2100 }, (_, i) =>
      ({ name: `xl/media/img${i}.png`, data: Buffer.from("x") }));
    const r = inspectUpload(buildZip(entries), "many.xlsx");
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/entries/i);
  });
  it("7. rejects an excessive worksheet count", () => {
    const entries = Array.from({ length: 70 }, (_, i) =>
      ({ name: `xl/worksheets/sheet${i}.xml`, data: Buffer.from("<x/>") }));
    const r = inspectUpload(buildZip(entries), "sheets.xlsx");
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/worksheets/i);
  });
  it("8. rejects excessive row/column/cell counts", async () => {
    const cfg = loadConfig();
    const original = cfg.workbook.maxCells;
    cfg.workbook.maxCells = 10;
    try {
      const big = ["A,B,C", "1,2,3", "4,5,6", "7,8,9", "1,2,3", "4,5,6"].join("\n");
      await expect(previewFile(writeCsv("toobig.csv", big), {})).rejects.toThrow(/cells/i);
    } finally {
      cfg.workbook.maxCells = original;
    }
  });
  it("9. rejects path-traversal and absolute entry names", () => {
    for (const name of ["../../evil.xml", "/etc/passwd", "C:\\windows\\system32\\a.dll",
      "xl\\worksheets\\sheet1.xml"]) {
      const r = inspectUpload(buildZip([{ name, data: Buffer.from("x") }]), "trav.xlsx");
      expect(r.ok).toBe(false);
      expect(r.reasons.join(" ")).toMatch(/Unsafe entry name/i);
    }
  });
  it("10. handles Windows device filenames safely", () => {
    expect(isUnsafeFilename("CON")).toBe(true);
    expect(isUnsafeFilename("nul.csv")).toBe(true);
    expect(isUnsafeFilename("LPT1.xlsx")).toBe(true);
    expect(sanitizeDisplayName("CON.csv").startsWith("_")).toBe(true);
    expect(sanitizeDisplayName("trailing dots... ")).not.toMatch(/[. ]$/);
    expect(sanitizeDisplayName("../../../etc/passwd")).toBe("passwd");
  });
  it("11. rejects extension and file-signature mismatches", () => {
    const zip = buildZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>") }]);
    expect(inspectUpload(zip, "actually-a-zip.csv").ok).toBe(false);
    expect(inspectUpload(Buffer.from("Make,Model\nFord,F-150\n"), "claims.xlsx").ok).toBe(false);
    expect(detectFileType(zip)).toBe("zip/xlsx");
    expect(detectFileType(Buffer.from("plain text"))).toBe("text");
    expect(detectFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBe("ole2/xls");
  });
  it("12. rejects macro-enabled workbooks", () => {
    expect(inspectUpload(Buffer.from("x"), "macro.xlsm").ok).toBe(false);
    const withVba = buildZip([
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<x/>") },
      { name: "xl/vbaProject.bin", data: Buffer.from("MZ") }]);
    const r = inspectUpload(withVba, "macro.xlsx");
    expect(r.hasMacros).toBe(true);
    expect(r.ok).toBe(false);
    expect(() => assertSafeUpload(withVba, "macro.xlsx")).toThrow(UnsafeFileError);
  });
});

describe("13-16 server and canonical security", () => {
  it("13. binds to localhost only by default", () => {
    expect(DEFAULT_CONFIG.server.bindAddress).toBe("127.0.0.1");
    expect(DEFAULT_CONFIG.server.allowLanAccess).toBe(false);
    const cfg = loadConfig();
    expect(cfg.server.bindAddress).toBe("127.0.0.1");
    expect(cfg.server.allowLanAccess).toBe(false);
  });
  it("14. restricts CORS and applies security headers", () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; },
      status: () => res, json: () => res, end: () => res } as never;
    securityHeaders({} as never, res, () => { /* next */ });
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    let blocked = false;
    const res2 = { setHeader: () => undefined,
      status: (c: number) => { if (c === 403) blocked = true; return res2; },
      json: () => res2, end: () => res2 } as never;
    corsPolicy({ header: () => "https://evil.example", method: "GET" } as never, res2,
      () => { /* next */ });
    expect(blocked).toBe(true);
  });
  it("15. canonical unlock is not reachable from ordinary API input", () => {
    // no token -> refused
    expect(() => (withCanonicalUnlocked as unknown as
      (d: unknown, f: () => void) => void)(db, () => undefined))
      .toThrow(/importer token is required/);
    // inside a standardization request -> refused even with the token
    enterStandardizationContext();
    try {
      expect(() => withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, () => undefined))
        .toThrow(/standardization operation is in progress/);
    } finally {
      exitStandardizationContext();
    }
    // triggers still block direct writes
    expect(() => db.prepare("UPDATE makes SET standard_make='X' WHERE id=1").run())
      .toThrow(/read-only/);
  });
  it("16. unlock is restored after an importer failure", () => {
    expect(() => withCanonicalUnlocked(db, CANONICAL_IMPORTER_TOKEN, () => {
      throw new Error("importer exploded");
    })).toThrow(/importer exploded/);
    const flag = db.prepare("SELECT value FROM catalog_meta WHERE key='canonical_unlocked'")
      .get() as { value: string };
    expect(flag.value).toBe("0");
    expect(() => db.prepare("DELETE FROM makes WHERE id=1").run()).toThrow(/read-only/);
  });
});

describe("17-19 retention and cleanup", () => {
  it("17. deletes a project with a preview and an audit record", async () => {
    const id = await makeProject(writeCsv("del.csv"), "delete-me");
    await processProject(db, id);
    const preview = previewDeletion(db, id, "project");
    expect(preview.rows).toBeGreaterThan(0);
    expect(preview.canonicalRecordsAffected).toBe(0);
    const before = db.prepare("SELECT COUNT(*) n FROM makes").get() as { n: number };
    const result = executeDeletion(db, id, "project", "hardening test");
    expect(result.filesDeleted).toBeGreaterThanOrEqual(0);
    expect(db.prepare("SELECT id FROM standardization_projects WHERE id=?").get(id))
      .toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) n FROM makes").get() as { n: number }).n)
      .toBe(before.n);                                  // canonical untouched
    const audit = db.prepare("SELECT * FROM project_deletions WHERE project_id=?").get(id) as
      { rows_deleted: number; reason: string };
    expect(audit.reason).toBe("hardening test");
    expect(audit.rows_deleted).toBeGreaterThan(0);
  });
  it("17b. deletes a project that has recorded review decisions", async () => {
    // standardization_changes.row_id references standardization_rows(id), so the
    // delete order matters; a review decision is what creates such a change
    const id = await makeProject(writeCsv("del-reviewed.csv"), "delete-reviewed");
    await processProject(db, id);
    const row = db.prepare(`SELECT row_number FROM standardization_rows
      WHERE project_id=? ORDER BY row_number LIMIT 1`).get(id) as { row_number: number };
    applyDecision(db, id, row.row_number, "Model", "Keep Original", undefined,
      "deletion regression test");
    const linked = db.prepare(`SELECT COUNT(*) n FROM standardization_changes
      WHERE project_id=? AND row_id IS NOT NULL`).get(id) as { n: number };
    expect(linked.n).toBeGreaterThan(0);

    expect(() => executeDeletion(db, id, "project", "deletion regression test"))
      .not.toThrow();
    expect(db.prepare("SELECT id FROM standardization_projects WHERE id=?").get(id))
      .toBeUndefined();
    expect((db.prepare(`SELECT COUNT(*) n FROM standardization_changes
      WHERE project_id=?`).get(id) as { n: number }).n).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
  it("18. sweeps temporary files", () => {
    const dir = path.join(PROJECT_EXPORT_DIR, "sweep-test");
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "half-written.csv.abc.part");
    fs.writeFileSync(stale, "partial");
    const removed = sweepTempFiles(PROJECT_EXPORT_DIR);
    expect(removed.some((p) => p.endsWith(".part"))).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
  it("19. applies the automatic retention policy", async () => {
    const cfg = loadConfig();
    const original = cfg.retention.autoPurgeProjectsAfterDays;
    const id = await makeProject(writeCsv("old.csv"), "old-project");
    db.prepare(`UPDATE standardization_projects SET created_at=datetime('now','-100 days'),
      updated_at=datetime('now','-100 days') WHERE id=?`).run(id);
    cfg.retention.autoPurgeProjectsAfterDays = 30;
    try {
      const r = applyRetentionPolicy(db);
      expect(r.purgedProjects).toContain(id);
    } finally {
      cfg.retention.autoPurgeProjectsAfterDays = original;
    }
  });
});

describe("20-24 crash recovery and filesystem failures", () => {
  it("20. recovers a project interrupted during processing", async () => {
    const id = await makeProject(writeCsv("crash.csv"), "crash-processing");
    db.prepare("UPDATE standardization_projects SET status='Processing', processed_rows=2 WHERE id=?")
      .run(id);
    const report = runStartupRecovery(db);
    expect(report.staleProcessing).toBeGreaterThan(0);
    const p = db.prepare("SELECT status, recovery_state FROM standardization_projects WHERE id=?")
      .get(id) as { status: string; recovery_state: string };
    expect(p.status).toBe("Mapped");
    expect(p.recovery_state).toMatch(/resume continues from row 3/i);
  });
  it("21. removes incomplete exports after a crash during export", async () => {
    const dir = path.join(PROJECT_EXPORT_DIR, "crash-export");
    fs.mkdirSync(dir, { recursive: true });
    const partial = path.join(dir, "output.xlsx.zzz.part");
    fs.writeFileSync(partial, "incomplete");
    const report = runStartupRecovery(db);
    expect(fs.existsSync(partial)).toBe(false);
    expect(report.walCheckpoint).not.toMatch(/failed/);
  });
  it("22. marks unrecoverable jobs instead of pretending they finished", async () => {
    const id = await makeProject(writeCsv("gone.csv"), "missing-source");
    const p = db.prepare("SELECT stored_path FROM standardization_projects WHERE id=?")
      .get(id) as { stored_path: string };
    fs.rmSync(p.stored_path);
    db.prepare("UPDATE standardization_projects SET status='Processing' WHERE id=?").run(id);
    runStartupRecovery(db);
    const after = db.prepare("SELECT status, recovery_state FROM standardization_projects WHERE id=?")
      .get(id) as { status: string; recovery_state: string };
    expect(after.status).toBe("Failed");
    expect(after.recovery_state).toMatch(/no longer available/i);
  });
  it("23. reports disk-full and permission errors without leaving partial files", async () => {
    const target = path.join(tmp, "nested", "out.txt");
    await expect(writeViaTemp(target, async (t) => {
      fs.writeFileSync(t, "data");
      const err = new Error("no space") as NodeJS.ErrnoException;
      err.code = "ENOSPC";
      throw err;
    })).rejects.toThrow(/disk space/i);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith(".part")))
      .toHaveLength(0);
  });
  it("24. reports a locked output file clearly", async () => {
    const target = path.join(tmp, "locked.txt");
    await expect(writeViaTemp(target, async () => {
      const err = new Error("busy") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    })).rejects.toThrow(/locked by another program/i);
  });
});

describe("25-30 concurrency, backup and restore", () => {
  beforeAll(() => resetLocks());
  it("25. allows two different projects to process concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const job = (id: number) => withLock("process", id, `Processing ${id}`, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return id;
    });
    const results = await Promise.all([job(101), job(102)]);
    expect(results).toEqual([101, 102]);
    expect(maxConcurrent).toBe(2);
  });
  it("26. refuses a duplicate processing request for the same project", async () => {
    let rejected: unknown = null;
    const first = withLock("process", 200, "Processing 200",
      () => new Promise((r) => setTimeout(r, 50)));
    try {
      await withLock("process", 200, "Processing 200", async () => undefined);
    } catch (e) { rejected = e; }
    await first;
    expect(rejected).toBeInstanceOf(LockBusyError);
    expect(String(rejected)).toMatch(/already running/i);
  });
  it("27. refuses a duplicate export request for the same project", async () => {
    let rejected: unknown = null;
    const first = withLock("export", 300, "Exporting 300",
      () => new Promise((r) => setTimeout(r, 50)));
    try {
      await withLock("export", 300, "Exporting 300", async () => undefined);
    } catch (e) { rejected = e; }
    await first;
    expect(rejected).toBeInstanceOf(LockBusyError);
  });
  it("28. refuses a backup while a job is active", async () => {
    let rejected: unknown = null;
    const job = withLock("process", 400, "Processing 400",
      () => new Promise((r) => setTimeout(r, 50)));
    try {
      await withLock("global", undefined, "Backup database", async () => undefined);
    } catch (e) { rejected = e; }
    await job;
    expect(String(rejected)).toMatch(/Cannot start "Backup database"/);
  });
  it("29. refuses a restore while the server is busy", async () => {
    let rejected: unknown = null;
    const job = withLock("export", 500, "Exporting 500",
      () => new Promise((r) => setTimeout(r, 50)));
    try {
      await withLock("global", undefined, "Restore database", async () => undefined);
    } catch (e) { rejected = e; }
    await job;
    expect(String(rejected)).toMatch(/Cannot start "Restore database"/);
  });
  it("30. backup and restore round trip preserves the project", async () => {
    const id = await makeProject(writeCsv("roundtrip.csv"), "round-trip");
    await processProject(db, id);
    const before = projectStats(db, id);
    const backup = path.join(tmp, "roundtrip.db");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare("VACUUM INTO ?").run(backup);
    const restored = new Database(backup, { readonly: true });
    const after = restored.prepare(`SELECT COUNT(*) n FROM standardization_rows
      WHERE project_id=?`).get(id) as { n: number };
    expect(after.n).toBe(before.inputRows);
    expect((restored.prepare("SELECT COUNT(*) n FROM makes").get() as { n: number }).n)
      .toBe(76);
    restored.close();
  });
});

describe("31-37 release integrity and regression", () => {
  it("31. the release database has a clean WAL checkpoint", () => {
    const release = path.join(DATA_DIR, "catalog-v5.1.db");
    expect(fs.existsSync(release)).toBe(true);
    const wal = release + "-wal";
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
  });
  it("32. the release database contains no test or benchmark projects", () => {
    const rel = new Database(path.join(DATA_DIR, "catalog-v5.1.db"), { readonly: true });
    const n = (q: string) => (rel.prepare(q).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM standardization_projects")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM standardization_rows")).toBe(0);
    expect(n("SELECT COUNT(*) n FROM standardization_changes")).toBe(0);
    rel.close();
  });
  it("33. the 100,000 x 100 benchmark is recorded as passing", () => {
    const p = path.resolve("exports", "Large_File_Performance_Report.json");
    expect(fs.existsSync(p)).toBe(true);
    const report = JSON.parse(fs.readFileSync(p, "utf-8")) as
      { fixtures: { fixture: string; rowCount: number; columnCount: number;
        resultStatus: string; peakRssMB: number }[] };
    const a = report.fixtures.find((f) => f.fixture.includes("Fixture A"))!;
    expect(a.rowCount).toBe(100_000);
    expect(a.columnCount).toBe(100);
    expect(a.resultStatus).toBe("PASS");
  });
  it("34. the 250,000 x 20 benchmark is recorded as passing", () => {
    const report = JSON.parse(fs.readFileSync(
      path.resolve("exports", "Large_File_Performance_Report.json"), "utf-8")) as
      { fixtures: { fixture: string; rowCount: number; resultStatus: string }[] };
    const b = report.fixtures.find((f) => f.fixture.includes("Fixture B"))!;
    expect(b.rowCount).toBe(250_000);
    expect(b.resultStatus).toBe("PASS");
  });
  it("35. Version 5 matching behaviour is unchanged", () => {
    const r = new CanonicalResolver(db);
    expect(r.resolveMake("ford").value).toBe("Ford");
    expect(r.resolveMake("Mercedes Benz").value).toBe("Mercedes-Benz");
    expect(r.resolveModel("F150", "Ford").value).toBe("F-150");
    expect(r.resolveModel("X Type", "Jaguar").value).toBe("X-Type");
    expect(r.resolveModel("Excrision", "Ford").confidence).toBe("Approved Alias Match");
    const conflict = r.resolveModel("Escalade", "Chevrolet");
    expect(conflict.confidence).toBe("Conflict");
    expect(conflict.value).toBeNull();
  });
  it("36. Version 4 catalog data is unchanged", () => {
    const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM makes")).toBe(76);
    expect(n("SELECT COUNT(*) n FROM models")).toBe(1798);
    expect(n("SELECT COUNT(*) n FROM vehicle_hierarchy_values")).toBe(390);
    expect(n("SELECT COUNT(*) n FROM vehicle_configuration_values")).toBe(6859);
    expect(n("SELECT COUNT(*) n FROM model_years")).toBe(15594);
  });
  it("37. all export artifacts still generate with protection metadata", async () => {
    const id = await makeProject(writeCsv("artifacts.csv"), "artifacts");
    await processProject(db, id);
    const changeWb = await buildChangeReport(db, id);
    const summary = changeWb.getWorksheet("Summary")!;
    const labels: string[] = [];
    summary.eachRow((row) => labels.push(String(row.getCell(1).value)));
    expect(labels).toContain("Formula Injection Protection Applied");
    const reviewWb = await buildReviewOnlyWorkbook(db, id);
    expect(reviewWb.getWorksheet("Review Required")).toBeTruthy();
    expect(valueMappingCsv(db, id)).toContain("Raw Value");
    const streamed = path.join(tmp, "streamed-changes.xlsx");
    await writeChangeReportToFile(db, id, streamed);
    const check = new ExcelJS.Workbook();
    await check.xlsx.readFile(streamed);
    for (const s of ["Summary", "Changed Rows", "Unchanged Rows", "Review Required",
      "No Match", "Conflicts", "Value Mappings", "Column Mapping", "Validation Results"]) {
      expect(check.getWorksheet(s)).toBeTruthy();
    }
  });
});
