# Data retention guide

## What the application stores

| Location | Contents | Removable |
|---|---|---|
| `uploads/` | your uploaded files, named by storage ID | yes |
| `exports/standardization/project-<id>/` | generated CSV/XLSX/reports | yes |
| `standardization_rows` | original + normalized row JSON | yes |
| `standardization_changes` | field-level audit trail | yes |
| `project_value_mappings` | your project decisions | yes |
| `project_deletions` | audit of what was deleted (counts only) | retained |
| canonical tables | Version 4 catalog | **never removed by cleanup** |

## Configuration (`config/app-config.json` → `retention`)

| Key | Default | Effect |
|---|---|---|
| `deleteUploadAfterImport` | `false` | delete the stored upload once a project imports successfully |
| `deleteTemporaryFilesAfterExport` | `true` | sweep `*.part` temporary files |
| `autoPurgeProjectsAfterDays` | `0` (off) | automatically delete projects older than N days |
| `keepAuditMetadataOnDelete` | `true` | keep the field-level change log when deleting rows only |

Defaults keep your data but never keep unnecessary temporary copies.

## Deletion scopes

| Scope | Removes |
|---|---|
| `uploads` | the stored uploaded file only |
| `exports` | generated output files and their export records |
| `rows` | row data (change audit retained when `keepAuditMetadataOnDelete`) |
| `project` | everything for that project, including the project record |
| `all-projects` | every project (canonical catalog untouched) |

## Preview before deleting

`GET /api/std/projects/:id/deletion-preview?scope=project`, or the buttons on the
Project History page, show exactly what will be removed **before** anything
happens:

- uploaded files (with sizes),
- export files (with sizes),
- temporary files,
- database rows, change records, value mappings, review decisions, export records,
- disk space that will be freed,
- and `canonicalRecordsAffected: 0` — always zero.

You confirm, optionally give a reason, and only then is anything deleted.

## Audited deletion record

Every deletion writes a row to `project_deletions`: project id and name, display
filename, input file hash, counts of rows/changes/mappings/exports/files removed,
bytes freed, scope, reason and timestamp. **Row contents are never retained** in
that record — only counts and file metadata.

## Automatic cleanup

Set `autoPurgeProjectsAfterDays` to a positive number to purge projects that have
been idle that long. The policy runs at startup and on demand
(`POST /api/std/retention/apply`), and each purge writes its own audit record.

## Purging everything

`DELETE /api/std/projects/<id>?scope=all-projects` clears all project data. The
canonical catalog, its aliases, hierarchy, configuration and model years remain
exactly as shipped.
