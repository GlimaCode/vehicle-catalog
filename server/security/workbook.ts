/**
 * Untrusted upload inspection.
 *
 * Every uploaded file is treated as hostile until inspected. XLSX files are
 * ZIP containers, so before any parser touches them we read the ZIP central
 * directory ourselves and enforce configured limits: entry count, expansion
 * size, compression ratio (zip bombs), worksheet count, shared-string size,
 * macro content, external links, and unsafe entry names (path traversal,
 * absolute paths, symlink-style names).
 *
 * Nothing in an uploaded workbook is ever executed: no VBA, no external
 * workbook links, no embedded objects, no DDE, no formulas, no scripts. The
 * reader only extracts cell *values*.
 */
import fs from "node:fs";
import { loadConfig } from "../config.js";

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}
export interface InspectionResult {
  ok: boolean;
  detectedType: "zip/xlsx" | "ole2/xls" | "text" | "unknown";
  reasons: string[];
  warnings: string[];
  entries: number;
  worksheets: number;
  totalUncompressed: number;
  maxCompressionRatio: number;
  hasMacros: boolean;
  hasExternalLinks: boolean;
}

export class UnsafeFileError extends Error {
  constructor(message: string, readonly details: InspectionResult) {
    super(message);
    this.name = "UnsafeFileError";
  }
}

export function detectFileType(buf: Buffer): InspectionResult["detectedType"] {
  if (buf.length >= 4) {
    if (buf[0] === 0x50 && buf[1] === 0x4b
      && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return "zip/xlsx";
    if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
      return "ole2/xls";
    }
  }
  // treat as text when the first block decodes without NUL bytes
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (!head.includes(0)) return "text";
  return "unknown";
}

