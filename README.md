# US Vehicle Catalog

> Built by [GlimaCode](https://glimacode.com) — a two-developer web studio.

A local-first web application for browsing, searching, managing, validating, and exporting the
standardized US automotive Make / Model / Sub-model catalog (model years **1980 → research cutoff
2026-07-15**). A reference system for standardized vehicle Make, Model, Sub-model, model-year, source, validation, and alias information.

## What it does

- Browses all 75 standardized Makes, 1,807 canonical Models, and 15,257 individual model-year records
- Global search that is case-, space-, punctuation- and hyphen-insensitive (`F150` → Ford F-150,
  `Mercedes Benz` → Mercedes-Benz), with exact matches first, alias matches labelled separately,
  and a "why this matched" explanation on every result
- Alias lookup for standardizing future files (raw values, misspellings, model+trim combinations,
  multi-model compatibility groups)
- Year browser, cascading Make→Model→Sub-model→Year selector, validation review workflow,
  source/audit pages
- Excel workbook and CSV exports generated straight from the database
- Safe transactional re-import of updated catalog files without rebuilding the app

## Which files it imports

From the parent directory (the catalog working directory), preferring `*_v2.csv` names and
falling back to the current completed catalog set:

| Purpose | File |
|---|---|
| Master Make/Model catalog | `Complete_US_Make_Model_Catalog_1980_to_2026-07-15[_v2].csv` |
| Make catalog | `Complete_Standard_Make_Catalog[_v2].csv` |
| Aliases | `Make_Model_Alias_Mapping[_v2].csv` |
| Grouped relationships | `Grouped_Model_Relationships[_v2].csv` |
| Unresolved candidates | `Make_Model_Validation_Review[_v2].csv` |
| Coverage report | `Catalog_Coverage_Report[_v2].csv` |

Input files are opened read-only and never modified. Every import records SHA-256 hashes and row
counts in `import_runs`.

## Install and run

```bash
cd catalog-app
npm install            # install dependencies
npm run db:init        # initialize the SQLite database
npm run catalog:import # import the catalog files (transactional, validated)
npm run build          # production build (typecheck + frontend bundle)
npm start              # production server -> http://localhost:4310
```

Development mode (API on :4310, hot-reload UI on :4311):

```bash
npm run dev
```

Other commands:

```bash
npm test               # automated test suite (vitest)
npm run export:excel   # regenerate the complete Excel workbook into exports/
npm run db:backup      # write a timestamped backup into backups/
npm run db:restore -- backups/<file>.db   # restore a backup
npm run verify         # full pre-delivery verification (DB vs CSVs vs Excel)
```

## Updating the catalog

Drop updated `*_v2.csv` files into the parent directory and either run
`npm run catalog:import` or press **Import updated catalog files** on the Admin page. The import
is a single transaction: expected columns are validated first, year ranges are expanded into
`model_years`, duplicates are updated in place (never duplicated), unresolved records go to the
review table, and if any mandatory validation fails the entire run rolls back. Canonical records
are never silently deleted.

## How validation works

See `VALIDATION_GUIDE.md`. In short: mandatory checks run inside the import transaction
(rollback on failure); `npm run verify` re-checks the database against the source CSVs and the
generated Excel workbook (row counts, headers, year expansion, non-contiguous ranges, duplicate
constraints, alias resolution, review separation, idempotent re-import).

## Storage locations

| What | Where |
|---|---|
| SQLite database | `catalog-app/data/catalog.db` |
| Backups | `catalog-app/backups/` |
| Exports (Excel, import reports) | `catalog-app/exports/` |
| Screenshots | `catalog-app/screenshots/` |

The principal spreadsheet deliverable is
`exports/Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx`.

## File Standardization workspace (Version 5)

Upload your own automotive CSV/XLSX files and standardize them against the frozen
Version 4 canonical catalog. The canonical catalog is **read-only** here — enforced by
SQLite triggers, not just convention.

**How to upload a file** — *File standardization → Upload file*. Choose a CSV or XLSX,
optionally name the project, and upload. You see filename, size, detected encoding,
worksheet list, row/column counts, the header preview and the first 20 data rows. For
multi-sheet workbooks, pick the worksheet.

**How to map columns** — *Map columns*. Each source column gets a canonical field,
`Ignore`, or `Preserve as Custom Field`. Set the header row if it is not row 1, choose a
merge strategy if two columns share a field, and save/load reusable mapping templates.
At least one column must map to Make or Model. See `COLUMN_MAPPING_GUIDE.md`.

**How matches are calculated** — resolution is contextual: Make first, then Model *inside*
that Make, then hierarchy values *inside* that Make and Model, then years. Matching is
case-, space-, punctuation- and hyphen-insensitive. See `MATCH_CONFIDENCE_GUIDE.md`.

**Which matches apply automatically** — only `Exact Canonical Match`,
`Approved Alias Match` and `Deterministic Normalization`. Suggested matches always need
approval; auto-applying `High Confidence Suggested Match` is an opt-in toggle that is
**off by default**. Nothing uncertain is ever replaced silently.

**How to review suggestions** — *Review matches* shows the original value, suggestion,
confidence, conflict reason, alternatives and evidence, with the decisions
`Accept Suggestion`, `Keep Original`, `Select Different Match`, `Mark as Unknown`,
`Exclude From Export` and `Apply to All Identical Values` (which previews the affected row
count first). See `REVIEW_WORKFLOW_GUIDE.md`.

**How to export standardized files** — *Export results* offers standardized CSV and XLSX,
the change report `<original_filename>_Standardization_Changes.xlsx`, a review-only
workbook, a value-mapping CSV and a JSON report. Source row order is preserved unless you
choose otherwise.

**Canonical aliases vs project mappings** — canonical aliases are part of the researched
Version 4 catalog and apply everywhere; project mappings are your decisions inside one
project and never modify the catalog. An Admin can raise a catalog change proposal, which
changes nothing until a new catalog release. See `PROJECT_MAPPING_GUIDE.md`.

**How original values are preserved** — **Audit mode is the default**: every original
column is kept and standardized columns (`Original Make`, `Standard Make`,
`Make Match Status`, …, `Row Review Status`, `Standardization Notes`) are appended.
Replacement mode only substitutes values that were applied automatically or approved by
you, and never touches `Title`, `Item ID`, `SKU` or custom columns.

**How to process large files safely** — files stream to the server and are processed in
batches with progress, cancellation and resume. 100,000 rows process in about 14 seconds
using roughly 100 MB of heap. See `LARGE_FILE_PROCESSING_GUIDE.md`.

Additional export: **`Canonical Vehicle Lookup.xlsx`** (`npm run export:lookup` or the
button on the Projects page) — a simplified six-sheet workbook for external lookup and
Excel data-validation workflows. It does not replace the full Version 4 workbook.

## Version 5.1 — production hardening

Version 5.1 changes no catalog data. Every canonical Make, Model, hierarchy value,
configuration value, alias and model-year record is byte-for-byte identical to
Version 4. What changed is how the application handles hostile input, large files,
crashes and its own storage.

**Network exposure.** The server binds to `127.0.0.1:4310` and is reachable from
this machine only. Nothing is exposed to the local network unless you deliberately
set `server.allowLanAccess` in `config/app-config.json`, which additionally
requires a shared token (`X-Auth-Token`) and restricts CORS to an allow-list. The
current binding is always visible at `GET /api/admin/binding` and in the startup
banner. See `SECURITY_GUIDE.md`.

**Upload and workbook limits.** Uploads are capped at 512 MB and restricted to
`.csv`, `.txt` and `.xlsx`. Every upload is checked against its declared extension
by file signature, so a renamed file is rejected rather than parsed. Macro-enabled
workbooks are refused. Zip-bomb defences cap a workbook at 2,000 entries, a 200:1
compression ratio, 64 worksheets and 50,000,000 cells; cells longer than 32,767
characters are truncated with a recorded note. Rejections return HTTP 415 and are
written to the `security_events` table. See `SAFE_FILE_HANDLING_GUIDE.md`.

**Spreadsheet formula injection.** Any exported value that would be interpreted as
a formula by Excel, Google Sheets or LibreOffice (leading `=`, `+`, `-`, `@`, tab or
carriage return) is neutralised: CSV output gains a leading apostrophe, XLSX output
is written as an explicit text cell with an `@` number format so the displayed text
is unchanged. Numbers, negative numbers, currency and dates are left alone. Every
export reports the number of neutralised cells in a
`Formula Injection Protection Applied` column and in the export history.

**Filenames and paths.** Uploaded files are stored under a generated storage ID,
never the user-supplied name. The original name is preserved for display only.
Traversal sequences, reserved Windows device names (`CON`, `PRN`, `AUX`, `NUL`,
`COM1`–`COM9`, `LPT1`–`LPT9`), control characters and trailing dots or spaces are
rejected or rewritten, and every resolved path is asserted to sit inside the
application's own directories.

**Retention and deletion.** Uploaded source files, generated exports and temporary
files are governed by a retention policy on the Retention page. Deleting a project
shows a preview first — how many uploaded files, exports, rows, mappings and review
decisions will go, and explicitly that `0` canonical records are affected — and
writes an audit record to `project_deletions`. Canonical catalog data is never
removed by any cleanup path. See `DATA_RETENTION_GUIDE.md`.

**Crash recovery.** On startup, any project left in `Processing` by a crash is
reconciled: if the source file and column mapping survive it becomes resumable and
continues from the next unprocessed row, otherwise it is marked `Failed` with the
reason. Partial `.part` files are swept and the WAL is checkpointed. An interrupted
job is never presented as complete. See `CRASH_RECOVERY_GUIDE.md`.

**Concurrency.** Processing, exporting, backup, restore and canonical import take
named locks. A second conflicting request returns HTTP 409 with the reason rather
than corrupting shared state.

**Backup and restore.** Backups use `VACUUM INTO`, producing a self-contained file
with no separate WAL. Restore verifies integrity, foreign keys and canonical row
counts before swapping the database in. See `BACKUP_RESTORE_GUIDE.md`.

**Large-file benchmarks.** Measured on the real requirement, not a scaled-down
proxy. Every stage — parse, process, CSV export, XLSX export and change report —
ran to completion for both fixtures.

| | Fixture A | Fixture B |
|---|---|---|
| Shape | 100,000 × 100 (172.8 MB) | 250,000 × 20 (43.2 MB) |
| Total duration | 292.7 s | 287.7 s |
| Peak RSS | **1,130.4 MB** | **929.9 MB** |
| Peak JS heap | 122.9 MB | 125.9 MB |
| Result | **PASS** | **PASS** |

Per-stage timings, output sizes and temporary-storage peaks are in
`exports/Large_File_Performance_Report.json` and `.csv`; hardware
recommendations are in `LARGE_FILE_PROCESSING_GUIDE.md`. **This is not a
low-memory workload** — plan for 4 GB RAM minimum, 8 GB recommended, and 5 GB
free disk. The benchmark fixtures themselves are deliberately excluded from the
release package; regenerate them with `scripts/make_large_fixture.mjs`.

**Installation status.** The release was installed and exercised end to end from a
fresh directory whose path contains spaces and non-ASCII characters, with an
isolated npm cache; all 12 functional steps passed and two real installation
defects were found and fixed. This is **not** clean-machine verification — no clean
Windows environment was available. See `CLEAN_INSTALL_VALIDATION.md` for exactly
what remains unverified.

**Known limitations.**
- Clean-machine installation (no Node.js pre-installed, different Node major
  version, non-administrator account, SmartScreen prompts) is unverified.
- Peak RSS exceeds 1 GB on a 100,000 × 100 file; machines with little free
  memory should process very wide or very long files one at a time.
- The upload signature check identifies container types (ZIP/OLE2/text); it does
  not scan file contents for malware.
- LAN mode's shared-token authentication is a single shared secret, not per-user
  accounts.

## Documentation

- `SECURITY_GUIDE.md` – network exposure, headers, authentication, threat model
- `SAFE_FILE_HANDLING_GUIDE.md` – upload limits, signature checks, workbook defences
- `DATA_RETENTION_GUIDE.md` – retention policy and project deletion
- `CRASH_RECOVERY_GUIDE.md` – interrupted jobs and what recovery does
- `BACKUP_RESTORE_GUIDE.md` – backup, restore and verification
- `CLEAN_INSTALL_VALIDATION.md` – installation test results and their limits
- `Canonical_Immutability_Security_Audit.md` – how canonical data is protected
- `DATA_MODEL.md` – database schema and design decisions
- `IMPORT_GUIDE.md` – catalog import pipeline and re-import workflow
- `EXPORT_GUIDE.md` – catalog Excel/CSV exports
- `VALIDATION_GUIDE.md` – catalog validation checks and review workflow
- `DEPLOYMENT_GUIDE.md` – running beyond localhost
- `FILE_STANDARDIZATION_GUIDE.md` – the standardization workspace end to end
- `COLUMN_MAPPING_GUIDE.md` – column mapping and templates
- `MATCH_CONFIDENCE_GUIDE.md` – confidence levels and what applies automatically
- `REVIEW_WORKFLOW_GUIDE.md` – reviewing and deciding
- `PROJECT_MAPPING_GUIDE.md` – project mappings vs canonical aliases
- `LARGE_FILE_PROCESSING_GUIDE.md` – large-file behaviour and benchmarks

## License

Released under the [MIT License](LICENSE) — free to use, modify, and distribute,
including commercially, provided the copyright notice is retained. Provided as
is, without warranty.

## Team

Built and maintained by:

- [Ali Ahmadi](https://github.com/aliahmadi1382)
- [Mostafa Taghipour](https://github.com/MoStafaMTP)

---

<p align="center">
  <sub>A <a href="https://glimacode.com">GlimaCode</a> project — a two-developer web studio.</sub>
</p>
