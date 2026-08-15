# Safe file handling guide

Every uploaded file is treated as hostile until it has been inspected.

## The inspection pipeline

1. **Size check** against `upload.maxFileBytes` (default 512 MB).
2. **Extension check** against `upload.allowedExtensions` (`.csv`, `.txt`, `.xlsx`).
3. **Signature detection** from the file's magic bytes:
   `PK\x03\x04` → ZIP/XLSX, `D0 CF 11 E0` → legacy OLE2 Excel, otherwise text.
4. **Extension vs signature** must agree. A ZIP renamed `data.csv` is rejected;
   a CSV renamed `book.xlsx` is rejected.
5. **Macro rejection**: `.xlsm`, `.xltm`, `.xlsb`, `.xls`, or any workbook
   containing `vbaProject.bin`, is refused unless
   `upload.allowMacroEnabledWorkbooks` is deliberately turned on.
6. **ZIP central-directory inspection** (no decompression): entry count,
   declared uncompressed size, per-entry compression ratio, worksheet count,
   shared-string size, and unsafe entry names.
7. **Post-parse limits**: rows, columns, total cells and per-cell length.

Rejections return HTTP 415 with the exact reasons and are written to
`security_events`.

## Configured limits

These are the values the shipped `config/app-config.json` applies. Verified
against the running configuration by `scripts/workbook_limits.mjs`; results in
`exports/Workbook_Limits_Verification.json`.

| Limit | Configured value |
|---|---|
| Maximum upload size | 512 MB (536,870,912 bytes) |
| Maximum compressed XLSX size | 512 MB (the same upload ceiling) |
| Maximum total uncompressed size | 2 GB (2,147,483,648 bytes) |
| Maximum decompression ratio | 200:1 |
| Maximum ZIP entries | 2,000 |
| Maximum worksheets | 64 |
| Maximum rows | 1,000,000 |
| Maximum columns | 1,024 |
| Maximum total cells | 50,000,000 |
| Maximum shared-string size | 256 MB (268,435,456 bytes) |
| Maximum individual cell length | 32,767 characters (Excel's own limit) |
| Allowed extensions | `.csv`, `.txt`, `.xlsx` |
| Macro-enabled workbooks | Not allowed |

Cells longer than the maximum are truncated to 32,767 characters rather than
rejecting the whole file, and the truncation is recorded.

## What is never executed

VBA macros · external workbook links · embedded objects · DDE fields · cell
formulas · scripts. The reader extracts cell **values** only. A workbook that
declares external links is accepted (values only) with a recorded warning.

## Storage layout

```
catalog-app/
  uploads/                    <- stored uploads, named by storage ID only
  exports/standardization/
    project-<id>/             <- per-project outputs, derived from the numeric ID
```

Original filenames live in the database (`display_filename`), not on disk.

## Generated files are written atomically

Outputs are written to `<final>.<id>.part` and renamed into place only after a
successful write. If the process dies mid-export, the partial file is removed at
next startup and the real filename never appears. Disk-full, permission-denied,
locked-file (open in Excel) and unavailable-destination errors are reported in
plain language, and no partial file is kept.

## Large or hostile files

- Files stream from disk; nothing is loaded whole into memory or the browser.
- Processing runs in batches with progress, cancel and resume.
- Limits are configurable in `config/app-config.json`; raising them is a
  deliberate decision, and the rationale for each default is in `SECURITY_GUIDE.md`.

## If you must accept a macro-enabled workbook

Convert it to `.xlsx` in Excel first (which drops the macros). Only enable
`allowMacroEnabledWorkbooks` if you fully trust the source; the application still
never executes macros, but the extension check is your first line of defence.
