/**
 * Upload and project-data retention.
 *
 * Deletion is always previewable: the caller can ask exactly what would be
 * removed before anything happens. Canonical catalog data is never touched by
 * project cleanup, and an audited deletion record is written that keeps counts
 * and file metadata but no sensitive row contents.
 */
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { PROJECT_EXPORT_DIR, UPLOAD_DIR } from "./db.js";
import { loadConfig } from "./config.js";
import { isInside } from "./security/filenames.js";
import { sweepTempFiles } from "./security/atomic.js";

export type DeleteScope = "uploads" | "exports" | "rows" | "project" | "all-projects";

export interface DeletionPreview {
  projectId: number | null;
  projectName: string | null;
  scope: DeleteScope;
  uploadedFiles: { path: string; bytes: number }[];
  exportFiles: { path: string; bytes: number }[];
  temporaryFiles: string[];
  rows: number;
  changes: number;
  valueMappings: number;
  reviewDecisions: number;
  exportRecords: number;
  bytes: number;
  canonicalRecordsAffected: 0;
  note: string;
}

function safeFiles(dir: string): { path: string; bytes: number }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = path.join(dir, e.name);
      return { path: p, bytes: fs.statSync(p).size };
    });
}

export function projectExportFolder(projectId: number): string {
  return path.join(PROJECT_EXPORT_DIR, `project-${projectId}`);
}

export function previewDeletion(db: Database.Database, projectId: number | null,
  scope: DeleteScope): DeletionPreview {
  const p = projectId
    ? db.prepare("SELECT * FROM standardization_projects WHERE id=?").get(projectId) as
      Record<string, unknown> | undefined
    : undefined;
  const ids = projectId ? [projectId]
    : (db.prepare("SELECT id FROM standardization_projects").all() as { id: number }[])
      .map((r) => r.id);

  const uploaded: { path: string; bytes: number }[] = [];
  const exports: { path: string; bytes: number }[] = [];
  const temporary: string[] = [];
  let rows = 0, changes = 0, mappings = 0, decisions = 0, exportRecords = 0;

  for (const id of ids) {
    const proj = db.prepare("SELECT stored_path FROM standardization_projects WHERE id=?")
      .get(id) as { stored_path: string | null } | undefined;
    if ((scope === "uploads" || scope === "project" || scope === "all-projects")
      && proj?.stored_path && fs.existsSync(proj.stored_path)
      && isInside(UPLOAD_DIR, proj.stored_path)) {
      uploaded.push({ path: proj.stored_path, bytes: fs.statSync(proj.stored_path).size });
    }
    if (scope === "exports" || scope === "project" || scope === "all-projects") {
      exports.push(...safeFiles(projectExportFolder(id)));
      exportRecords += (db.prepare("SELECT COUNT(*) n FROM project_exports WHERE project_id=?")
        .get(id) as { n: number }).n;
    }
    if (scope === "rows" || scope === "project" || scope === "all-projects") {
      rows += (db.prepare("SELECT COUNT(*) n FROM standardization_rows WHERE project_id=?")
        .get(id) as { n: number }).n;
      changes += (db.prepare("SELECT COUNT(*) n FROM standardization_changes WHERE project_id=?")
        .get(id) as { n: number }).n;
      decisions += (db.prepare(`SELECT COUNT(*) n FROM standardization_rows
        WHERE project_id=? AND user_decision IS NOT NULL`).get(id) as { n: number }).n;
    }
    if (scope === "project" || scope === "all-projects") {
      mappings += (db.prepare("SELECT COUNT(*) n FROM project_value_mappings WHERE project_id=?")
        .get(id) as { n: number }).n;
    }
  }
  temporary.push(...sweepTempFilesPreview());

  const bytes = [...uploaded, ...exports].reduce((a, f) => a + f.bytes, 0);
  return {
    projectId, projectName: p ? String(p.project_name) : null, scope,
    uploadedFiles: uploaded, exportFiles: exports, temporaryFiles: temporary,
    rows, changes, valueMappings: mappings, reviewDecisions: decisions,
    exportRecords, bytes, canonicalRecordsAffected: 0,
    note: "Canonical Make, Model, hierarchy, configuration, alias and model-year "
      + "records are never removed by project cleanup.",
  };
}

function sweepTempFilesPreview(): string[] {
  const out: string[] = [];
  for (const dir of [PROJECT_EXPORT_DIR, UPLOAD_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".part")) out.push(full);
      }
    };
    walk(dir);
  }
  return out;
}

export interface DeletionResult extends DeletionPreview { filesDeleted: number }

