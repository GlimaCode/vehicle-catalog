/**
 * Standardization projects: upload -> map -> process -> review -> export.
 *
 * Processing runs in batches inside transactions, yielding to the event loop
 * between batches so the server stays responsive, and honouring cancellation
 * and resume. The canonical Version 4 catalog is only ever read.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { UPLOAD_DIR, norm } from "../db.js";
import { loadConfig } from "../config.js";
import { newStorageId, resolveInside, sanitizeDisplayName,
  storageFilename } from "../security/filenames.js";
import { writeFileAtomic } from "../security/atomic.js";
import { previewFile, streamRows, dedupeHeaders } from "./parse.js";
import { CanonicalResolver, AUTO_APPLY, validateYears, compressYears,
  type Confidence, type Resolution } from "./resolver.js";

export const CANONICAL_FIELDS = ["Make", "Model", "Sub-model", "Trim", "Series",
  "Edition", "Generation", "Chassis", "Model Year", "Year Range", "Engine",
  "Drivetrain", "Body Style", "Package", "Title", "Item ID", "SKU", "Other"] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export const HIERARCHY_FIELDS: CanonicalField[] = ["Sub-model", "Trim", "Series",
  "Edition", "Generation", "Chassis"];
export const CONFIG_FIELDS: Record<string, string> = {
  Engine: "Engine Variant", Drivetrain: "Drivetrain Variant",
  "Body Style": "Body Style", Package: "Package",
};
export const PASSTHROUGH_FIELDS: CanonicalField[] = ["Title", "Item ID", "SKU", "Other"];

export interface ColumnMapping {
  column: string; index: number;
  field: CanonicalField | "Ignore" | "Preserve as Custom Field";
  merge?: "concat" | "first-non-empty" | "range";
}
export interface ProjectMapping {
  headerRow: number;
  columns: ColumnMapping[];
  preserveUnmapped: boolean;
}

export interface NormalizedRow {
  fields: Record<string, {
    raw: string; value: string | null; confidence: Confidence; classification?: string;
    evidence?: string; conflict?: string; applied: boolean;
    alternatives?: { value: string; note?: string }[];
  }>;
  year?: { raw: string; normalized: string; status: string; note: string;
    invalidYears: number[] };
  reviewReasons: string[];
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Store an upload under an internally generated storage ID.
 * The uploaded filename is never used as a filesystem path; it is kept only as
 * display metadata. The write is confined to the uploads directory.
 */
export function saveUpload(buffer: Buffer, filename: string):
  { stored: string; hash: string; storageId: string; displayName: string } {
  const displayName = sanitizeDisplayName(filename);
  const ext = (displayName.match(/\.[^.]+$/)?.[0] ?? ".bin").toLowerCase();
  const storageId = newStorageId();
  const stored = resolveInside(UPLOAD_DIR, storageFilename(storageId, ext));
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileAtomic(stored, buffer);
  return { stored, hash: sha256(stored), storageId, displayName };
}

export async function createProject(db: Database.Database, opts: {
  filename: string; stored: string; hash: string; projectName?: string;
  worksheetName?: string; headerRow?: number; storageId?: string;
}): Promise<number> {
  const preview = await previewFile(opts.stored, {
    worksheetName: opts.worksheetName, headerRow: opts.headerRow ?? 1 });
  const displayName = sanitizeDisplayName(opts.filename);
  const info = db.prepare(`
    INSERT INTO standardization_projects (project_name, input_filename, input_file_hash,
      input_format, worksheet_name, row_count, column_count, status, encoding,
      header_row, stored_path, storage_id, display_filename, upload_sha256)
    VALUES (?,?,?,?,?,?,?,'Uploaded',?,?,?,?,?,?)`)
    .run(opts.projectName || displayName, displayName, opts.hash,
      preview.format, preview.worksheetName ?? null, preview.rowCount,
      preview.columnCount, preview.encoding, opts.headerRow ?? 1, opts.stored,
      opts.storageId ?? newStorageId(), displayName, opts.hash);
  return Number(info.lastInsertRowid);
}

export function getProject(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM standardization_projects WHERE id=?").get(id) as
    Record<string, unknown> | undefined;
}

