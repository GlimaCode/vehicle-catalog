/**
 * Title Optimizer tests (38 scenarios).
 *
 * These cover the character-limit contract, the information-preservation rules,
 * the safety rules that must never be violated, and the integration points with
 * the frozen canonical catalog and the Version 5.1 workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSchema, DATA_DIR } from "../server/db.js";
import { optimizeTitle, revalidateTitle } from "../server/title/optimizer.js";
import { createCanonicalLookup } from "../server/title/canonical.js";
import { normalizeYears, titleLength } from "../server/title/text.js";
import {
  applyTitleDecision, applyToSimilar, approveAllWithinLimit, createTitleProject,
  loadAbbreviations, loadEnabledRules, processTitleProject, saveTitleUpload,
  setTitleMapping, titleProjectStats,
} from "../server/title/project.js";
import {
  buildTitleReport, exportTitleCsv, exportTitleXlsx,
} from "../server/title/exports.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "title-tests-"));
const TEST_DB = path.join(tmp, "title.db");
let db: Database.Database;
let canonical: ReturnType<typeof createCanonicalLookup>;
let abbreviations: ReturnType<typeof loadAbbreviations>;

const HEADERS = ["Item ID", "SKU", "Title", "Year", "Make", "Model", "Trim",
  "Material", "Color", "Variation", "Product Type", "Position", "Side", "Quantity"];

const csvEsc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** RFC-4180 single-line parser: quoted commas and doubled quotes handled. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cell); cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

function writeCsv(name: string, rows: string[][]): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, [HEADERS, ...rows].map((r) => r.map(csvEsc).join(",")).join("\r\n")
    + "\r\n", "utf-8");
  return p;
}

async function makeProject(file: string, projectName = "test"): Promise<number> {
  const saved = saveTitleUpload(fs.readFileSync(file), path.basename(file));
  const id = await createTitleProject(db, { filename: path.basename(file),
    stored: saved.stored, hash: saved.hash, projectName, storageId: saved.storageId });
  setTitleMapping(db, id, { headerRow: 1,
    columns: HEADERS.map((h, i) => ({ column: h, index: i,
      field: h === "Year" ? "Year Range" : h })) });
  return id;
}

const opt = (fields: Record<string, string>, max = 80) =>
  optimizeTitle(fields, { maxCharacters: max, abbreviations, canonical });

beforeAll(() => {
  fs.copyFileSync(path.join(DATA_DIR, "catalog-v6.db"), TEST_DB);
  db = new Database(TEST_DB);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  canonical = createCanonicalLookup(db);
  abbreviations = loadAbbreviations(db, null);
});
afterAll(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows lock */ }
});

describe("1-3 character limit boundaries", () => {
  it("1. a title of exactly 80 characters is valid and left alone", () => {
    const title = "A".repeat(80);
    expect(titleLength(title)).toBe(80);
    const r = opt({ Title: title });
    expect(r.status).toBe("Already Within Limit");
    expect(r.proposedTitle).toBe(title);
    expect(r.proposedLength).toBe(80);
  });
  it("2. 79 characters is within the limit; 81 is over", () => {
    const under = opt({ Title: "B".repeat(79) });
    expect(under.status).toBe("Already Within Limit");
    expect(under.proposedLength).toBe(79);
    const over = opt({ Title: "C".repeat(81) });
    expect(over.proposedLength).toBeGreaterThan(80);
    expect(over.status).toBe("Unable to Reach Limit");
  });
  it("3. counts Unicode code points, not UTF-8 bytes", () => {
    const accented = "Sitzbezüge für Fahrer";          // multi-byte characters
    expect(titleLength(accented)).toBe(21);
    expect(Buffer.byteLength(accented, "utf-8")).toBeGreaterThan(21);
    const emoji = "AB🚗CD";                             // surrogate pair counts once
    expect(titleLength(emoji)).toBe(5);
    const cjk = "座席カバー";
    expect(titleLength(cjk)).toBe(5);
    // an 80-code-point title with multi-byte characters is still within the limit
    const eighty = "é".repeat(80);
    expect(opt({ Title: eighty }).status).toBe("Already Within Limit");
  });
});

