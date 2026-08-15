# Export guide

## Complete Excel workbook

`npm run export:excel` writes
`exports/Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx`.
The same workbook can be downloaded from the app (Admin page or Models page) at
`/api/export/excel`, generated fresh from the database on every request.

Worksheets (all with frozen bold header rows, auto filters, sized columns, wrapped notes,
hyperlinked source URLs, no merged cells, one normalized row per record):

| Sheet | Content | One row per |
|---|---|---|
| Makes | all makes + model/sub-model counts | Make |
| Models | canonical catalog, sorted Make → Model → first year | Make–Model |
| Submodels | **approved** sub-models only | Make–Model–Sub-model |
| Model Years | year matrix, sorted Year → Make → Model | Make–Model–Year |
| Submodel Years | approved sub-model year matrix | Make–Model–Sub-model–Year |
| Aliases | raw/alias → canonical mappings | alias |
| Grouped Models | compatibility-group relationships | member model |
| Review Required | unresolved candidates (kept separate from approved data) | candidate |
| Sources | source registry with limitations | source |
| Catalog Summary | version, cutoff, export timestamp, totals, counts by lifecycle/validation/category/decade | metric |

Review-required data never appears inside approved worksheets, and grouped compatibility
strings are never emitted as single artificial models.

## CSV exports

- `/api/export/csv/makes|submodels|aliases|reviews|model-years|sources`
- `/api/export/models.csv?<filters>` — **filtered model export**: accepts exactly the same
  query parameters as the Models browser (make, q, year, category, lifecycle, validation,
  original, origin, active, hasSubmodels, hasWarnings, sort, dir) and reproduces the visible
  filtered result. The Models page "Export current filtered result" button passes the live
  filter state through.

All CSV output is RFC 4180-quoted (embedded commas/quotes/newlines safe).

## Regenerating after data changes

Exports read the database at request time — re-import, then re-export. The Admin page also
has a "Regenerate workbook in exports/" button that rewrites the on-disk workbook.