/** Read ZIP central-directory entries without decompressing anything. */
export function readZipCentralDirectory(buf: Buffer): ZipEntry[] {
  const EOCD_SIG = 0x06054b50;
  const CEN_SIG = 0x02014b50;
  let eocd = -1;
  const start = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a readable ZIP container (no end-of-central-directory)");
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  // ZIP64 fallback: scan for central-directory signatures
  if (offset === 0xffffffff || count === 0xffff) {
    const entries: ZipEntry[] = [];
    for (let i = 0; i < buf.length - 46; i++) {
      if (buf.readUInt32LE(i) !== CEN_SIG) continue;
      const nameLen = buf.readUInt16LE(i + 28);
      entries.push({
        name: buf.subarray(i + 46, i + 46 + nameLen).toString("utf-8"),
        compressedSize: buf.readUInt32LE(i + 20),
        uncompressedSize: buf.readUInt32LE(i + 24),
      });
    }
    return entries;
  }
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    entries.push({
      name: buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf-8"),
      compressedSize: buf.readUInt32LE(offset + 20),
      uncompressedSize: buf.readUInt32LE(offset + 24),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryNameIsUnsafe(name: string): boolean {
  if (!name) return true;
  if (name.includes("\\")) return true;                 // Windows separator in ZIP
  if (name.startsWith("/")) return true;                // absolute path
  if (/^[a-zA-Z]:/.test(name)) return true;             // drive-letter path
  if (name.split("/").some((p) => p === "..")) return true;
  if (name.includes("\0")) return true;
  return false;
}

/** Inspect an uploaded buffer against the configured limits. */
export function inspectUpload(buf: Buffer, filename: string): InspectionResult {
  const cfg = loadConfig();
  const ext = (filename.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  const detectedType = detectFileType(buf);
  const result: InspectionResult = {
    ok: true, detectedType, reasons: [], warnings: [], entries: 0, worksheets: 0,
    totalUncompressed: 0, maxCompressionRatio: 0, hasMacros: false,
    hasExternalLinks: false,
  };

  if (buf.length > cfg.upload.maxFileBytes) {
    result.reasons.push(`File is ${buf.length} bytes, above the configured limit of `
      + `${cfg.upload.maxFileBytes} bytes`);
  }
  if (!cfg.upload.allowedExtensions.includes(ext)) {
    result.reasons.push(`Extension "${ext || "(none)"}" is not in the allowed list `
      + `(${cfg.upload.allowedExtensions.join(", ")})`);
  }
  if (/\.(xlsm|xltm|xlsb|xls)$/i.test(filename) && !cfg.upload.allowMacroEnabledWorkbooks) {
    result.reasons.push("Macro-enabled or legacy binary workbooks are not accepted "
      + "(.xlsm/.xltm/.xlsb/.xls)");
  }

  const looksXlsx = ext === ".xlsx";
  const looksText = ext === ".csv" || ext === ".txt";

  // extension vs signature mismatch
  if (looksXlsx && detectedType !== "zip/xlsx") {
    result.reasons.push(`File claims to be .xlsx but its signature is ${detectedType}`);
  }
  if (looksText && detectedType === "zip/xlsx") {
    result.reasons.push("File claims to be CSV/text but its signature is a ZIP container");
  }
  if (looksText && detectedType === "ole2/xls") {
    result.reasons.push("File claims to be CSV/text but its signature is a legacy Excel file");
  }
  if (detectedType === "unknown" && looksText) {
    result.warnings.push("Binary-looking content in a text upload; parsing may fail");
  }

  if (detectedType === "zip/xlsx") {
    let entries: ZipEntry[] = [];
    try {
      entries = readZipCentralDirectory(buf);
    } catch (e) {
      result.reasons.push(`Malformed workbook container: ${String(e)}`);
    }
    result.entries = entries.length;
    if (entries.length > cfg.workbook.maxZipEntries) {
      result.reasons.push(`Workbook contains ${entries.length} entries, above the limit `
        + `of ${cfg.workbook.maxZipEntries}`);
    }
    let total = 0;
    let worstRatio = 0;
    for (const e of entries) {
      total += e.uncompressedSize;
      const ratio = e.compressedSize > 0 ? e.uncompressedSize / e.compressedSize : 0;
      if (ratio > worstRatio) worstRatio = ratio;
      if (entryNameIsUnsafe(e.name)) {
        result.reasons.push(`Unsafe entry name inside the workbook: "${e.name}"`);
      }
      if (/vbaProject\.bin$/i.test(e.name) || /\/macro/i.test(e.name)) {
        result.hasMacros = true;
      }
      if (/^xl\/externalLinks\//i.test(e.name)) result.hasExternalLinks = true;
      if (/sharedStrings\.xml$/i.test(e.name)
        && e.uncompressedSize > cfg.workbook.maxSharedStringBytes) {
        result.reasons.push(`Shared-string table is ${e.uncompressedSize} bytes, above `
          + `the limit of ${cfg.workbook.maxSharedStringBytes}`);
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(e.name)) result.worksheets++;
    }
    result.totalUncompressed = total;
    result.maxCompressionRatio = Number(worstRatio.toFixed(1));
    if (total > cfg.workbook.maxTotalUncompressedBytes) {
      result.reasons.push(`Workbook expands to ${total} bytes, above the limit of `
        + `${cfg.workbook.maxTotalUncompressedBytes} (possible ZIP bomb)`);
    }
    if (worstRatio > cfg.workbook.maxCompressionRatio) {
      result.reasons.push(`Compression ratio ${worstRatio.toFixed(1)}:1 exceeds the limit `
        + `of ${cfg.workbook.maxCompressionRatio}:1 (possible ZIP bomb)`);
    }
    if (result.worksheets > cfg.workbook.maxWorksheets) {
      result.reasons.push(`Workbook has ${result.worksheets} worksheets, above the limit `
        + `of ${cfg.workbook.maxWorksheets}`);
    }
    if (result.hasMacros && !cfg.upload.allowMacroEnabledWorkbooks) {
      result.reasons.push("Workbook contains macro content (vbaProject.bin) and is rejected");
    }
    if (result.hasExternalLinks) {
      result.warnings.push("Workbook declares external links; they are never followed "
        + "or evaluated (values only)");
    }
  }

  result.ok = result.reasons.length === 0;
  return result;
}

export function assertSafeUpload(buf: Buffer, filename: string): InspectionResult {
  const r = inspectUpload(buf, filename);
  if (!r.ok) {
    throw new UnsafeFileError(`Upload rejected: ${r.reasons.join("; ")}`, r);
  }
  return r;
}

/** Post-parse limits (rows/columns/cells/cell length) for any tabular source. */
export function assertWithinSheetLimits(info: { rows: number; columns: number },
  context = "worksheet"): void {
  const cfg = loadConfig();
  if (info.rows > cfg.workbook.maxRows) {
    throw new Error(`${context} has ${info.rows} rows, above the configured limit of `
      + `${cfg.workbook.maxRows}`);
  }
  if (info.columns > cfg.workbook.maxColumns) {
    throw new Error(`${context} has ${info.columns} columns, above the configured limit `
      + `of ${cfg.workbook.maxColumns}`);
  }
  const cells = info.rows * info.columns;
  if (cells > cfg.workbook.maxCells) {
    throw new Error(`${context} has ${cells} cells, above the configured limit of `
      + `${cfg.workbook.maxCells}`);
  }
}

export function truncateCell(value: string): string {
  const max = loadConfig().workbook.maxCellLength;
  return value.length > max ? value.slice(0, max) : value;
}

export function inspectFileOnDisk(file: string, filename?: string): InspectionResult {
  return inspectUpload(fs.readFileSync(file), filename ?? file);
}
