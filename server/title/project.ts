/**
 * Title Optimizer project lifecycle: create, map, process, decide.
 *
 * Rows are streamed and written in batches so a 100,000-row file never lands in
 * memory at once. Only the title is ever computed; every other source value is
 * stored verbatim in `source_json` and returned unchanged at export time.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { previewFile, streamRows } from "../standardize/parse.js";
import { newStorageId, resolveInside, sanitizeDisplayName, storageFilename }
  from "../security/filenames.js";
import { UPLOAD_DIR } from "../db.js";
import { createCanonicalLookup } from "./canonical.js";
import {
  optimizeTitle, revalidateTitle, type Abbreviation, type OptimizeResult,
  type TitleFields, type TitleStatus,
} from "./optimizer.js";
import { titleLength } from "./text.js";

/** Fields the optimizer understands. Only Title is mandatory. */
export const TITLE_FIELDS = ["Title", "Year", "Year Range", "Make", "Model",
  "Sub-model", "Trim", "Material", "Color", "Variation", "Product Type",
  "Position", "Side", "Row", "Quantity", "Fitment", "Item ID", "SKU", "Other"];

export interface TitleColumnMapping {
  headerRow: number;
  columns: { column: string; index: number; field: string }[];
}

export function saveTitleUpload(buffer: Buffer, filename: string) {
  const displayName = sanitizeDisplayName(filename);
  const ext = (displayName.match(/\.[^.]+$/)?.[0] ?? ".bin").toLowerCase();
  const storageId = newStorageId();
  const stored = resolveInside(UPLOAD_DIR, storageFilename(storageId, ext));
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(stored, buffer);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return { stored, hash, storageId, displayName };
}

export async function createTitleProject(db: Database.Database, opts: {
  filename: string; stored: string; hash: string; projectName?: string;
  worksheetName?: string; headerRow?: number; storageId?: string;
  sourceProjectId?: number; maxCharacters?: number;
}): Promise<number> {
  const preview = await previewFile(opts.stored, {
    worksheetName: opts.worksheetName, headerRow: opts.headerRow ?? 1 });
  const displayName = sanitizeDisplayName(opts.filename);
  const info = db.prepare(`INSERT INTO title_optimization_projects
    (project_name, input_filename, display_filename, input_file_hash, input_format,
     worksheet_name, storage_id, stored_path, source_project_id, row_count,
     column_count, header_row, encoding, max_characters, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Uploaded')`)
    .run(opts.projectName ?? displayName, displayName, displayName, opts.hash,
      preview.format, preview.worksheetName ?? null, opts.storageId ?? null,
      opts.stored, opts.sourceProjectId ?? null, preview.rowCount,
      preview.columnCount, opts.headerRow ?? 1, preview.encoding ?? null,
      opts.maxCharacters ?? loadConfig().title?.maxCharacters ?? 80);
  return Number(info.lastInsertRowid);
}

export function setTitleMapping(db: Database.Database, projectId: number,
  mapping: TitleColumnMapping): void {
  const hasTitle = mapping.columns.some((c) => c.field === "Title");
  if (!hasTitle) throw new Error("A Title column must be mapped before processing.");
  db.prepare(`UPDATE title_optimization_projects
    SET mapping_json=?, header_row=?, status='Mapped', updated_at=datetime('now')
    WHERE id=?`).run(JSON.stringify(mapping), mapping.headerRow, projectId);
}

export function getTitleProject(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM title_optimization_projects WHERE id=?")
    .get(id) as Record<string, unknown> | undefined;
}

/** Approved abbreviations: project-specific entries override the global ones. */
export function loadAbbreviations(db: Database.Database, projectId: number | null)
  : Abbreviation[] {
  const rows = db.prepare(`SELECT full_value, abbreviated_value, applicable_field,
    minimum_characters_saved, ambiguity_risk, approval_status, project_id
    FROM title_abbreviation_mappings
    WHERE project_id IS NULL OR project_id = ?
    ORDER BY project_id IS NULL, full_value`).all(projectId ?? -1) as Record<string, any>[];
  const byKey = new Map<string, Abbreviation>();
  for (const r of rows) {
    const key = `${String(r.full_value).toLowerCase()}|${r.applicable_field}`;
    // project rows come first, so only fill gaps from the global catalog
    if (!byKey.has(key)) {
      byKey.set(key, {
        full: r.full_value, abbreviated: r.abbreviated_value,
        applicableField: r.applicable_field,
        minimumCharactersSaved: r.minimum_characters_saved,
        ambiguityRisk: r.ambiguity_risk, approvalStatus: r.approval_status,
      });
    }
  }
  return [...byKey.values()];
}

