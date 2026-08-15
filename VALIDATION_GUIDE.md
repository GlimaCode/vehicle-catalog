# Validation guide

## Layers of validation

1. **Import-time mandatory checks** (inside the transaction; failure = full rollback):
   column validation per file, all makes/models imported, zero rejected model rows, no
   orphan models, model-year expansion consistent with first/last years, no duplicate
   make or make–model, sub-model conservatism (nothing auto-approved), and no *pending*
   review candidate whose normalized form matches a canonical model.

2. **`npm run verify`** — independent pre-delivery verification that re-reads the source
   CSVs, the database, and the generated Excel workbook:
   - every canonical Make and Model from the catalog files exists in the database
   - every model references a valid make; approved sub-models reference valid models
   - every source-file model year is present after range expansion
   - non-contiguous ranges remain non-contiguous; min/max years agree with the models table
   - no pending unresolved candidate appears as an approved canonical value
   - no duplicate Make / Make–Model / Make–Model–Sub-model
   - all resolved aliases point to valid canonical records; all source URLs present
   - Excel worksheet row counts match database counts exactly; headers match the spec
   - re-importing the same files creates no duplicates (idempotency)
   - source file SHA-256 hashes recorded (files are never modified)

3. **Automated tests** (`npm test`) — 18 tests covering CSV parsing with embedded line
   breaks, dedup/merging, non-contiguous year expansion, alias resolution, sub-model
   classification, transaction rollback, uniqueness constraints, idempotency, Excel
   worksheets/headers/counts, hyperlinks, CSV quoting, and review separation.

## Review workflow

The Validation review page lists all unresolved candidates with issue type, reason,
recommended next action and a status control (Pending / Approved / Rejected /
Needs More Evidence / Corrected). Every status change requires a reason and is written to
`audit_changes` with before/after values and a timestamp.

**Approving a review item does not add it to the canonical catalog.** Promotion requires
adding the record (with authoritative evidence) to the catalog CSV files and running a
validated re-import — this keeps the canonical catalog reproducible from its source files.

## Sub-model policy

Values that may represent trim, package, series, chassis code, generation, body style,
engine, drivetrain, or edition are never treated as Sub-models automatically. Candidates
extracted from documented aliases are stored with `Review Required` status, appear on the
Sub-models page only behind a toggle, are excluded from the approved Excel sheets, and are
hidden from the cascading selector by default.
