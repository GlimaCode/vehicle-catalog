# Canonical immutability security audit (Version 5.1)

Scope: every code path capable of writing to the canonical Version 4 catalog
(`makes`, `models`, `model_years`, `vehicle_hierarchy_values`,
`hierarchy_value_years`, `vehicle_configuration_values`,
`configuration_value_years`, `aliases`, `grouped_model_relationships`).

## Enforcement model

1. **Database-level.** Migration `006_canonical_readonly_guard` installs 27 SQLite
   triggers (9 tables × INSERT/UPDATE/DELETE). Each aborts with
   `canonical catalog is read-only (Version 4 baseline is frozen)` unless
   `catalog_meta.canonical_unlocked = '1'`. This applies to *every* connection,
   including `sqlite3` opened by hand.
2. **Application-level.** The only way to set that flag is
   `withCanonicalUnlocked()` in `server/canonical_lock.ts`, which:
   - requires the private `CANONICAL_IMPORTER_TOKEN` symbol (exported from that
     module and imported only by the four catalog importers);
   - refuses to run while a standardization request is in flight
     (`inStandardizationContext()`);
   - refuses to nest;
   - accepts a **callback**, never SQL text, so no caller-supplied SQL executes;
   - restores the lock in `finally`, so a crash, throw or rejected import cannot
     leave the catalog writable;
   - records every unlock in `security_events`.
3. **Request-level.** `server/standardize/api.ts` wraps the entire `/api/std`
   router in `enterStandardizationContext()` / `exitStandardizationContext()`.
   Nothing reachable from the file-standardization workspace can unlock the
   catalog, even if it imported the token.

## Every call site

| # | Location | Purpose | Why it is safe |
|---|---|---|---|
| 1 | `server/importer.ts:544` (`runImport`) | Imports the canonical Make/Model catalog CSVs | Explicit catalog importer. Passes the token, runs one `db.transaction`, validates mandatory checks and rolls back on failure. Reachable only from `npm run catalog:import` (CLI) and the Admin *Import catalog* action, never from `/api/std`. |
| 2 | `server/importer_v2.ts:210` (`runImportV2`) | Imports the V2 sub-model/hierarchy catalog | Same pattern; token required; transactional. |
| 3 | `server/importer_v3.ts:211` (`runImportV3`) | Imports the V3 hierarchy/configuration split | Same pattern; token required; transactional. |
| 4 | `server/importer_v4.ts:187` (`runImportV4`) | Imports the V4 researched hierarchy | Same pattern; token required; transactional. |

No other module imports `CANONICAL_IMPORTER_TOKEN`, and no other module calls
`withCanonicalUnlocked`. Verify with:

```bash
grep -rn "withCanonicalUnlocked\|CANONICAL_IMPORTER_TOKEN" server/
```

## Paths that deliberately cannot unlock

| Path | Behaviour |
|---|---|
| Any `/api/std/*` route (upload, mapping, processing, review, export, deletion, retention) | Runs inside the standardization context; an unlock attempt throws. Verified by test 15. |
| Project value mappings and "Apply to All Identical Values" | Write only to `project_value_mappings`; canonical alias count is asserted unchanged (V5 test 31). |
| Catalog change proposals (`POST /api/std/proposals`) | Insert into `catalog_change_proposals` only. A proposal changes nothing until a new catalog release. |
| Backup (`VACUUM INTO`) | Read-only against the source database; the copy inherits the same triggers, so a restored database is still protected. |
| Restore (`npm run db:restore`) | Replaces the database file with a backup that already carries the triggers. It cannot be used to smuggle in an unlocked catalog *and* keep the app's protection, because `initSchema()` re-applies migration 006 on next start. Restore also takes the global lock, so it cannot run while jobs are active. |
| Direct SQLite access by a user | Triggers still fire; writes abort. Verified by hardening test 15. |

## Failure-mode verification

| Scenario | Expected | Test |
|---|---|---|
| Unlock without the token | throws `importer token is required` | Hardening 15 |
| Unlock inside a standardization request | throws `standardization operation is in progress` | Hardening 15 |
| Importer throws mid-transaction | flag restored to `'0'`, canonical writes blocked again | Hardening 16 |
| Direct `UPDATE makes` / `INSERT models` / `DELETE hierarchy` | aborts with `read-only` | Hardening 15, V5 test 30 |
| Shipped release database | `canonical_unlocked` is `'0'` and 27 triggers present | Release DB inspection |

## Residual risk

- A developer with write access to the source tree could import the token into a
  new module. This is a code-review boundary, not a runtime one; the audit table
  above is the review checklist, and `security_events` records every unlock that
  actually happens at runtime.
- Someone with filesystem access could replace `catalog-v5.1.db` wholesale.
  Filesystem access is outside the application's trust boundary; the mitigation
  is the SHA-256 manifest of release artifacts plus `PRAGMA integrity_check`
  in the release-database inspection.