export function setMapping(db: Database.Database, id: number, mapping: ProjectMapping,
  templateId?: number): void {
  db.prepare(`UPDATE standardization_projects SET mapping_json=?, header_row=?,
    mapping_template_id=?, status='Mapped', updated_at=datetime('now') WHERE id=?`)
    .run(JSON.stringify(mapping), mapping.headerRow ?? 1, templateId ?? null, id);
}

/** Collect the raw value of a canonical field from a source row. */
function fieldValue(mapping: ProjectMapping, values: string[], field: CanonicalField): string {
  const cols = mapping.columns.filter((c) => c.field === field);
  if (!cols.length) return "";
  const parts = cols.map((c) => (values[c.index] ?? "").trim()).filter(Boolean);
  if (!parts.length) return "";
  if (cols.length === 1) return parts[0];
  const merge = cols[0].merge ?? "first-non-empty";
  if (merge === "first-non-empty") return parts[0];
  if (merge === "range") return parts.length > 1 ? `${parts[0]}-${parts[parts.length - 1]}` : parts[0];
  return parts.join(" ");
}

export function normalizeRow(resolver: CanonicalResolver, mapping: ProjectMapping,
  values: string[], projectMappings: Map<string, { canonical: string | null;
    decision: string; classification?: string }>,
  autoApplyHigh: boolean): NormalizedRow {
  const out: NormalizedRow = { fields: {}, reviewReasons: [] };
  const pm = (field: string, raw: string, mk = "", md = "") =>
    projectMappings.get(`${field}|${norm(mk)}|${norm(md)}|${norm(raw)}`)
    ?? projectMappings.get(`${field}|||${norm(raw)}`);

  const record = (field: string, res: Resolution, forcedApplied?: boolean) => {
    const applied = forcedApplied ?? (AUTO_APPLY.includes(res.confidence)
      || (autoApplyHigh && res.confidence === "High Confidence Suggested Match"));
    out.fields[field] = { raw: res.raw, value: res.value, confidence: res.confidence,
      classification: res.classification, evidence: res.evidence, conflict: res.conflict,
      alternatives: res.alternatives, applied: applied && res.value != null };
    if (!applied || res.value == null) {
      if (res.raw.trim()) {
        out.reviewReasons.push(`${field}: ${res.conflict ?? res.confidence}`);
      }
    }
    return out.fields[field];
  };

  // ---- Make ----
  const rawMake = fieldValue(mapping, values, "Make");
  let make: string | null = null;
  if (rawMake) {
    const decided = pm("Make", rawMake);
    if (decided) {
      record("Make", { raw: rawMake, value: decided.canonical,
        confidence: "Approved Alias Match",
        evidence: `Project mapping decision (${decided.decision})` }, true);
      make = decided.canonical;
    } else {
      const res = resolver.resolveMake(rawMake);
      const f = record("Make", res);
      make = f.applied ? res.value : null;
    }
  }

  // ---- Model (inside the resolved Make when available) ----
  const rawModel = fieldValue(mapping, values, "Model");
  let model: string | null = null;
  if (rawModel) {
    const decided = pm("Model", rawModel, make ?? "");
    if (decided) {
      record("Model", { raw: rawModel, value: decided.canonical,
        confidence: "Approved Alias Match",
        evidence: `Project mapping decision (${decided.decision})` }, true);
      model = decided.canonical;
    } else {
      const res = resolver.resolveModel(rawModel, make);
      const f = record("Model", res);
      model = f.applied ? res.value : null;
    }
  }

  // ---- hierarchy fields (only inside resolved Make + Model) ----
  for (const field of HIERARCHY_FIELDS) {
    const raw = fieldValue(mapping, values, field);
    if (!raw) continue;
    const decided = pm(field, raw, make ?? "", model ?? "");
    if (decided) {
      record(field, { raw, value: decided.canonical, confidence: "Approved Alias Match",
        classification: decided.classification,
        evidence: `Project mapping decision (${decided.decision})` }, true);
      continue;
    }
    const res = resolver.resolveHierarchy(raw, make, model);
    // a value that is really a configuration attribute must be reported as such
    if (res.confidence === "No Match" && make && model) {
      const cfg = resolver.resolveConfiguration(raw, make, model);
      if (cfg.value) {
        record(field, { raw, value: null, confidence: "Conflict",
          classification: cfg.classification,
          conflict: `"${raw}" is a ${cfg.classification} (vehicle configuration), `
            + `not a ${field}`,
          evidence: cfg.evidence }, false);
        continue;
      }
    }
    record(field, res);
  }

  // ---- configuration fields ----
  for (const [field, expected] of Object.entries(CONFIG_FIELDS)) {
    const raw = fieldValue(mapping, values, field as CanonicalField);
    if (!raw) continue;
    const res = resolver.resolveConfiguration(raw, make, model, expected);
    record(field, res);
  }

  // ---- model years ----
  const rawYear = fieldValue(mapping, values, "Model Year")
    || fieldValue(mapping, values, "Year Range");
  if (rawYear) {
    const hierValue = HIERARCHY_FIELDS.map((f) => out.fields[f])
      .find((f) => f?.applied && f.value)?.value ?? null;
    const hierYears = resolver.hierarchyYears(make, model, hierValue);
    const modelYears = resolver.modelYears(make, model);
    const confirmed = hierYears ?? modelYears;
    const context = hierYears
      ? `${make} ${model} ${hierValue}`
      : modelYears ? `${make} ${model}` : "Make/Model not resolved";
    const yr = validateYears(rawYear, confirmed, context);
    out.year = { raw: rawYear, normalized: yr.normalized, status: yr.status,
      note: yr.note, invalidYears: yr.invalidYears };
    if (yr.status !== "Valid" && yr.status !== "Missing") {
      out.reviewReasons.push(`Model Year: ${yr.status}`);
    }
  }
  return out;
}

