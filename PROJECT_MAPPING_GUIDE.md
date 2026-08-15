# Project mappings vs canonical aliases

Two different things look similar and must not be confused.

## Canonical aliases (Version 4 catalog)

- Live in the `aliases` table of the canonical catalog.
- Were established by the multi-phase research process with authoritative evidence
  (EPA, NHTSA, official manufacturer documents).
- Apply to **every** project automatically, with confidence `Approved Alias Match`.
- Examples: `ford` → `Ford`, `Mercedes Benz` → `Mercedes-Benz`, `Excrision` → `Excursion`,
  `Range` + `Rover Sport` → `Land Rover` + `Range Rover Sport`.
- **Read-only.** SQLite triggers reject any insert/update/delete on canonical tables unless
  the catalog importer explicitly unlocks them (`withCanonicalUnlocked`), which only the
  documented catalog release process does.

## Project mappings (this workspace)

- Live in `project_value_mappings`, scoped to a single standardization project.
- Created by you in the review workspace, usually through
  *Apply to All Identical Values*.
- Apply only to that project, including on reprocessing.
- Never modify the canonical catalog, and never become canonical aliases by themselves.

## Promoting a project mapping

If a project mapping looks like a genuine catalog gap, an Admin can raise a
**catalog change proposal** (`catalog_change_proposals` table, `POST /api/std/proposals`)
recording:

- the proposed record type (alias, model, hierarchy value, …),
- the raw value and the proposed canonical value,
- Make/Model context,
- supporting project IDs and occurrence count,
- evidence and reviewer notes,
- a status of `Proposed`, `Under Review`, `Accepted` or `Rejected`.

A proposal changes nothing on its own. Promotion into the canonical catalog requires
authoritative evidence and a new catalog release (a new versioned database and workbook),
exactly as Versions 2–4 were produced.