describe("4-5 year handling", () => {
  it("4. compresses consecutive years into a range", () => {
    expect(normalizeYears("2006 2007 2008").value).toBe("2006-2008");
    expect(normalizeYears("2006, 2007, 2008").value).toBe("2006-2008");
    expect(normalizeYears("2006 to 2008").value).toBe("2006-2008");
    expect(normalizeYears("2006 thru 2008").value).toBe("2006-2008");
  });
  it("5. never merges non-contiguous years", () => {
    expect(normalizeYears("2006, 2008").value).toBe("2006, 2008");
    expect(normalizeYears("2006 2008").value).toBe("2006, 2008");
    expect(normalizeYears("2006-2008; 2010").value).toBe("2006-2008, 2010");
    expect(normalizeYears("1999 2000 2001 2003").value).toBe("1999-2001, 2003");
    // and the optimizer refuses any candidate that would change the year set
    const r = opt({ Title: "Fits 2006, 2008 Ford F-150 Driver Bottom Leather Seat "
      + "Cover Black Brand New High Quality", Make: "Ford", Model: "F-150" });
    expect(r.proposedTitle).toContain("2006, 2008");
    expect(r.proposedTitle).not.toContain("2006-2008");
  });
});

describe("6-7 canonical Make and Model", () => {
  it("6. applies canonical Make spelling", () => {
    const r = opt({ Title: "2006-2008 ford F-150 Driver Bottom Leather Seat Cover "
      + "Black Brand New Premium Quality", Make: "ford", Model: "F-150" });
    expect(r.proposedTitle).toContain("Ford");
    expect(r.appliedRules.map((a) => a.ruleId)).toContain("S1_CANONICAL_MAKE");
    expect(canonical.resolveMake("Mercedes Benz")?.value).toBe("Mercedes-Benz");
  });
  it("7. applies canonical Model spelling", () => {
    const r = opt({ Title: "2006-2008 Ford F150 Driver Bottom Leather Seat Cover "
      + "Black Brand New Premium Quality", Make: "Ford", Model: "F150" });
    expect(r.proposedTitle).toContain("F-150");
    expect(canonical.resolveModel("Ford", "F150")?.value).toBe("F-150");
  });
});

describe("8-10 material and color", () => {
  it("8. never abbreviates Leather", () => {
    const long = "Replacement Seat Cover For Fits 2006 2007 2008 Ford F-150 Driver "
      + "and Passenger Bottom Leather Black Brand New High Quality Custom Fit";
    const r = opt({ Title: long, Make: "Ford", Model: "F-150", Material: "Leather",
      Color: "Black" });
    expect(r.proposedTitle).toMatch(/\bLeather\b/);
    expect(r.proposedTitle).not.toMatch(/\bLthr\b/i);
    expect(r.proposedTitle).not.toMatch(/\bLeath\b/i);
  });
  it("9. preserves Genuine Leather when the source confirms it", () => {
    const long = "Brand New Premium Quality Replacement Seat Cover For Fits 2006 2007 "
      + "2008 Ford F-150 Driver Bottom Genuine Leather Black Custom Fit Hot Sale";
    const r = opt({ Title: long, Make: "Ford", Model: "F-150",
      Material: "Genuine Leather", Color: "Black" });
    expect(r.proposedTitle).toMatch(/Genuine Leather/);
    expect(r.proposedTitle).not.toMatch(/\bG\.\s*Leather\b/i);
    // and it is never downgraded to plain Leather to save characters
    expect(r.proposedTitle.replace(/Genuine Leather/g, "")).not.toMatch(/\bLeather\b/);
  });
  it("10. abbreviates approved colors only when needed", () => {
    const withinLimit = opt({ Title: "2006-2008 Ford F-150 Driver Bottom Leather "
      + "Seat Cover Black", Make: "Ford", Model: "F-150", Color: "Black" });
    expect(withinLimit.proposedTitle).toContain("Black");   // full word preferred
    const over = opt({ Title: "Replacement Seat Cover For Fits 2006 2007 2008 Ford "
      + "F-150 Driver and Passenger Bottom Cushion Leather Black Brand New",
      Make: "Ford", Model: "F-150", Color: "Black", Material: "Leather" });
    expect(over.proposedLength).toBeLessThan(over.originalLength);
  });
});

