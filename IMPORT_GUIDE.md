# Import guide

## Running an import

- CLI: `npm run catalog:import` (alias: `npm run import-catalog`)
- UI: Admin page → **Import updated catalog files**

The importer looks in the parent directory (override with the `CATALOG_DIR` environment
variable) and prefers `*_v2.csv` filenames, falling back to the current completed catalog
filenames. This means future Version 2+ files are picked up without rebuilding the app.

## Pipeline steps

1. Detect catalog files (fail fast if a mandatory file is missing).
2. Validate expected columns per file before importing anything.
3. Compute SHA-256 for every input file.
4. Parse CSV with `csv-parse` — full quoting and embedded line-break support.
5. Open one database transaction for the entire run.
6. Upsert makes, then models (merging punctuation/spacing variant rows; variant spellings
   become aliases), then expand every `Confirmed Model Years` value into `model_years` rows
   (semicolon-separated non-contiguous segments preserved exactly).
7. Import aliases; classified trim/chassis/generation values become Review Required
   sub-model candidates (never auto-approved).
8. Import grouped relationships and validation reviews (candidates whose normalized form
   already exists as a canonical model are marked `Corrected` with a documented reason).
9. Import the coverage report and source registry.
10. Write one `import_runs` row per file with hash and row counts.
11. Run mandatory validations (all makes/models imported, no orphans, year expansion
    consistent, no duplicates, no pending candidate colliding with canonical, sub-model
    conservatism). **Any failure throws → the whole transaction rolls back.**
12. Write `exports/last_import_report.json` with per-file counts and check results.

## Re-import semantics

- Same files again → 0 new rows, updates in place (verified idempotent by tests and
  `npm run verify`).
- Updated files → changed fields updated via `ON CONFLICT ... DO UPDATE`; no duplicates.
- Canonical records are **never deleted** by an import. Removals would be an explicit,
  audited admin operation.
- Manual review decisions (`review_status`) are preserved across re-imports (the upsert
  does not overwrite `review_status`).

## Troubleshooting

- *"Catalog files not found"* — check the parent directory or set `CATALOG_DIR`.
- *"missing required columns"* — the file does not match the expected schema; the run
  aborts before any write.
- *"Mandatory import validation failed"* — see the check list in the output; the database
  is unchanged (rollback).