function loadProjectMappings(db: Database.Database, projectId: number) {
  const map = new Map<string, { canonical: string | null; decision: string;
    classification?: string }>();
  for (const r of db.prepare(`SELECT field_name, make_context, model_context,
    norm_raw_value, canonical_value, decision, canonical_classification
    FROM project_value_mappings WHERE project_id=?`).all(projectId) as {
      field_name: string; make_context: string; model_context: string;
      norm_raw_value: string; canonical_value: string | null; decision: string;
      canonical_classification: string | null }[]) {
    map.set(`${r.field_name}|${norm(r.make_context)}|${norm(r.model_context)}|${r.norm_raw_value}`,
      { canonical: r.canonical_value, decision: r.decision,
        classification: r.canonical_classification ?? undefined });
  }
  return map;
}

export async function processProject(db: Database.Database, projectId: number,
  opts: { resume?: boolean } = {}): Promise<{ processed: number; review: number;
    status: string; cancelled: boolean }> {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  if (!project.mapping_json) throw new Error("Project has no column mapping");
  const mapping = JSON.parse(String(project.mapping_json)) as ProjectMapping;
  const resolver = new CanonicalResolver(db);
  const projectMappings = loadProjectMappings(db, projectId);
  const autoHigh = Number(project.auto_apply_high_confidence) === 1;

  const startAfter = opts.resume ? Number(project.processed_rows) : 0;
  if (!opts.resume) {
    db.prepare("DELETE FROM standardization_changes WHERE project_id=?").run(projectId);
    db.prepare("DELETE FROM standardization_rows WHERE project_id=?").run(projectId);
  }
  db.prepare(`UPDATE standardization_projects SET status='Processing',
    cancel_requested=0, processed_rows=?, updated_at=datetime('now') WHERE id=?`)
    .run(startAfter, projectId);

  const preview = await previewFile(String(project.stored_path), {
    worksheetName: project.worksheet_name ? String(project.worksheet_name) : undefined,
    headerRow: Number(project.header_row), previewRows: 1 });
  const headers = dedupeHeaders(preview.rawHeaderRow);

  const insRow = db.prepare(`
    INSERT INTO standardization_rows (project_id, row_number, original_json,
      normalized_json, make_status, model_status, hierarchy_status, year_status,
      review_required, conflict_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id, row_number) DO UPDATE SET
      original_json=excluded.original_json, normalized_json=excluded.normalized_json,
      make_status=excluded.make_status, model_status=excluded.model_status,
      hierarchy_status=excluded.hierarchy_status, year_status=excluded.year_status,
      review_required=excluded.review_required, conflict_reason=excluded.conflict_reason`);
  const insChange = db.prepare(`
    INSERT INTO standardization_changes (project_id, row_number, field_name,
      original_value, new_value, change_source, confidence, notes)
    VALUES (?,?,?,?,?,?,?,?)`);

  let processed = startAfter;
  let cancelled = false;
  const checkCancel = () => {
    const row = db.prepare("SELECT cancel_requested FROM standardization_projects WHERE id=?")
      .get(projectId) as { cancel_requested: number };
    if (row.cancel_requested) cancelled = true;
    return cancelled;
  };

  await streamRows(String(project.stored_path), {
    worksheetName: project.worksheet_name ? String(project.worksheet_name) : undefined,
    headerRow: Number(project.header_row),
    batchSize: loadConfig().processing.batchSize,
    startAfterRow: startAfter,
    shouldCancel: checkCancel,
    onBatch: (rows, firstRowNumber) => {
      const tx = db.transaction(() => {
        rows.forEach((values, i) => {
          const rowNumber = firstRowNumber + i;
          const original: Record<string, string> = {};
          headers.forEach((h, idx) => { original[h] = values[idx] ?? ""; });
          const nr = normalizeRow(resolver, mapping, values, projectMappings, autoHigh);
          const review = nr.reviewReasons.length > 0 ? 1 : 0;
          insRow.run(projectId, rowNumber, JSON.stringify(original), JSON.stringify(nr),
            nr.fields.Make?.confidence ?? null, nr.fields.Model?.confidence ?? null,
            Object.entries(nr.fields).find(([f]) => HIERARCHY_FIELDS.includes(f as CanonicalField))
              ?.[1]?.confidence ?? null,
            nr.year?.status ?? null, review, nr.reviewReasons.join("; ") || null);
          for (const [field, f] of Object.entries(nr.fields)) {
            if (f.applied && f.value != null && f.value !== f.raw) {
              insChange.run(projectId, rowNumber, field, f.raw, f.value,
                "Automatic normalization", f.confidence, f.evidence ?? null);
            }
          }
          if (nr.year && nr.year.normalized && nr.year.normalized !== nr.year.raw
              && nr.year.status === "Valid") {
            insChange.run(projectId, rowNumber, "Model Year", nr.year.raw,
              nr.year.normalized, "Automatic normalization", "Deterministic Normalization",
              nr.year.note);
          }
        });
        db.prepare(`UPDATE standardization_projects SET processed_rows=?,
          updated_at=datetime('now'), last_progress_at=datetime('now') WHERE id=?`)
          .run(firstRowNumber + rows.length - 1, projectId);
      });
      tx();
      processed = firstRowNumber + rows.length - 1;
    },
  });

  const review = (db.prepare(`SELECT COUNT(*) n FROM standardization_rows
    WHERE project_id=? AND review_required=1 AND excluded=0`).get(projectId) as
    { n: number }).n;
  const status = cancelled ? "Mapped" : review > 0 ? "Review Required" : "Ready to Export";
  db.prepare(`UPDATE standardization_projects SET status=?, processed_rows=?,
    recovery_state=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(status, processed, projectId);
  if (!cancelled) {
    // retention policy may remove the stored upload once the import succeeded
    // (import of the module is deferred to avoid a cycle at load time)
    void import("../retention.js").then((m) => m.maybeDeleteUploadAfterImport(db, projectId))
      .catch(() => { /* retention is best-effort and never fails a run */ });
  }
  return { processed, review, status, cancelled };
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------
export type Decision = "Accept Suggestion" | "Keep Original" | "Select Different Match"
  | "Mark as Unknown" | "Exclude From Export" | "Apply to All Identical Values";

export function applyDecision(db: Database.Database, projectId: number, rowNumber: number,
  field: string, decision: Decision, chosenValue?: string, notes?: string): void {
  const row = db.prepare(`SELECT * FROM standardization_rows
    WHERE project_id=? AND row_number=?`).get(projectId, rowNumber) as
    { id: number; normalized_json: string } | undefined;
  if (!row) throw new Error(`Row ${rowNumber} not found in project ${projectId}`);
  const nr = JSON.parse(row.normalized_json) as NormalizedRow;
  const tx = db.transaction(() => {
    if (decision === "Exclude From Export") {
      db.prepare(`UPDATE standardization_rows SET excluded=1, user_decision=?,
        notes=? WHERE id=?`).run(decision, notes ?? null, row.id);
      db.prepare(`INSERT INTO standardization_changes (project_id, row_id, row_number,
        field_name, original_value, new_value, change_source, user_decision, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(projectId, row.id, rowNumber, "(row)", "included", "excluded",
          "User decision", decision, notes ?? null);
      return;
    }
    const f = nr.fields[field];
    if (!f) throw new Error(`Field ${field} not present on row ${rowNumber}`);
    let newValue: string | null = f.value;
    if (decision === "Accept Suggestion") { f.applied = true; newValue = f.value; }
    if (decision === "Keep Original") { f.applied = false; f.value = f.raw; newValue = f.raw; }
    if (decision === "Select Different Match") {
      if (!chosenValue) throw new Error("Select Different Match requires a value");
      f.value = chosenValue; f.applied = true; newValue = chosenValue;
    }
    if (decision === "Mark as Unknown") { f.value = null; f.applied = false; newValue = null; }
    nr.reviewReasons = nr.reviewReasons.filter((r) => !r.startsWith(`${field}:`));
    const review = nr.reviewReasons.length > 0 ? 1 : 0;
    db.prepare(`UPDATE standardization_rows SET normalized_json=?, review_required=?,
      user_decision=?, notes=? WHERE id=?`)
      .run(JSON.stringify(nr), review, decision, notes ?? null, row.id);
    db.prepare(`INSERT INTO standardization_changes (project_id, row_id, row_number,
      field_name, original_value, new_value, change_source, confidence, user_decision, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(projectId, row.id, rowNumber, field, f.raw, newValue, "User decision",
        f.confidence, decision, notes ?? null);
  });
  tx();
  refreshStatus(db, projectId);
}

/** How many rows share this raw value for this field (preview before applying). */
export function countIdentical(db: Database.Database, projectId: number, field: string,
  rawValue: string): number {
  const rows = db.prepare(`SELECT normalized_json FROM standardization_rows
    WHERE project_id=? AND excluded=0`).iterate(projectId) as
    Iterable<{ normalized_json: string }>;
  let n = 0;
  for (const r of rows) {
    const nr = JSON.parse(r.normalized_json) as NormalizedRow;
    if (nr.fields[field] && norm(nr.fields[field].raw) === norm(rawValue)) n++;
  }
  return n;
}

/** Apply one decision to every row with the same raw value (batch mapping). */
export function applyToAll(db: Database.Database, projectId: number, field: string,
  rawValue: string, canonicalValue: string | null, decision: string,
  context: { make?: string; model?: string } = {}, notes?: string): number {
  // two phases: collect matching ids by streaming, then update inside a
  // transaction (a statement cannot be iterated while it is being written to)
  const matches: { id: number; row_number: number; normalized_json: string }[] = [];
  for (const r of db.prepare(`SELECT id, row_number, normalized_json
    FROM standardization_rows WHERE project_id=?`).iterate(projectId) as
    Iterable<{ id: number; row_number: number; normalized_json: string }>) {
    const nr = JSON.parse(r.normalized_json) as NormalizedRow;
    const f = nr.fields[field];
    if (f && norm(f.raw) === norm(rawValue)) matches.push(r);
  }
  const rows = matches;
  let affected = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const nr = JSON.parse(r.normalized_json) as NormalizedRow;
      const f = nr.fields[field];
      if (!f || norm(f.raw) !== norm(rawValue)) continue;
      f.value = canonicalValue;
      f.applied = canonicalValue != null;
      nr.reviewReasons = nr.reviewReasons.filter((x) => !x.startsWith(`${field}:`));
      db.prepare(`UPDATE standardization_rows SET normalized_json=?, review_required=?,
        user_decision=? WHERE id=?`)
        .run(JSON.stringify(nr), nr.reviewReasons.length ? 1 : 0,
          "Apply to All Identical Values", r.id);
      db.prepare(`INSERT INTO standardization_changes (project_id, row_id, row_number,
        field_name, original_value, new_value, change_source, user_decision, notes)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(projectId, r.id, r.row_number, field, f.raw, canonicalValue,
          "Batch mapping", decision, notes ?? null);
      affected++;
    }
    // project-scoped decision, never written to the canonical catalog
    db.prepare(`INSERT INTO project_value_mappings (project_id, field_name, make_context,
      model_context, raw_value, norm_raw_value, canonical_value, decision,
      applied_row_count, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id, field_name, make_context, model_context, norm_raw_value)
      DO UPDATE SET canonical_value=excluded.canonical_value,
        decision=excluded.decision, applied_row_count=excluded.applied_row_count`)
      .run(projectId, field, context.make ?? "", context.model ?? "", rawValue,
        norm(rawValue), canonicalValue, decision, affected, notes ?? null);
  });
  tx();
  refreshStatus(db, projectId);
  return affected;
}