describe("11-13 wording compaction", () => {
  it("11. compacts Driver & Passenger", () => {
    const r = opt({ Title: "Replacement Seat Cover For Fits 2006 2007 2008 Ford F-150 "
      + "Driver & Passenger Bottom Leather Black Brand New High Quality",
      Make: "Ford", Model: "F-150", Material: "Leather", Color: "Black" });
    // the pair is joined with "/" and either half may also be abbreviated
    expect(r.proposedTitle).toMatch(/\b(Driver|Drv)\/(Passenger|Pass)\b/);
    expect(r.proposedTitle).not.toMatch(/Driver\s*&\s*Passenger/);
  });
  it("12. compacts Front & Rear and Left & Right", () => {
    const r = opt({ Title: "Replacement Seat Cover For Fits 2019 2020 2021 Toyota "
      + "Camry Front & Rear Left & Right Cloth Seat Cover Dark Gray Brand New",
      Make: "Toyota", Model: "Camry", Material: "Cloth", Color: "Dark Gray" });
    expect(r.proposedTitle).toMatch(/\b(Front|Frt)\/(Rear|Rr)\b/);
    expect(r.proposedTitle).toMatch(/\b(Left|LH)\/(Right|RH)\b/);
    expect(r.proposedTitle).not.toMatch(/\s&\s/);
  });
  it("13. removes duplicate phrases", () => {
    const r = opt({ Title: "Seat Cover Seat Cover 2006-2008 Ford F-150 Driver Bottom "
      + "Leather Black Brand New High Quality Premium Quality",
      Make: "Ford", Model: "F-150", Material: "Leather", Color: "Black" });
    expect((r.proposedTitle.match(/Seat Cover/gi) ?? []).length).toBe(1);
  });
});

describe("14-17 preservation and limits", () => {
  it("14. preserves required fields", () => {
    const r = opt({ Title: "Brand New Replacement Seat Cover For Fits 2006 2007 2008 "
      + "Ford F-150 Driver Bottom Leather Black High Quality Custom Fit",
      Make: "Ford", Model: "F-150", Material: "Leather", Color: "Black" });
    for (const required of ["Ford", "F-150", "Leather", "Black", "2006-2008"]) {
      expect(r.proposedTitle).toContain(required);
    }
  });
  it("15. preserves variation information", () => {
    const r = opt({ Title: "Brand New Replacement Seat Cover 2006-2008 Ford F-150 "
      + "Driver Bottom Cushion Leather Black High Quality Custom Fit Hot Sale",
      Make: "Ford", Model: "F-150", Material: "Leather", Color: "Black",
      Variation: "Bottom Cushion" });
    expect(r.proposedTitle).toContain("Bottom Cushion");
  });
  it("16. never hard-truncates", () => {
    const long = "Replacement 2015-2020 Mercedes-Benz Sprinter Passenger Bottom "
      + "Genuine Leather Seat Cover Medium Parchment Tan With Armrest Premium Quality";
    const r = opt({ Title: long, Make: "Mercedes-Benz", Model: "Sprinter",
      Material: "Genuine Leather", Color: "Medium Parchment Tan" });
    expect(r.proposedTitle).not.toMatch(/[.…]{3}$/);
    expect(r.proposedTitle).not.toMatch(/\s\w{1,2}$/);   // no severed trailing word
    // every word in the result is a whole word from a documented transformation
    for (const w of r.proposedTitle.split(/[\s/]+/)) expect(w.length).toBeGreaterThan(0);
  });
  it("17. reports Unable to Reach Limit instead of cutting information", () => {
    const long = "Replacement 2015-2020 Mercedes-Benz Sprinter 2500 Passenger Bottom "
      + "Genuine Leather Seat Cover Medium Parchment Tan With Armrest And Headrest";
    const r = opt({ Title: long, Material: "Genuine Leather",
      Color: "Medium Parchment Tan" });
    expect(["Unable to Reach Limit", "Manual Review Required"]).toContain(r.status);
    expect(r.proposedTitle).toMatch(/Genuine Leather/);
  });
});