/** Execute a previewed deletion and write the audit record. */
export function executeDeletion(db: Database.Database, projectId: number | null,
  scope: DeleteScope, reason = ""): DeletionResult {
  const preview = previewDeletion(db, projectId, scope);
  const cfg = loadConfig();
  const ids = projectId ? [projectId]
    : (db.prepare("SELECT id FROM standardization_projects").all() as { id: number }[])
      .map((r) => r.id);
  let filesDeleted = 0;

  const removeFile = (p: string) => {
    if (!isInside(UPLOAD_DIR, p) && !isInside(PROJECT_EXPORT_DIR, p)) return;
    try { fs.rmSync(p); filesDeleted++; } catch { /* best effort */ }
  };

  const tx = db.transaction(() => {
    for (const id of ids) {
      const proj = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
        .get(id) as Record<string, unknown> | undefined;
      if (!proj) continue;

      if (scope === "uploads" || scope === "project" || scope === "all-projects") {
        const stored = proj.stored_path ? String(proj.stored_path) : "";
        if (stored && fs.existsSync(stored)) removeFile(stored);
        db.prepare("UPDATE standardization_projects SET upload_removed=1 WHERE id=?").run(id);
      }
      if (scope === "exports" || scope === "project" || scope === "all-projects") {
        const dir = projectExportFolder(id);
        if (fs.existsSync(dir)) {
          for (const f of safeFiles(dir)) removeFile(f.path);
          try { fs.rmdirSync(dir); } catch { /* non-empty is fine */ }
        }
        db.prepare("DELETE FROM project_exports WHERE project_id=?").run(id);
      }
      if (scope === "rows" || scope === "project" || scope === "all-projects") {
        // changes first: standardization_changes.row_id references
        // standardization_rows(id), so deleting rows first violates the key
        if (!cfg.retention.keepAuditMetadataOnDelete || scope !== "rows") {
          db.prepare("DELETE FROM standardization_changes WHERE project_id=?").run(id);
        } else {
          // audit metadata is being kept, but the rows it points at are going
          db.prepare("UPDATE standardization_changes SET row_id=NULL WHERE project_id=?")
            .run(id);
        }
        db.prepare("DELETE FROM standardization_rows WHERE project_id=?").run(id);
      }
      if (scope === "project" || scope === "all-projects") {
        db.prepare("DELETE FROM project_value_mappings WHERE project_id=?").run(id);
        db.prepare("DELETE FROM standardization_changes WHERE project_id=?").run(id);
        db.prepare("DELETE FROM standardization_projects WHERE id=?").run(id);
      }

      db.prepare(`INSERT INTO project_deletions (project_id, project_name,
        display_filename, input_file_hash, rows_deleted, changes_deleted,
        value_mappings_deleted, exports_deleted, files_deleted, bytes_freed, scope, reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, String(proj.project_name ?? ""),
          String(proj.display_filename ?? proj.input_filename ?? ""),
          String(proj.input_file_hash ?? ""), preview.rows, preview.changes,
          preview.valueMappings, preview.exportRecords, filesDeleted, preview.bytes,
          scope, reason);
    }
    for (const t of preview.temporaryFiles) removeFile(t);
  });
  tx();

  return { ...preview, filesDeleted };
}

/** Apply the configured automatic retention policy. Returns what it removed. */
export function applyRetentionPolicy(db: Database.Database): {
  purgedProjects: number[]; temporaryFilesRemoved: number } {
  const cfg = loadConfig();
  const purged: number[] = [];
  if (cfg.retention.autoPurgeProjectsAfterDays > 0) {
    const rows = db.prepare(`SELECT id FROM standardization_projects
      WHERE julianday('now') - julianday(COALESCE(completed_at, updated_at, created_at))
        > ?`).all(cfg.retention.autoPurgeProjectsAfterDays) as { id: number }[];
    for (const r of rows) {
      executeDeletion(db, r.id, "project",
        `Automatic retention: older than ${cfg.retention.autoPurgeProjectsAfterDays} days`);
      purged.push(r.id);
    }
  }
  let removed = 0;
  if (cfg.retention.deleteTemporaryFilesAfterExport) {
    removed = sweepTempFiles(PROJECT_EXPORT_DIR).length + sweepTempFiles(UPLOAD_DIR).length;
  }
  return { purgedProjects: purged, temporaryFilesRemoved: removed };
}

/** Called after a successful import when the policy says not to keep uploads. */
export function maybeDeleteUploadAfterImport(db: Database.Database, projectId: number): boolean {
  const cfg = loadConfig();
  if (!cfg.retention.deleteUploadAfterImport) return false;
  const p = db.prepare("SELECT stored_path FROM standardization_projects WHERE id=?")
    .get(projectId) as { stored_path: string | null } | undefined;
  if (!p?.stored_path || !fs.existsSync(p.stored_path)) return false;
  if (!isInside(UPLOAD_DIR, p.stored_path)) return false;
  try {
    fs.rmSync(p.stored_path);
    db.prepare("UPDATE standardization_projects SET upload_removed=1 WHERE id=?")
      .run(projectId);
    return true;
  } catch {
    return false;
  }
}
