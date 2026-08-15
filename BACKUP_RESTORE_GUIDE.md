# Backup and restore guide

## Creating a backup

```bash
npm run db:backup                 # timestamped copy into backups/
```
or `backup-database.bat`, or the **Create backup now** button on the Admin page.

Backups use SQLite `VACUUM INTO`, producing a single consistent file with no WAL
sidecar. The backup carries the same canonical read-only triggers as the live
database, so a restored database is still protected.

Backups are refused while a processing or export job is running — the operation
takes a global lock and reports which job is in the way.

## Restoring

```bash
npm run db:restore -- backups\catalog-2026-07-18T10-00-00-000Z.db
```
or `restore-database.bat backups\<file>.db`.

Restore:

- **refuses to overwrite an active database while jobs are running**;
- closes the database handle before replacing the file;
- removes stale `-wal` / `-shm` sidecars;
- copies the backup into place;
- re-applies migrations and startup recovery on next launch.

Stop the server before restoring. The command tells you if it cannot proceed.

## Validated round trip

`scripts/backup_restore_validation.mjs` builds a realistic project (CSV and XLSX
metadata, column mapping, exact matches, alias matches, a cross-brand conflict,
review decisions, batch mappings and generated exports), then:

1. creates a backup and records its SHA-256,
2. proves restore is refused while a job is active,
3. deletes the working database,
4. restores from the backup,
5. reopens the project,
6. verifies row counts, statistics, outcome, review decisions and batch mappings,
7. regenerates the exports,
8. compares them with the pre-backup output.

Result: `exports/Backup_Restore_Validation_Report.json` — **PASS**, with the CSV
export byte-identical and the change report data-identical (the XLSX bytes differ
only by their embedded creation timestamp).

## What a backup contains

Everything in the database: the canonical Version 4 catalog, all standardization
projects, rows, changes, value mappings, templates, proposals and audit tables.
It does **not** contain the `uploads/` folder or generated export files — copy
those separately if you need them.

## Recommended routine

- Back up before importing an updated catalog release.
- Back up before deleting projects in bulk.
- Keep the ZIP release and its `catalog-v5.1.db` as your clean baseline; you can
  always return to it.