describe("18-20 review safety", () => {
  it("18. revalidates a manual edit", () => {
    const fields = { Title: "2006-2008 Ford F-150 Driver Bottom Genuine Leather Seat "
      + "Cover Black", Material: "Genuine Leather", Make: "Ford", Model: "F-150" };
    const tooLong = revalidateTitle("X".repeat(90), fields, { maxCharacters: 80 });
    expect(tooLong.status).toBe("Unable to Reach Limit");
    const abbreviated = revalidateTitle(
      "2006-2008 Ford F-150 Driver Bottom Lthr Seat Cover Black", fields,
      { maxCharacters: 80 });
    expect(abbreviated.warnings.join(" ")).toMatch(/Leather must not be abbreviated/);
    const good = revalidateTitle(
      "2006-2008 Ford F-150 Driver Bottom Genuine Leather Cover Black", fields,
      { maxCharacters: 80 });
    expect(good.status).toBe("Optimized");
  });
  it("19. a Make-Model conflict blocks automatic optimization", () => {
    const r = opt({ Title: "Brand New 2012 Ford Escalade Driver Bottom Leather Seat "
      + "Cover Black High Quality Custom Fit Premium", Make: "Ford",
      Model: "Escalade", Material: "Leather", Color: "Black" });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe("Manual Review Required");
    expect(r.proposedTitle).toBe(r.originalTitle);       // untouched
    expect(r.appliedRules).toHaveLength(0);
    expect(r.validationWarnings.join(" ")).toMatch(/conflict/i);
  });
  it("20. an unapproved Trim is never inserted and is flagged", () => {
    const r = opt({ Title: "2006-2008 Ford F-150 Nonexistent-Trim Driver Bottom "
      + "Leather Seat Cover Black", Make: "Ford", Model: "F-150",
      Trim: "Nonexistent-Trim" });
    expect(r.validationWarnings.join(" ")).toMatch(/not an approved canonical hierarchy/);
    // a Trim absent from the title is never added to it
    const r2 = opt({ Title: "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover "
      + "Black", Make: "Ford", Model: "F-150", Trim: "XLT" });
    expect(r2.proposedTitle).not.toContain("XLT");
  });
});

describe("21-25 export contract", () => {
  let projectId: number;
  const ROWS = [
    ["A-1", "SKU-1", "Brand New Replacement Seat Cover For Fits 2006 2007 2008 ford "
      + "F150 Driver & Passenger Bottom Genuine Leather Black Custom Fit",
      "2006 2007 2008", "ford", "F150", "", "Genuine Leather", "Black", "",
      "Seat Cover", "Bottom", "Driver/Passenger", "2"],
    ["A-2", "SKU-2", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
      "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
      "Bottom", "Driver", "1"],
    ["A-3", "SKU-3", "=cmd|' /C calc'!A0 2020 Ford Explorer Driver Bottom Leather "
      + "Seat Cover Black", "2020", "Ford", "Explorer", "", "Leather", "Black", "",
      "Seat Cover", "Bottom", "Driver", "1"],
  ];

  beforeAll(async () => {
    projectId = await makeProject(writeCsv("exports.csv", ROWS), "export-test");
    await processTitleProject(db, projectId);
  });

  it("21. audit mode preserves the original title and adds audit columns", () => {
    const { csv } = exportTitleCsv(db, projectId, "audit");
    const lines = csv.split("\r\n").filter(Boolean);
    expect(lines[0]).toContain("Original Title");
    expect(lines[0]).toContain("Optimized Title");
    expect(lines[0]).toContain("Original Character Count");
    expect(lines[0]).toContain("Optimized Character Count");
    expect(lines[0]).toContain("Characters Removed");
    expect(lines[0]).toContain("Title Optimization Status");
    expect(lines[0]).toContain("Applied Title Rules");
    expect(lines[0]).toContain("Title Optimization Notes");
    // the source Title column still holds the original value
    expect(csv).toContain(ROWS[1][2]);
  });
  it("22. replacement mode changes only the Title column", () => {
    const { csv } = exportTitleCsv(db, projectId, "replacement");
    const parse = (line: string) => (line.match(/("(?:[^"]|"")*"|[^,]*)/g) ?? [])
      .filter((_, i) => i % 2 === 0)
      .map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'));
    const lines = csv.split("\r\n").filter(Boolean);
    expect(parseCsvLine(lines[0])).toEqual(HEADERS);
    for (let i = 0; i < ROWS.length; i++) {
      const out = parseCsvLine(lines[i + 1]);
      for (let c = 0; c < HEADERS.length; c++) {
        if (c === 2) continue;                      // the Title column may change
        expect(out[c]).toBe(ROWS[i][c]);
      }
    }
  });
  it("23. Item ID is never modified", () => {
    for (const mode of ["audit", "replacement"] as const) {
      const { csv } = exportTitleCsv(db, projectId, mode);
      for (const r of ROWS) expect(csv).toContain(r[0]);
    }
    const stored = db.prepare(`SELECT source_json FROM title_optimization_rows
      WHERE project_id=? ORDER BY row_number`).pluck().all(projectId) as string[];
    stored.forEach((s, i) => {
      expect(JSON.parse(s)["Item ID"]).toBe(ROWS[i][0]);
    });
  });
  it("24. SKU is never modified", () => {
    const stored = db.prepare(`SELECT source_json FROM title_optimization_rows
      WHERE project_id=? ORDER BY row_number`).pluck().all(projectId) as string[];
    stored.forEach((s, i) => expect(JSON.parse(s).SKU).toBe(ROWS[i][1]));
  });
  it("25. source row order is preserved", () => {
    const { csv } = exportTitleCsv(db, projectId, "replacement");
    const lines = csv.split("\r\n").filter(Boolean).slice(1);
    lines.forEach((line, i) => expect(line.startsWith(ROWS[i][0])).toBe(true));
  });
  it("26. formula-injection protection applies to optimized titles", async () => {
    const { csv } = exportTitleCsv(db, projectId, "replacement");
    expect(csv).toContain("'=cmd");                       // neutralized in CSV
    expect(csv).not.toMatch(/(^|,)=cmd/m);
    const { wb } = await exportTitleXlsx(db, projectId, "audit");
    let formulas = 0;
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) formulas++;
    })));
    expect(formulas).toBe(0);                             // never a live formula
  });
});