export function loadEnabledRules(db: Database.Database, projectId: number | null)
  : Set<string> {
  const rows = db.prepare(`SELECT rule_id, enabled, project_id FROM title_rules
    WHERE project_id IS NULL OR project_id = ?
    ORDER BY project_id IS NULL`).all(projectId ?? -1) as
    { rule_id: string; enabled: number; project_id: number | null }[];
  const seen = new Set<string>();
  const enabled = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.rule_id)) continue;      // project override already applied
    seen.add(r.rule_id);
    if (r.enabled) enabled.add(r.rule_id);
  }
  return enabled;
}

export function loadTemplate(db: Database.Database, templateId: number | null) {
  if (!templateId) return null;
  const t = db.prepare("SELECT * FROM title_templates WHERE id=?")
    .get(templateId) as Record<string, any> | undefined;
  if (!t) return null;
  return {
    id: t.id as number,
    name: t.name as string,
    pattern: t.pattern as string,
    required: JSON.parse(t.required_fields || "[]") as string[],
    optional: JSON.parse(t.optional_fields || "[]") as string[],
    priority: JSON.parse(t.field_priority || "[]") as string[],
  };
}

export interface ProcessOptions {
  templateId?: number | null;
  onProgress?: (processed: number, total: number) => void;
  signal?: { cancelled: boolean };
}

export interface ProcessResult {
  processed: number;
  byStatus: Record<string, number>;
}