export function refreshStatus(db: Database.Database, projectId: number): string {
  const n = (db.prepare(`SELECT COUNT(*) n FROM standardization_rows
    WHERE project_id=? AND review_required=1 AND excluded=0`).get(projectId) as
    { n: number }).n;
  const current = db.prepare("SELECT status FROM standardization_projects WHERE id=?")
    .get(projectId) as { status: string };
  if (current.status === "Uploaded" || current.status === "Mapped"
    || current.status === "Processing") return current.status;
  const status = n > 0 ? "Review Required" : "Ready to Export";
  db.prepare(`UPDATE standardization_projects SET status=?, updated_at=datetime('now')
    WHERE id=?`).run(status, projectId);
  return status;
}

export function projectStats(db: Database.Database, projectId: number) {
  const one = (sql: string) => (db.prepare(sql).get(projectId) as { n: number }).n;
  // streamed with .iterate(): flat memory even for 250k-row projects
  const rows = db.prepare(`SELECT normalized_json, excluded, review_required
    FROM standardization_rows WHERE project_id=?`).iterate(projectId) as
    Iterable<{ normalized_json: string; excluded: number; review_required: number }>;
  const conf: Record<string, number> = {};
  let unmatchedMake = 0, unmatchedModel = 0, unmatchedHierarchy = 0, invalidYear = 0;
  let changedFields = 0;
  let total = 0, excluded = 0, reviewRows = 0;
  for (const r of rows) {
    total++;
    if (r.excluded) excluded++;
    if (r.review_required && !r.excluded) reviewRows++;
    const nr = JSON.parse(r.normalized_json) as NormalizedRow;
    for (const [field, f] of Object.entries(nr.fields)) {
      conf[f.confidence] = (conf[f.confidence] ?? 0) + 1;
      if (f.applied && f.value !== f.raw) changedFields++;
      if (f.confidence === "No Match" || f.confidence === "Conflict") {
        if (field === "Make") unmatchedMake++;
        else if (field === "Model") unmatchedModel++;
        else if (HIERARCHY_FIELDS.includes(field as CanonicalField)) unmatchedHierarchy++;
      }
    }
    if (nr.year && !["Valid", "Missing"].includes(nr.year.status)) invalidYear++;
  }
  return {
    inputRows: total,
    excluded,
    exportRows: total - excluded,
    reviewRows,
    confidence: conf, unmatchedMake, unmatchedModel, unmatchedHierarchy,
    invalidYear, changedFields,
    changeRecords: one("SELECT COUNT(*) n FROM standardization_changes WHERE project_id=?"),
  };
}

/** Overall standardization state used in reports (never "Standardized" with conflicts). */
export function projectOutcome(db: Database.Database, projectId: number): string {
  const s = projectStats(db, projectId);
  if (!s.inputRows) return "Failed";
  if (s.reviewRows > 0) return "Review Required";
  const unresolved = s.unmatchedMake + s.unmatchedModel + s.unmatchedHierarchy;
  if (unresolved > 0) return "Partially Standardized";
  if (s.invalidYear > 0) return "Standardized with Warnings";
  return "Standardized";
}

export { compressYears };