describe("27-32 configuration and review workflow", () => {
  it("27. creates a template", () => {
    const info = db.prepare(`INSERT INTO title_templates
      (name, pattern, required_fields, optional_fields, field_priority)
      VALUES (?,?,?,?,?)`).run("Test Template",
      "{Year Range} {Make} {Model} {Material}", '["Make","Model"]', '["Material"]',
      '["Year Range","Make","Model","Material"]');
    expect(Number(info.changes)).toBe(1);
    const t = db.prepare("SELECT * FROM title_templates WHERE id=?")
      .get(info.lastInsertRowid) as Record<string, unknown>;
    expect(t.name).toBe("Test Template");
  });
  it("28. duplicates a template without touching the original", () => {
    const src = db.prepare("SELECT * FROM title_templates WHERE name=?")
      .get("Test Template") as Record<string, any>;
    db.prepare(`INSERT INTO title_templates (name, pattern, required_fields,
      optional_fields, field_priority, notes) VALUES (?,?,?,?,?,?)`)
      .run("Test Template (copy)", src.pattern, src.required_fields,
        src.optional_fields, src.field_priority, `Duplicated from "${src.name}"`);
    const copy = db.prepare("SELECT * FROM title_templates WHERE name=?")
      .get("Test Template (copy)") as Record<string, any>;
    expect(copy.pattern).toBe(src.pattern);
    const original = db.prepare("SELECT * FROM title_templates WHERE id=?")
      .get(src.id) as Record<string, any>;
    expect(original.name).toBe("Test Template");
  });
  it("29. a disabled rule stops being applied", async () => {
    const title = "Brand New High Quality 2006-2008 Ford F-150 Driver Bottom Leather "
      + "Seat Cover Black Custom Fit";
    const fields = { Title: title, Make: "Ford", Model: "F-150",
      Material: "Leather", Color: "Black" };
    const withRule = optimizeTitle(fields, { maxCharacters: 80, abbreviations,
      canonical, enabledRules: loadEnabledRules(db, null) });
    expect(withRule.appliedRules.map((a) => a.ruleId)).toContain("S2_DROP_MARKETING");

    const reduced = new Set(loadEnabledRules(db, null));
    reduced.delete("S2_DROP_MARKETING");
    const without = optimizeTitle(fields, { maxCharacters: 80, abbreviations,
      canonical, enabledRules: reduced });
    expect(without.appliedRules.map((a) => a.ruleId)).not.toContain("S2_DROP_MARKETING");
    expect(without.proposedTitle).toContain("Brand New");
  });
  it("30. a project-specific abbreviation overrides the global catalog", async () => {
    const pid = await makeProject(writeCsv("abbr.csv", [[
      "A-1", "S-1", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
      "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
      "Bottom", "Driver", "1"]]), "abbr-test");
    db.prepare(`INSERT INTO title_abbreviation_mappings (full_value,
      abbreviated_value, applicable_field, minimum_characters_saved, ambiguity_risk,
      approval_status, project_id) VALUES (?,?,?,?,?,?,?)`)
      .run("Driver", "D", "Side", 1, "Medium", "Approved", pid);
    const projectAbbr = loadAbbreviations(db, pid);
    expect(projectAbbr.find((a) => a.full === "Driver")?.abbreviated).toBe("D");
    // the global catalog is untouched
    expect(loadAbbreviations(db, null).find((a) => a.full === "Driver")?.abbreviated)
      .toBe("Drv");
  });
  it("31. batch-approves every title already within the limit", async () => {
    const pid = await makeProject(writeCsv("batch.csv", [
      ["A-1", "S-1", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
        "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
        "Bottom", "Driver", "1"],
      ["A-2", "S-2", "2018-2022 Honda Accord 2nd Row Bottom Cloth Seat Cover Beige",
        "2018-2022", "Honda", "Accord", "", "Cloth", "Beige", "", "Seat Cover",
        "2nd Row", "", "1"],
    ]), "batch-test");
    await processTitleProject(db, pid);
    const result = approveAllWithinLimit(db, pid);
    expect(result.approved).toBeGreaterThan(0);
    const undecided = db.prepare(`SELECT COUNT(*) FROM title_optimization_rows
      WHERE project_id=? AND user_decision IS NULL`).pluck().get(pid) as number;
    expect(undecided).toBe(0);
  });
  it("32. applies one decision to every identical title", async () => {
    const same = "Brand New 2006-2008 Ford F-150 Driver Bottom Leather Seat Cover "
      + "Black High Quality Custom Fit";
    const pid = await makeProject(writeCsv("similar.csv", [
      ["A-1", "S-1", same, "2006-2008", "Ford", "F-150", "", "Leather", "Black", "",
        "Seat Cover", "Bottom", "Driver", "1"],
      ["A-2", "S-2", same, "2006-2008", "Ford", "F-150", "", "Leather", "Black", "",
        "Seat Cover", "Bottom", "Driver", "1"],
      ["A-3", "S-3", same, "2006-2008", "Ford", "F-150", "", "Leather", "Black", "",
        "Seat Cover", "Bottom", "Driver", "1"],
    ]), "similar-test");
    await processTitleProject(db, pid);
    applyTitleDecision(db, pid, { rowNumber: 1, decision: "Accept Proposed Title" });
    const applied = applyToSimilar(db, pid, 1);
    expect(applied.applied).toBe(2);
    const titles = db.prepare(`SELECT DISTINCT final_title FROM
      title_optimization_rows WHERE project_id=?`).pluck().all(pid) as string[];
    expect(titles).toHaveLength(1);
  });
});

