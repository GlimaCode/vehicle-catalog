/**
 * Crash recovery and interrupted-job handling.
 *
 * The server can be killed at any point: while parsing, normalizing, inserting
 * batches, or writing an export. On startup we reconcile the database with
 * reality so a partially finished job is never presented as complete.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { EXPORT_DIR, PROJECT_EXPORT_DIR, UPLOAD_DIR } from "./db.js";
import { sweepTempFiles } from "./security/atomic.js";
import { resetLocks } from "./security/locks.js";

export interface RecoveryReport {
  staleProcessing: number;
  resumable: number;
  unrecoverable: number;
  temporaryFilesRemoved: string[];
  walCheckpoint: string;
  details: { projectId: number; name: string; outcome: string; reason: string }[];
}

export function runStartupRecovery(db: Database.Database): RecoveryReport {
  resetLocks();
  const report: RecoveryReport = {
    staleProcessing: 0, resumable: 0, unrecoverable: 0,
    temporaryFilesRemoved: [], walCheckpoint: "skipped", details: [],
  };

  // 1. any project left in Processing has no running job after a restart
  const stale = db.prepare(`SELECT id, project_name, stored_path, processed_rows,
    row_count, mapping_json FROM standardization_projects WHERE status='Processing'`)
    .all() as { id: number; project_name: string; stored_path: string | null;
      processed_rows: number; row_count: number; mapping_json: string | null }[];
  report.staleProcessing = stale.length;

  const markResumable = db.prepare(`UPDATE standardization_projects
    SET status='Mapped', recovery_state=?, cancel_requested=0,
        updated_at=datetime('now') WHERE id=?`);
  const markFailed = db.prepare(`UPDATE standardization_projects
    SET status='Failed', recovery_state=?, updated_at=datetime('now') WHERE id=?`);

  for (const p of stale) {
    const hasSource = !!p.stored_path && fs.existsSync(p.stored_path);
    const hasMapping = !!p.mapping_json;
    if (hasSource && hasMapping) {
      const note = `Interrupted during processing at row ${p.processed_rows}. `
        + `Committed batches were kept; resume continues from row ${p.processed_rows + 1}.`;
      markResumable.run(note, p.id);
      report.resumable++;
      report.details.push({ projectId: p.id, name: p.project_name,
        outcome: "Resumable", reason: note });
    } else {
      const note = hasSource
        ? "Interrupted during processing and the column mapping is missing; "
          + "re-map the file to continue."
        : "Interrupted during processing and the uploaded source file is no longer "
          + "available; the file must be uploaded again.";
      markFailed.run(note, p.id);
      report.unrecoverable++;
      report.details.push({ projectId: p.id, name: p.project_name,
        outcome: "Unrecoverable", reason: note });
    }
  }

  // 2. remove incomplete temporary exports (never leave a partial file behind)
  for (const dir of [PROJECT_EXPORT_DIR, EXPORT_DIR, UPLOAD_DIR]) {
    report.temporaryFilesRemoved.push(...sweepTempFiles(dir));
  }

  // 3. checkpoint the WAL so the database file is self-contained on disk
  try {
    const r = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number;
      checkpointed: number }[];
    report.walCheckpoint = JSON.stringify(r?.[0] ?? r);
  } catch (e) {
    report.walCheckpoint = `failed: ${String(e)}`;
  }

  if (report.staleProcessing || report.temporaryFilesRemoved.length) {
    db.prepare(`INSERT INTO security_events (event_type, detail)
      VALUES ('startup-recovery', ?)`).run(JSON.stringify({
        staleProcessing: report.staleProcessing, resumable: report.resumable,
        unrecoverable: report.unrecoverable,
        temporaryFilesRemoved: report.temporaryFilesRemoved.length }));
  }
  return report;
}
