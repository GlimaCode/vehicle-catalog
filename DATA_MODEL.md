# Data model

SQLite database (`data/catalog.db`, WAL mode, foreign keys ON). All tables are created by
`server/db.ts` (`npm run db:init`). Normalization key: `norm(x)` uppercases and strips every
character except `A-Z0-9+` — `+` is retained because it is semantically significant
(Lexus RX 450h vs RX 450h+ are different vehicles).

## Canonical tables

- **makes** — one row per standardized Make. Unique on `standard_make` and on `norm_make`.
  Carries lifecycle, market years, origin, validation, sources, notes, timestamps.
- **models** — one row per canonical Make–Model. Unique on `(make_id, norm_model)`, so
  punctuation/spacing variants cannot duplicate. Carries the compressed
  `confirmed_model_years` text (semicolon-separated non-contiguous segments preserved),
  first/last year, lifecycle, category, market, origin, validation, sources, notes.
- **model_years** — the year text expanded into one row per (model, year). Unique on
  `(model_id, model_year)`. `year_status` is `Confirmed` or
  `Official Early/Future Model Year` (MY2027 records). Non-contiguous runs stay
  non-contiguous because only confirmed years are inserted.
- **submodels** — classified variant records. Unique on `(model_id, norm_submodel,
  submodel_type)`. `submodel_type` ∈ Sub-model, Series, Trim, Generation, Chassis, Body
  Style, Edition, Package, Other, Review Required. **No sub-model is approved
  automatically**: candidates derived from documented aliases carry
  `validation_status='Review Required'` until verified against an authoritative source.
- **submodel_years** — per-year support for approved sub-models (empty until sub-models are
  verified; the schema and exports are ready for it).

## Traceability tables

- **aliases** — raw/alias values → canonical ids, with `alias_type`, confidence, notes.
  Includes the raw source values from the original CSV (via the Model review stage) and
  variant spellings merged during import.
- **grouped_model_relationships** — one row per canonical model represented by a grouped
  compatibility value ("F-Series" → F-150/F-250/F-350).
- **validation_reviews** — unresolved candidates; `review_status` ∈ Pending, Approved,
  Rejected, Needs More Evidence, Corrected. Never promoted to canonical automatically.
- **sources** — authoritative source registry (EPA, NHTSA) with known limitations.
- **import_runs** — one row per imported file per run: SHA-256, rows read/imported/
  updated/rejected, validation status, error log.
- **audit_changes** — before/after values, timestamp, action type and reason for every
  manual change (review updates, backups).
- **coverage_report** — per-model-year source coverage from the catalog build.
- **catalog_meta** — key/value store: catalog version, research cutoff, last import.

## Indexes

Norm columns (`norm_make`, `norm_model`, `norm_submodel`, alias norms, grouped `norm_value`),
model year, lifecycle, validation status, category, and all foreign keys — covering every
filter the UI exposes.

## Design decisions

- **Variant merging**: the source master contains a handful of rows that differ only by
  punctuation/spacing ("CTS V"/"CTS-V", "300 M"/"300M"). The importer merges them into one
  canonical row (union of years), keeps the variant spelling as an alias, and logs the merge
  in the import report — nothing is silently dropped.
- **Sub-model conservatism**: values classified as Trim/Chassis/Generation in the source
  alias notes become Review Required candidates only. The approved sub-model count is 0
  until authoritative verification is added; the UI, exports and selector all respect this.