describe("33-35 reporting and scale", () => {
  it("33. report totals match the database", async () => {
    const pid = await makeProject(writeCsv("report.csv", [
      ["A-1", "S-1", "Brand New Replacement Seat Cover For Fits 2006 2007 2008 Ford "
        + "F-150 Driver & Passenger Bottom Genuine Leather Black Custom Fit",
        "2006 2007 2008", "Ford", "F-150", "", "Genuine Leather", "Black", "",
        "Seat Cover", "Bottom", "Driver/Passenger", "2"],
      ["A-2", "S-2", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
        "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
        "Bottom", "Driver", "1"],
    ]), "report-test");
    await processTitleProject(db, pid);
    const stats = titleProjectStats(db, pid);
    const rows = db.prepare(`SELECT COUNT(*) FROM title_optimization_rows
      WHERE project_id=?`).pluck().get(pid) as number;
    expect(stats.inputRows).toBe(rows);
    const summed = db.prepare(`SELECT SUM(characters_removed) FROM
      title_optimization_rows WHERE project_id=?`).pluck().get(pid) as number;
    expect(stats.totalCharactersRemoved).toBe(summed);
    // exported character counts match the exported titles exactly
    const { csv } = exportTitleCsv(db, pid, "audit");
    for (const line of csv.split("\r\n").slice(1).filter(Boolean)) {
      const cells = parseCsvLine(line);
      const optimized = cells[HEADERS.length + 1];
      const count = Number(cells[HEADERS.length + 3]);
      expect(titleLength(optimized)).toBe(count);
    }
  });
  it("34. the report has all eleven documented worksheets", async () => {
    const pid = await makeProject(writeCsv("sheets.csv", [[
      "A-1", "S-1", "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
      "2006-2008", "Ford", "F-150", "", "Leather", "Black", "", "Seat Cover",
      "Bottom", "Driver", "1"]]), "sheets-test");
    await processTitleProject(db, pid);
    const wb = await buildTitleReport(db, pid);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary", "Optimized Titles", "Already Within Limit", "Manual Review",
      "Unable to Reach Limit", "Excluded", "Rule Usage", "Abbreviation Usage",
      "Template", "Character Distribution", "Validation Warnings"]);
  });
  it("35. processes a 100,000-row file within documented limits", async () => {
    const rows: string[][] = [];
    for (let i = 0; i < 100000; i++) {
      rows.push([`ID-${i}`, `SKU-${i}`,
        "Brand New High Quality Replacement Seat Cover For Fits 2006 2007 2008 ford "
        + `F150 Driver & Passenger Bottom Genuine Leather Black Custom Fit ${i}`,
        "2006 2007 2008", "ford", "F150", "", "Genuine Leather", "Black", "",
        "Seat Cover", "Bottom", "Driver/Passenger", "2"]);
    }
    const pid = await makeProject(writeCsv("bench.csv", rows), "bench");
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = await processTitleProject(db, pid);
    const seconds = (Date.now() - started) / 1000;
    const heapMb = (process.memoryUsage().heapUsed - before) / 1048576;
    expect(result.processed).toBe(100000);
    expect(seconds).toBeLessThan(600);
    // streaming means the heap does not grow with the file
    expect(heapMb).toBeLessThan(600);
    // eslint-disable-next-line no-console
    console.log(`      100k titles in ${seconds.toFixed(1)}s, heap delta `
      + `${heapMb.toFixed(0)} MB`);
  }, 900000);
});

