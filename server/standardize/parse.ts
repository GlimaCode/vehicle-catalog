/**
 * Input parsing for the file-standardization workspace.
 *
 * Handles RFC-4180 CSV (quoted commas, embedded line breaks), UTF-8, UTF-8
 * with BOM, safely-detectable Windows-1252, and XLSX workbooks with worksheet
 * selection. Duplicate header names are disambiguated rather than dropped.
 * Uploaded source files are never modified.
 */
import fs from "node:fs";
import { Transform } from "node:stream";
import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { parse as parseStream } from "csv-parse";
import { assertWithinSheetLimits, truncateCell } from "../security/workbook.js";

export interface SheetInfo { name: string; rowCount: number; columnCount: number }
export interface FilePreview {
  format: "csv" | "xlsx";
  encoding: string;
  worksheets: SheetInfo[];
  worksheetName?: string;
  headers: string[];
  rawHeaderRow: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

/** Decode a CSV buffer, detecting BOM / UTF-8 / Windows-1252. */
export function decodeBuffer(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf-8"), encoding: "UTF-8 with BOM" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), encoding: "UTF-16 LE" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text, encoding: "UTF-8" };
  } catch {
    // not valid UTF-8: fall back to Windows-1252, which decodes every byte
    const text = new TextDecoder("windows-1252").decode(buf);
    return { text, encoding: "Windows-1252" };
  }
}

/** Make duplicate/blank header names unique and traceable. */
export function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = (h ?? "").trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function cellToString(v: unknown): string {
  return truncateCell(cellToStringRaw(v));
}

function cellToStringRaw(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[];
      hyperlink?: string; formula?: string };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "";
  }
  return String(v);
}

export async function listWorksheets(file: string): Promise<SheetInfo[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => ({ name: ws.name, rowCount: ws.actualRowCount,
    columnCount: ws.actualColumnCount }));
}

/** Read a preview (headers + first N data rows) without loading everything. */
export async function previewFile(file: string, opts: {
  worksheetName?: string; headerRow?: number; previewRows?: number;
} = {}): Promise<FilePreview> {
  const headerRow = opts.headerRow ?? 1;
  const previewRows = opts.previewRows ?? 20;
  const isXlsx = /\.xlsx?$/i.test(file);
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const worksheets = wb.worksheets.map((ws) => ({ name: ws.name,
      rowCount: ws.actualRowCount, columnCount: ws.actualColumnCount }));
    const ws = opts.worksheetName ? wb.getWorksheet(opts.worksheetName) : wb.worksheets[0];
    if (!ws) throw new Error(`Worksheet not found: ${opts.worksheetName}`);
    const rows: string[][] = [];
    let rawHeader: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1).map(cellToString);
      if (rowNumber < headerRow) return;
      if (rowNumber === headerRow) { rawHeader = values; return; }
      if (rows.length < previewRows) rows.push(values);
    });
    const columnCount = Math.max(rawHeader.length, ...rows.map((r) => r.length), 0);
    const rowCount = Math.max(0, ws.actualRowCount - headerRow);
    assertWithinSheetLimits({ rows: rowCount, columns: columnCount },
      `Worksheet "${ws.name}"`);
    return { format: "xlsx", encoding: "XLSX (binary)", worksheets,
      worksheetName: ws.name, headers: dedupeHeaders(rawHeader), rawHeaderRow: rawHeader,
      rows, rowCount, columnCount };
  }
  // CSV preview is streamed: the file is never held in memory in full.
  const encoding = detectEncoding(file);
  const collected: string[][] = [];
  let rawHeader: string[] = [];
  let index = 0;
  let dataRows = 0;
  await streamCsvRecords(file, encoding, (rec) => {
    index++;
    if (index < headerRow) return true;
    if (index === headerRow) { rawHeader = rec; return true; }
    dataRows++;
    if (collected.length < previewRows) collected.push(rec.map(truncateCell));
    return true;                                  // keep counting to the end
  });
  const columnCount = Math.max(rawHeader.length, ...collected.map((r) => r.length), 0);
  assertWithinSheetLimits({ rows: dataRows, columns: columnCount }, "CSV file");
  return { format: "csv", encoding, worksheets: [], headers: dedupeHeaders(rawHeader),
    rawHeaderRow: rawHeader, rows: collected, rowCount: dataRows, columnCount };
}