/** Runs the optimizer across every row of a mapped project. */
export async function processTitleProject(db: Database.Database, projectId: number,
  opts: ProcessOptions = {}): Promise<ProcessResult> {
  const project = getTitleProject(db, projectId);
  if (!project) throw new Error(`Title project ${projectId} not found`);
  const mapping = JSON.parse(String(project.mapping_json ?? "null")) as
    TitleColumnMapping | null;
  if (!mapping) throw new Error("Map a Title column before processing.");

  const cfg = loadConfig();
  const batchSize = cfg.processing?.batchSize ?? 1000;
  const max = Number(project.max_characters ?? 80);
  const templateId = opts.templateId ?? (project.template_id as number | null) ?? null;
  const template = loadTemplate(db, templateId);
  const abbreviations = loadAbbreviations(db, projectId);
  const enabledRules = loadEnabledRules(db, projectId);
  const canonical = createCanonicalLookup(db);

  db.prepare(`UPDATE title_optimization_projects SET status='Processing',
    processed_rows=0, cancel_requested=0, last_progress_at=datetime('now'),
    updated_at=datetime('now') WHERE id=?`).run(projectId);
  db.prepare("DELETE FROM title_optimization_changes WHERE project_id=?").run(projectId);
  db.prepare("DELETE FROM title_optimization_rows WHERE project_id=?").run(projectId);

  const insertRow = db.prepare(`INSERT INTO title_optimization_rows
    (project_id, row_number, source_json, original_title, original_length,
     proposed_title, proposed_length, final_title, final_length, characters_removed,
     applied_rules, removed_information, preserved_information, validation_warnings,
     title_status, template_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertChange = db.prepare(`INSERT INTO title_optimization_changes
    (project_id, row_id, row_number, stage, rule_id, rule_name, before_value,
     after_value, characters_saved, removed_phrase)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  const byStatus: Record<string, number> = {};
  let processed = 0;
  let batch: { fields: TitleFields; source: Record<string, string>;
    result: OptimizeResult }[] = [];

  const flush = db.transaction((items: typeof batch) => {
    for (const item of items) {
      processed++;
      const r = item.result;
      const info = insertRow.run(projectId, processed, JSON.stringify(item.source),
        r.originalTitle, r.originalLength, r.proposedTitle, r.proposedLength,
        r.proposedTitle, r.proposedLength, r.charactersRemoved,
        JSON.stringify(r.appliedRules.map((a) => a.ruleId)),
        JSON.stringify(r.removedInformation), JSON.stringify(r.preservedInformation),
        JSON.stringify(r.validationWarnings), r.status, templateId);
      const rowId = Number(info.lastInsertRowid);
      for (const a of r.appliedRules) {
        insertChange.run(projectId, rowId, processed, a.stage, a.ruleId, a.ruleName,
          a.before, a.after, a.charactersSaved, a.removedPhrase ?? null);
      }
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }
  });

  // Headers come from the preview so the stored source_json keeps the original
  // column names; streamRows itself yields data rows only.
  const stored = String(project.stored_path);
  const preview = await previewFile(stored, {
    worksheetName: (project.worksheet_name as string) ?? undefined,
    headerRow: mapping.headerRow, previewRows: 1 });
  const headers = preview.rawHeaderRow.length ? preview.rawHeaderRow : preview.headers;
  const mapped = mapping.columns.filter((c) => c.field
    && c.field !== "Preserve as Custom Field");

  await streamRows(stored, {
    worksheetName: (project.worksheet_name as string) ?? undefined,
    headerRow: mapping.headerRow,
    batchSize,
    shouldCancel: () => opts.signal?.cancelled === true,
    onBatch: (rows) => {
      for (const values of rows) {
        const source: Record<string, string> = {};
        headers.forEach((h, i) => { source[h] = values[i] ?? ""; });
        const fields: TitleFields = {};
        for (const c of mapped) fields[c.field] = values[c.index] ?? "";
        batch.push({ fields, source,
          result: optimizeTitle(fields, { maxCharacters: max, abbreviations,
            enabledRules, canonical, template }) });
      }
      flush(batch);
      batch = [];
      db.prepare(`UPDATE title_optimization_projects SET processed_rows=?,
        last_progress_at=datetime('now') WHERE id=?`).run(processed, projectId);
      opts.onProgress?.(processed, Number(project.row_count ?? 0));
    },
  });
  if (batch.length) flush(batch);

  const needsReview = (byStatus["Manual Review Required"] ?? 0)
    + (byStatus["Unable to Reach Limit"] ?? 0);
  db.prepare(`UPDATE title_optimization_projects
    SET status=?, processed_rows=?, completed_at=datetime('now'),
        updated_at=datetime('now'), template_id=? WHERE id=?`)
    .run(needsReview > 0 ? "Review Required" : "Ready to Export", processed,
      templateId, projectId);

  return { processed, byStatus };
}

export interface TitleDecision {
  rowNumber: number;
  decision: "Accept Proposed Title" | "Keep Original Title" | "Edit Proposed Title"
    | "Regenerate Using Different Template" | "Exclude From Export";
  editedTitle?: string;
  templateId?: number;
  notes?: string;
}

/** Records a user decision, revalidating any manual edit before accepting it. */
export function applyTitleDecision(db: Database.Database, projectId: number,
  d: TitleDecision) {
  const row = db.prepare(`SELECT * FROM title_optimization_rows
    WHERE project_id=? AND row_number=?`).get(projectId, d.rowNumber) as
    Record<string, any> | undefined;
  if (!row) throw new Error(`Row ${d.rowNumber} not found in project ${projectId}`);

  const project = getTitleProject(db, projectId)!;
  const max = Number(project.max_characters ?? 80);
  const source = JSON.parse(String(row.source_json ?? "{}")) as Record<string, string>;
  const mapping = JSON.parse(String(project.mapping_json ?? "null")) as
    TitleColumnMapping | null;
  const fields: TitleFields = { Title: String(row.original_title) };
  if (mapping) {
    const headers = Object.keys(source);
    for (const c of mapping.columns) {
      if (c.field === "Preserve as Custom Field" || !c.field) continue;
      fields[c.field] = source[headers[c.index]] ?? "";
    }
    fields.Title = String(row.original_title);
  }

  let finalTitle = String(row.proposed_title ?? row.original_title);
  let status = String(row.title_status) as TitleStatus;
  let warnings: string[] = JSON.parse(String(row.validation_warnings ?? "[]"));
  let excluded = 0;
  let manuallyEdited = 0;

  if (d.decision === "Keep Original Title") {
    finalTitle = String(row.original_title);
    // An unresolved blocking warning (a Make-Model conflict, for instance) still
    // needs human attention, so keeping the original must not clear it.
    const blocking = warnings.some((w) => /conflict|not a canonical/i.test(w));
    status = titleLength(finalTitle) > max ? "Unable to Reach Limit"
      : blocking ? "Manual Review Required"
      : "Already Within Limit";
  } else if (d.decision === "Edit Proposed Title") {
    const edited = String(d.editedTitle ?? "");
    // A manual edit is revalidated before it can be approved.
    const v = revalidateTitle(edited, fields, { maxCharacters: max });
    finalTitle = edited;
    status = v.status;
    warnings = v.warnings;
    manuallyEdited = 1;
  } else if (d.decision === "Exclude From Export") {
    excluded = 1;
    status = "Excluded";
  } else if (d.decision === "Regenerate Using Different Template") {
    const template = loadTemplate(db, d.templateId ?? null);
    const r = optimizeTitle(fields, {
      maxCharacters: max,
      abbreviations: loadAbbreviations(db, projectId),
      enabledRules: loadEnabledRules(db, projectId),
      canonical: createCanonicalLookup(db),
      template,
    });
    finalTitle = r.proposedTitle;
    status = r.status;
    warnings = r.validationWarnings;
    db.prepare(`UPDATE title_optimization_rows SET proposed_title=?, proposed_length=?,
      applied_rules=?, removed_information=?, template_id=? WHERE id=?`)
      .run(r.proposedTitle, r.proposedLength,
        JSON.stringify(r.appliedRules.map((a) => a.ruleId)),
        JSON.stringify(r.removedInformation), d.templateId ?? null, row.id);
  }

  const finalLength = titleLength(finalTitle);
  db.prepare(`UPDATE title_optimization_rows
    SET final_title=?, final_length=?, characters_removed=?, title_status=?,
        user_decision=?, manually_edited=?, excluded=?, validation_warnings=?, notes=?
    WHERE id=?`)
    .run(finalTitle, finalLength,
      Math.max(0, Number(row.original_length) - finalLength), status, d.decision,
      manuallyEdited, excluded, JSON.stringify(warnings), d.notes ?? null, row.id);

  db.prepare(`INSERT INTO title_manual_decisions
    (project_id, row_id, row_number, decision, original_title, proposed_title,
     final_title, final_length, validation_result, template_id, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(projectId, row.id, d.rowNumber, d.decision, row.original_title,
      row.proposed_title, finalTitle, finalLength,
      JSON.stringify({ status, warnings }), d.templateId ?? null, d.notes ?? null);

  return { rowNumber: d.rowNumber, finalTitle, finalLength, status, warnings };
}

/** Accepts every row already inside the limit. */
export function approveAllWithinLimit(db: Database.Database, projectId: number) {
  const rows = db.prepare(`SELECT row_number FROM title_optimization_rows
    WHERE project_id=? AND excluded=0 AND user_decision IS NULL
      AND title_status IN ('Already Within Limit','Optimized')`)
    .pluck().all(projectId) as number[];
  const tx = db.transaction(() => {
    for (const rowNumber of rows) {
      applyTitleDecision(db, projectId, { rowNumber,
        decision: "Accept Proposed Title", notes: "Batch approval: within limit" });
    }
  });
  tx();
  return { approved: rows.length };
}

/** Applies one row's decision to every row whose original title matches. */
export function applyToSimilar(db: Database.Database, projectId: number,
  rowNumber: number) {
  const row = db.prepare(`SELECT original_title, final_title, user_decision
    FROM title_optimization_rows WHERE project_id=? AND row_number=?`)
    .get(projectId, rowNumber) as Record<string, any> | undefined;
  if (!row) throw new Error(`Row ${rowNumber} not found`);
  const similar = db.prepare(`SELECT row_number FROM title_optimization_rows
    WHERE project_id=? AND original_title=? AND row_number<>? AND excluded=0`)
    .pluck().all(projectId, row.original_title, rowNumber) as number[];
  const tx = db.transaction(() => {
    for (const rn of similar) {
      applyTitleDecision(db, projectId, { rowNumber: rn,
        decision: "Edit Proposed Title", editedTitle: String(row.final_title),
        notes: `Applied from row ${rowNumber}` });
    }
  });
  tx();
  return { applied: similar.length };
}

export function titleProjectStats(db: Database.Database, projectId: number) {
  const s = db.prepare(`SELECT
      COUNT(*) inputRows,
      SUM(CASE WHEN excluded=1 THEN 1 ELSE 0 END) excluded,
      SUM(CASE WHEN title_status='Already Within Limit' THEN 1 ELSE 0 END) withinLimit,
      SUM(CASE WHEN title_status IN ('Optimized','Optimized with Warning')
          THEN 1 ELSE 0 END) optimized,
      SUM(CASE WHEN title_status='Manual Review Required' THEN 1 ELSE 0 END) manualReview,
      SUM(CASE WHEN title_status='Unable to Reach Limit' THEN 1 ELSE 0 END) unableToReach,
      SUM(characters_removed) totalCharactersRemoved,
      AVG(original_length) avgOriginalLength,
      AVG(COALESCE(final_length, proposed_length)) avgOptimizedLength,
      MAX(original_length) maxOriginalLength,
      MAX(COALESCE(final_length, proposed_length)) maxOptimizedLength
    FROM title_optimization_rows WHERE project_id=?`).get(projectId) as
    Record<string, number>;
  return {
    inputRows: s.inputRows ?? 0,
    excluded: s.excluded ?? 0,
    withinLimit: s.withinLimit ?? 0,
    optimized: s.optimized ?? 0,
    manualReview: s.manualReview ?? 0,
    unableToReach: s.unableToReach ?? 0,
    totalCharactersRemoved: s.totalCharactersRemoved ?? 0,
    avgOriginalLength: Number((s.avgOriginalLength ?? 0).toFixed(1)),
    avgOptimizedLength: Number((s.avgOptimizedLength ?? 0).toFixed(1)),
    maxOriginalLength: s.maxOriginalLength ?? 0,
    maxOptimizedLength: s.maxOptimizedLength ?? 0,
  };
}
