# File Standardization guide

The File Standardization workspace turns a messy automotive CSV or Excel file into one
standardized against the frozen **Version 4 canonical catalog** — without ever changing that
catalog.

## Workflow

| Step | Page | What happens |
|---|---|---|
| 1 | **Upload file** | Store the file unchanged in `uploads/`, detect encoding/worksheets, preview headers and the first 20 rows. Creates a project. |
| 2 | **Map columns** | Assign each source column to a canonical field, `Ignore`, or `Preserve as Custom Field`. Save/load mapping templates. |
| 3 | **Process file** | Run the normalization pipeline in batches with progress, cancel and resume. |
| 4 | **Review matches** | Resolve everything uncertain. Nothing uncertain is applied silently. |
| 5 | **Export results** | Standardized CSV/XLSX (audit mode by default), change report, review workbook, value mappings, JSON report. |

## Supported input

- CSV: RFC-4180 (quoted commas, embedded line breaks), UTF-8, UTF-8 with BOM, UTF-16 LE,
  and Windows-1252 when it is safely detectable (a buffer that fails strict UTF-8 decoding).
- XLSX: multi-worksheet workbooks; you choose the worksheet and the header row.
- Duplicate column names are made unique (`Make`, `Make (2)`) rather than dropped.
- Empty cells, large text fields and files of 100,000+ rows are supported.

## Supported canonical fields

`Make`, `Model`, `Sub-model`, `Trim`, `Series`, `Edition`, `Generation`, `Chassis`,
`Model Year`, `Year Range`, `Engine`, `Drivetrain`, `Body Style`, `Package`, `Title`,
`Item ID`, `SKU`, `Other`.

Not every field is required, but **Make or Model must be mapped** before vehicle
standardization can run.

## Normalization pipeline order

1. Raw-value cleanup
2. Make resolution
3. Model resolution *inside the resolved Make*
4. Hierarchy resolution *inside the resolved Make + Model*
5. Model-year validation
6. Configuration validation
7. Relationship validation (cross-brand conflicts, trim-vs-configuration)
8. Confidence assignment
9. Review-queue creation
10. User-approved corrections

Models are never resolved globally when a Make is available, and Trims are never resolved
without both Make and Model context.

## What the pipeline will not do

- It will not treat a Trim, Engine, Chassis, Body Style or Package value as a Model.
- It will not put a configuration value (e.g. `AWD`, `2.0T`, `Crew Cab`) into a hierarchy
  column — it reports the correct classification as a conflict instead.
- It will not invent a hierarchy value that is not approved in Version 4.
- It will not delete an invalid year; it flags it and keeps the original.
- It will not merge Makes because they share a parent company, and it will not silently
  move Dodge to Ram (or back) without model-year evidence.

## Statuses

Project status: `Uploaded`, `Mapped`, `Processing`, `Review Required`, `Ready to Export`,
`Exported`, `Failed`.

Reported outcome: `Standardized`, `Standardized with Warnings`, `Review Required`,
`Partially Standardized`, `Failed`. A file is never reported as `Standardized` while any
unresolved conflict remains.