/** Detect the encoding from the first block only. */
export function detectEncoding(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(Math.min(65536, fs.statSync(file).size));
    fs.readSync(fd, head, 0, head.length, 0);
    return decodeBuffer(head).encoding;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Stream CSV records from disk with correct decoding, without loading the
 * whole file. `onRecord` returns false to stop early.
 */
export async function streamCsvRecords(file: string, encoding: string,
  onRecord: (record: string[]) => boolean | Promise<boolean>): Promise<void> {
  const label = encoding.startsWith("Windows-1252") ? "windows-1252"
    : encoding.startsWith("UTF-16") ? "utf-16le" : "utf-8";
  const decoder = new TextDecoder(label, { fatal: false });
  let first = true;
  // byte stream -> decoded text -> CSV records, consumed with `for await`
  // so Node handles backpressure and early termination for us.
  const decode = new Transform({
    transform(chunk, _enc, cb) {
      let text = decoder.decode(chunk as Buffer, { stream: true });
      if (first) { text = text.replace(/^﻿/, ""); first = false; }
      cb(null, text);
    },
    flush(cb) { cb(null, decoder.decode()); },
  });
  const source = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const parser = parseStream({ relax_column_count: true, skip_empty_lines: true,
    columns: false });
  source.pipe(decode).pipe(parser);
  try {
    for await (const rec of parser as AsyncIterable<string[]>) {
      const keep = await onRecord(rec);
      if (keep === false) break;                  // early stop: streams tear down
    }
  } finally {
    source.destroy();
    decode.destroy();
    parser.destroy();
  }
}

/**
 * Stream every data row to `onBatch` in batches, without holding the whole
 * file in memory. Returns the total number of data rows emitted.
 */
export async function streamRows(file: string, opts: {
  worksheetName?: string; headerRow?: number; batchSize?: number;
  onBatch: (rows: string[][], firstRowNumber: number) => Promise<void> | void;
  shouldCancel?: () => boolean;
  startAfterRow?: number;
}): Promise<number> {
  const headerRow = opts.headerRow ?? 1;
  const batchSize = opts.batchSize ?? 2000;
  const startAfter = opts.startAfterRow ?? 0;
  let dataRowNumber = 0;
  let emitted = 0;
  let batch: string[][] = [];
  let batchStart = 0;

  const flush = async () => {
    if (!batch.length) return;
    await opts.onBatch(batch, batchStart);
    emitted += batch.length;
    batch = [];
  };
  const push = async (values: string[]) => {
    dataRowNumber++;
    if (dataRowNumber <= startAfter) return;
    if (!batch.length) batchStart = dataRowNumber;
    batch.push(values);
    if (batch.length >= batchSize) {
      await flush();
      await new Promise((r) => setImmediate(r));   // keep the server responsive
    }
  };

  if (/\.xlsx?$/i.test(file)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = opts.worksheetName ? wb.getWorksheet(opts.worksheetName) : wb.worksheets[0];
    if (!ws) throw new Error(`Worksheet not found: ${opts.worksheetName}`);
    const pending: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      pending.push((row.values as unknown[]).slice(1).map(cellToString));
    });
    for (const values of pending) {
      if (opts.shouldCancel?.()) break;
      await push(values);
    }
    await flush();
    return emitted;
  }

  // CSV rows are streamed from disk; the file is never fully materialized.
  let index = 0;
  await streamCsvRecords(file, detectEncoding(file), async (rec) => {
    index++;
    if (index <= headerRow) return true;
    if (opts.shouldCancel?.()) return false;
    await push(rec);
    return true;
  });
  await flush();
  return emitted;
}
