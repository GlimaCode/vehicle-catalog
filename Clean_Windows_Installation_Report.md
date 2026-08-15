# Clean Windows Installation Report — Version 5.1

**Clean Windows status: Partially Verified — isolated fresh-directory installation
passed, but a genuinely clean Windows Sandbox, virtual machine, or separate clean
host was unavailable.**

This report records precisely what was installed, what was exercised, and what
could not be verified. A clean *directory* is not a clean *machine*, and nothing
below should be read as clean-machine verification.

## 1. Environment

| Item | Value |
|---|---|
| Host OS | Windows 11 Pro 10.0.26200 |
| Node.js | v24.17.0 (pre-installed on the host) |
| Windows Sandbox | **Not installed** (`WindowsSandbox.exe` absent) |
| Hyper-V PowerShell module | **Not present** |
| Spare VM or second Windows profile | **Not available** |
| Container runtime available | Docker (Linux containers only — cannot validate Windows batch scripts) |

Because none of the isolation options existed on this host, the strongest test
available was a fresh-directory installation from the final release package with
an isolated npm cache. That is what was performed.

## 2. Installation under test

| Item | Value |
|---|---|
| Package | `US-Vehicle-Catalog-App-v5.1.zip` (final build) |
| Extraction path | `C:\Users\Asus\v51-final-install\Fahrzeugkatalog Prüfung (Größe)\US-Vehicle-Catalog-App-v5.1` |
| Path characteristics | Spaces, parentheses, and non-ASCII characters (`ü`, `ö`, `ß`) |
| npm cache | Isolated (`npm_config_cache` redirected to a throwaway folder) |
| Directory history | Newly created; never previously used by this project |

The path was chosen deliberately: spaces, parentheses and non-ASCII characters are
the three things that most often break Windows batch scripts and Node path
handling.

`setup-windows.bat` completed successfully in **1 minute 29 seconds**, installing
371 packages, initializing the database, skipping the catalog import (the release
ships a populated database), and building the frontend.

## 3. Installation defects found and fixed

The isolated installation was worth doing — it surfaced two real defects that
every earlier test had hidden, because the development directory already contained
the files the installer implicitly relied on.

**Defect 1 — setup aborted on a populated release.** `setup-windows.bat`
unconditionally ran the catalog import, which failed with
`Catalog files not found: master, makes, alias...`. The release ships a populated
database, so the import could never succeed. Fixed by adding a
`catalog:import-if-present` CLI command that imports when catalog files are
present and reports "Canonical catalog already present; skipping import" when they
are not.

**Defect 2 — bundled master files were not detected.** `CATALOG_DIR` detection in
`server/db.ts` recognised only `_v2`-suffixed master files, so a V3/V4-era
`catalog-files/` directory was invisible. Fixed by checking `_v3`, `_v2` and the
unsuffixed base names in order.

Both fixes are in the shipped package, and the checklist below ran against the
corrected release.

## 4. Post-package installation checklist (22 steps)

Executed against the **final** ZIP after its last repackaging. Machine-readable
results: `exports/post_package_steps.json`.

| # | Step | Result | Evidence |
|---|------|--------|----------|
| 1 | Extract the final ZIP to a fresh directory | Pass | Non-ASCII path with spaces and parentheses |
| 2 | Run `setup-windows.bat`; dependencies install | Pass | 371 packages, 1 m 29 s, isolated cache |
| 3 | Database initialization does not overwrite the populated canonical database | Pass | "Canonical catalog already present; skipping import"; all 9 canonical counts unchanged |
| 4 | Run `start-app.bat` | Pass | Server started and served the API |
| 5 | Server binds to `127.0.0.1` | Pass | `{"bindAddress":"127.0.0.1","allowLanAccess":false}` |
| 6 | Open the Dashboard | Pass | `/api/summary` reports 76 makes; SPA shell served |
| 7 | Open an existing canonical Make and Model page | Pass | AMC (2 models) → Eagle |
| 8 | Upload the bundled sample CSV | Pass | HTTP 200, 10 rows |
| 9 | Upload the bundled sample XLSX | Pass | HTTP 200, 10 rows |
| 10 | Map columns | Pass | 2/2 projects mapped |
| 11 | Process both projects | Pass | 2/2 processed, 10 rows each |
| 12 | Exact, alias, deterministic, no-match and conflict behaviour | Pass | All five observed: Exact Canonical Match, Approved Alias Match, Deterministic Normalization, No Match, Conflict |
| 13 | Make one review decision | Pass | Row 5, `Model` field, "Keep Original" |
| 14 | Export standardized CSV | Pass | 3,481 B, protection header `Enabled` |
| 15 | Export standardized XLSX | Pass | 8,681 B |
| 16 | Export the change-report workbook | Pass | 16,352 B |
| 17 | Create a database backup | Pass | `backups\catalog-<timestamp>.db` |
| 18 | Stop and restart the application | Pass | Second start clean |
| 19 | Project history remains available | Pass | 2 projects, row counts intact |
| 20 | Delete the test projects | Pass | 2 deleted, 0 remaining |
| 21 | Canonical counts remain unchanged | Pass | 76 / 1,798 / 15,594 / 390 / 2,504 / 6,859 / 43,465 / 206 / 119 |
| 22 | Stop all processes cleanly | Pass | No process left listening on the port |

**Result: PASS (22 of 22).**

### Defect found by this run

Step 20 initially **failed**. Deleting a project that had a recorded review
decision raised `SqliteError: FOREIGN KEY constraint failed`, because
`standardization_changes.row_id` references `standardization_rows(id)` and the
deletion removed rows before the changes that pointed at them. This had gone
unnoticed because the hardening test database never enabled
`PRAGMA foreign_keys`, so the constraint was not being enforced in tests.

Three fixes were applied and the checklist re-run to a full pass:

1. `server/retention.ts` — delete dependent change records before the rows.
2. `tests/hardening.test.ts` — enable `foreign_keys = ON` to match the running
   application, and add regression test 17b covering deletion of a project with
   review decisions.
3. `server/standardize/api.ts` — a delete targeting a nonexistent project now
   returns HTTP 404 instead of reporting success.

## 5. What was NOT verified

The following remain **unverified** — not simulated, not inferred:

- Installation on a machine with **no Node.js pre-installed**. The "Node.js was
  not found" branch of `setup-windows.bat` has been read but never executed on a
  host that genuinely lacks Node.
- Behaviour under a **different Node major version** than the 24.17.0 installed here.
- **SmartScreen / Defender** prompts on first execution of the batch files.
- Behaviour under a **non-administrator account** with restrictive folder ACLs.
- A machine with **no Visual C++ build tooling**, where `better-sqlite3` would
  need a prebuilt binary rather than compiling.
- Behaviour on **Windows 10**, or on any Windows build other than this host's.

To complete verification, run the 22-step checklist above on a fresh Windows 10/11
installation or in Windows Sandbox, starting from a host with no Node.js, and
record the results in a follow-up section here.

## 6. Honest summary

The final package installs and runs correctly from a fresh directory with an
awkward path, all 22 functional steps pass, and three genuine defects were found
and fixed as a direct result of running these tests. That is a real and useful
result.

It is **not** clean-machine verification. The status stays
**Partially Verified**, and this release must not be described as verified on a
clean Windows machine.
