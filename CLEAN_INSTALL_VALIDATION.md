# Clean Installation Validation — Version 5.1

Status: `Partially Verified — Clean-Room Directory Only`

This document records exactly what was tested and, just as importantly, what was
**not**. The distinction matters: a clean *directory* is not a clean *machine*,
and this report does not claim the stronger result.

## 1. What was actually done

The release package `US-Vehicle-Catalog-App-v5.1.zip` (7.1 MB) was extracted to a
directory that had never held any part of this project:

```
C:\Users\Asus\clean-install-test\Vehículo Catálogo Prüfung (v5.1)\US-Vehicle-Catalog-App-v5.1
```

The path was chosen deliberately to include **spaces**, **non-ASCII characters**
(`í`, `á`, `ü`) and **parentheses**, because those are the three things that most
often break Windows batch scripts and Node path handling. Installation ran with an
isolated npm cache (`npm_config_cache` pointed at a throwaway folder) so that no
previously downloaded package could mask a missing dependency declaration.

`setup-windows.bat` completed successfully in **63 seconds**.

## 2. Installation defects found and fixed

The clean-room run was worth doing: it surfaced two real defects that every
previous test had hidden, because the development directory already contained
the files the installer was implicitly relying on.

**Defect 1 — setup aborted on a populated release.** `setup-windows.bat`
unconditionally ran the catalog import, which failed with
`Catalog files not found: master, makes, alias...`. The release ships a
*populated* database and deliberately does not ship the raw catalog CSVs, so the
import step could never succeed. Fixed by adding a `catalog:import-if-present`
CLI command that imports when catalog files are present and reports "database
already populated" when they are not.

**Defect 2 — bundled master files were not detected.** `CATALOG_DIR` detection in
`server/db.ts` only recognised `_v2`-suffixed master files, so a V3/V4-era
`catalog-files/` directory was invisible to it. Fixed by checking `_v3`, `_v2` and
the unsuffixed base names in order.

Both fixes are in the shipped package; the 12-step functional check below ran
against the corrected release.

## 3. Twelve-step functional checklist

All steps executed against the extracted release on port 4318. Full machine-readable
results: `exports/clean_install_steps.json`.

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Extract release to a fresh directory | Pass | Non-ASCII path with spaces |
| 2 | `setup-windows.bat` installs and builds | Pass | 63 s, isolated npm cache |
| 3 | Server starts and serves the catalog API | Pass | `listening on http://127.0.0.1:4318` |
| 3b | Binds to localhost only | Pass | Banner reads "(local machine only)" |
| 4 | Upload the sample CSV | Pass | HTTP 200, 10 rows |
| 5 | Upload the sample XLSX | Pass | HTTP 200, 10 rows |
| 6 | Process both files | Pass | 10 rows each, outcome `Review Required` |
| 7 | Review and resolve a cross-brand conflict | Pass | Row 5, `Model` field |
| 8 | Export standardized CSV and XLSX | Pass | 3,481 B CSV / 8,680 B XLSX |
| 9 | Generate a change report | Pass | 16,352 B, 9 sheets |
| 10 | Create a database backup | Pass | `backups\catalog-2026-07-18T13-17-02-012Z.db` |
| 11 | Stop and restart the application | Pass | Second start clean |
| 12 | Project history survives the restart | Pass | 2 projects, row counts intact |

Overall functional result: **PASS (12 of 12)**.

## 4. What was NOT verified

**No genuine clean Windows environment was available on this machine.** Windows
Sandbox is not installed (`WindowsSandbox.exe` absent), the Hyper-V PowerShell
module is not present, no spare VM or fresh Windows user profile existed, and the
only container runtime available (Docker) provides Linux containers, which cannot
validate Windows batch scripts or a Windows install experience.

Per the explicit instruction not to treat a different folder on the same
configured development environment as a full clean-machine test, the following
remain **unverified**, not simulated:

- Installation on a machine with **no Node.js pre-installed** — the "Node.js was
  not found" branch of `setup-windows.bat` has been read but not executed on a
  machine that genuinely lacks Node.
- Behaviour under a **different Node major version** than the 24.x installed here.
- Windows **SmartScreen / Defender** prompts on first execution of the batch files.
- Behaviour under a **non-administrator account** with restrictive folder ACLs.
- A machine with **no Visual C++ build tooling**, where `better-sqlite3` would
  need to fall back to a prebuilt binary rather than compiling.

To complete verification, run the same 12-step checklist on a fresh Windows 10/11
installation or in Windows Sandbox, starting from a machine with no Node.js, and
record the results in a follow-up section here.

## 5. Honest summary

The release installs and runs correctly from a fresh directory with an awkward
path, and two genuine installation defects were found and fixed as a result. That
is a real and useful result. It is **not** clean-machine verification, and this
release should not be described as clean-machine verified.
