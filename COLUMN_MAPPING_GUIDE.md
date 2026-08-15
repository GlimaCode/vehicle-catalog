# Column mapping guide

## Choosing a field per column

Each source column gets exactly one of:

- a **canonical field** (`Make`, `Model`, `Trim`, `Model Year`, …),
- **`Ignore`** — the column is not used for standardization and is dropped from the export
  when "preserve unmapped columns" is off,
- **`Preserve as Custom Field`** — the column is carried through the export untouched.

The mapper pre-selects a sensible guess from the header name; always check it.

## Header row

If the real header is not the first row (title banners, export notes), set **Header row** to
the correct row number. The preview and the mapping table reload immediately.

## Two columns, one field

Mapping two columns to the same canonical field is rejected unless you choose a merge
strategy on those columns:

| Strategy | Behaviour |
|---|---|
| `First non-empty` | Use the first column that has a value. |
| `Concatenate` | Join the values with a space. |
| `Combine into Year Range` | Build `start-end` from two year columns (e.g. `Year From` + `Year To` → `2006-2008`). |

## Preserving unmapped columns

Leave **Preserve unmapped columns in the export** enabled (the default) to keep every
original column in the output file. `Title`, `Item ID`, `SKU` and custom columns are never
altered unless you map them and authorize the change through Replacement mode.

## Mapping templates

Save a mapping once and reuse it for recurring layouts. Templates store the header row,
per-column field assignments, merge strategies and the preserve-unmapped flag.

Suggested names: `eBay Listing Export`, `Master Catalog`, `Competitor File`,
`Make Model Source`, `Seat Cover Inventory`.

Loading a template matches columns by header name first and falls back to column position,
so a file with the same headers in a different order still maps correctly. Templates can be
duplicated and deleted on the **Mapping templates** page.