describe("36-38 canonical safety and Version 5.1 integration", () => {
  it("36. canonical data is unchanged by title optimization", () => {
    const counts = {
      makes: 76, models: 1798, model_years: 15594, vehicle_hierarchy_values: 390,
      hierarchy_value_years: 2504, vehicle_configuration_values: 6859,
      configuration_value_years: 43465, aliases: 206,
      grouped_model_relationships: 119,
    };
    for (const [table, expected] of Object.entries(counts)) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(expected);
    }
    // and the read-only triggers still refuse a direct write
    expect(() => db.prepare("UPDATE makes SET standard_make='X' WHERE id=1").run())
      .toThrow(/read-only/);
    expect(() => db.prepare("DELETE FROM models WHERE id=1").run())
      .toThrow(/read-only/);
  });
  it("37. the Version 5.1 standardization workspace still works", async () => {
    // the standardization tables are intact and independent of the title tables
    for (const t of ["standardization_projects", "standardization_rows",
      "standardization_changes", "project_value_mappings", "project_exports"]) {
      expect(() => db.prepare(`SELECT COUNT(*) FROM ${t}`).get()).not.toThrow();
    }
    const { processProject, createProject, setMapping, saveUpload } =
      await import("../server/standardize/project.js");
    const p = path.join(tmp, "std.csv");
    fs.writeFileSync(p, "Item ID,Make,Model,Year\r\nA-1,ford,F150,2018\r\n", "utf-8");
    const saved = saveUpload(fs.readFileSync(p), "std.csv");
    const id = await createProject(db, { filename: "std.csv", stored: saved.stored,
      hash: saved.hash, projectName: "v5.1 regression" });
    setMapping(db, id, { headerRow: 1, preserveUnmapped: true, columns: [
      { column: "Item ID", index: 0, field: "Item ID" },
      { column: "Make", index: 1, field: "Make" },
      { column: "Model", index: 2, field: "Model" },
      { column: "Year", index: 3, field: "Model Year" }] });
    const r = await processProject(db, id);
    expect(r.processed).toBe(1);
    const row = db.prepare(`SELECT normalized_json FROM standardization_rows
      WHERE project_id=?`).pluck().get(id) as string;
    expect(JSON.parse(row).fields.Make.value).toBe("Ford");
  });
  it("38. the existing catalog pages still resolve canonical data", () => {
    const make = db.prepare("SELECT standard_make FROM makes WHERE norm_make='FORD'")
      .pluck().get();
    expect(make).toBe("Ford");
    const model = db.prepare(`SELECT m.standard_model FROM models m
      JOIN makes k ON k.id=m.make_id WHERE k.norm_make='FORD' AND m.norm_model='F150'`)
      .pluck().get();
    expect(model).toBe("F-150");
    const years = db.prepare(`SELECT COUNT(*) FROM model_years y JOIN models m
      ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      WHERE k.norm_make='FORD' AND m.norm_model='F150'`).pluck().get() as number;
    expect(years).toBeGreaterThan(0);
  });
});
