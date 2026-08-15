# Crash recovery guide

The application can be killed at any moment — closed window, power loss, Task
Manager. Version 5.1 reconciles the database with reality on every startup so a
partially finished job is never presented as complete.

## What happens at startup

1. **Stale `Processing` projects are detected.** After a restart no job is
   running, so any project still marked `Processing` was interrupted.
   - Source file **and** column mapping still present → status becomes `Mapped`,
     `recovery_state` explains where it stopped, and *Resume* continues from
     `processed_rows + 1`. Committed batches are kept.
   - Mapping missing → `Failed`, with "re-map the file to continue".
   - Uploaded source gone → `Failed`, with "the file must be uploaded again".
2. **Incomplete temporary exports are removed.** Generated files are written to
   `<name>.<id>.part` and renamed only on success, so a partial file is never
   mistaken for a finished export.
3. **The WAL is checkpointed** (`wal_checkpoint(TRUNCATE)`) so the database file
   on disk is self-contained.
4. A summary is written to `security_events` and printed to the console.

## Interruption points and outcomes

| Interrupted during | Result |
|---|---|
| Parsing / preview | Nothing was committed; re-run the step |
| Normalization | Committed batches kept; project becomes resumable |
| Batched insertion | The in-flight batch rolls back (one transaction per batch); earlier batches survive |
| CSV export | `.part` file removed at next start; no partial CSV |
| XLSX export | `.part` file removed at next start; no partial workbook |
| System restart | All of the above, applied at next launch |

## Filesystem failure handling

| Condition | Message |
|---|---|
| Disk full (`ENOSPC`) | "Not enough disk space to write *file*. Free some space and export again; no partial file was kept." |
| Permission denied (`EACCES`/`EPERM`) | "Permission denied writing *file*. Check folder permissions; no partial file was kept." |
| File locked (`EBUSY`) | "*file* is locked by another program (is it open in Excel?). Close it and export again." |
| Destination missing (`ENOENT`) | "The export destination is unavailable: *folder*" |

In every case the temporary file is deleted and the real filename is untouched.

## Resuming a job

Open the project → **Process** → *Resume from row N*. Rows are upserted on
`(project_id, row_number)`, so resuming never duplicates work. You can also
re-run the whole file; reprocessing is idempotent.

## If the database itself looks wrong

1. Stop the application.
2. `npm run db:restore -- backups\<file>.db` (restore refuses to run while jobs
   are active — see `BACKUP_RESTORE_GUIDE.md`).
3. Start the app; migrations re-apply and startup recovery runs again.
