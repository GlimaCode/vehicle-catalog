/**
 * Canonical read-only guard (hardened in Version 5.1).
 *
 * The canonical catalog (makes, models, hierarchy, configuration, aliases and
 * their year tables) is protected by SQLite triggers. Writes are only possible
 * inside `withCanonicalUnlocked()`, which:
 *
 *   1. requires the private importer token, so no caller can unlock the
 *      catalog without importing this module's token deliberately;
 *   2. refuses to run inside a standardization request context, so nothing
 *      reachable from the file-standardization API can unlock the catalog;
 *   3. takes a callback - never SQL text - so no caller-supplied SQL is run;
 *   4. refuses to nest;
 *   5. always restores the lock in `finally`, including on crash or rejection.
 *
 * Every unlock is recorded in `security_events`.
 */
import type Database from "better-sqlite3";

/** Private token. Only the canonical importers import this. */
export const CANONICAL_IMPORTER_TOKEN: unique symbol = Symbol("canonical-importer");
export type CanonicalImporterToken = typeof CANONICAL_IMPORTER_TOKEN;

let standardizationDepth = 0;
let unlockDepth = 0;

/** Marks a scope as "ordinary application work" - canonical writes are refused. */
export function enterStandardizationContext(): void { standardizationDepth++; }
export function exitStandardizationContext(): void {
  standardizationDepth = Math.max(0, standardizationDepth - 1);
}
export function inStandardizationContext(): boolean { return standardizationDepth > 0; }

export function isCanonicalUnlocked(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM catalog_meta WHERE key='canonical_unlocked'")
    .get() as { value: string } | undefined;
  return row?.value === "1";
}

function setFlag(db: Database.Database, value: "0" | "1"): void {
  db.prepare(`INSERT INTO catalog_meta (key, value) VALUES ('canonical_unlocked', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(value);
}

function recordEvent(db: Database.Database, detail: Record<string, unknown>): void {
  try {
    db.prepare(`INSERT INTO security_events (event_type, detail)
      VALUES ('canonical-unlock', ?)`).run(JSON.stringify(detail));
  } catch { /* security_events may not exist on very old databases */ }
}

/**
 * Run `fn` with the canonical catalog temporarily writable.
 * Only the canonical catalog importers may call this.
 */
export function withCanonicalUnlocked<T>(db: Database.Database,
  arg2: CanonicalImporterToken | (() => T), arg3?: () => T): T {
  // Backwards-compatible signature: (db, fn) is rejected unless a token is given.
  const token = typeof arg2 === "function" ? undefined : arg2;
  const fn = (typeof arg2 === "function" ? arg2 : arg3) as (() => T) | undefined;
  if (!fn) throw new Error("withCanonicalUnlocked requires a callback");
  if (token !== CANONICAL_IMPORTER_TOKEN) {
    throw new Error("Canonical catalog unlock refused: the importer token is required. "
      + "The Version 4 catalog is read-only for all ordinary operations.");
  }
  if (inStandardizationContext()) {
    throw new Error("Canonical catalog unlock refused: a file-standardization operation "
      + "is in progress. Standardization can never modify the canonical catalog.");
  }
  if (unlockDepth > 0) {
    throw new Error("Canonical catalog unlock refused: nested unlock attempts are not allowed.");
  }
  const startedAt = new Date().toISOString();
  unlockDepth++;
  setFlag(db, "1");
  try {
    const result = fn();
    recordEvent(db, { startedAt, outcome: "committed" });
    return result;
  } catch (e) {
    recordEvent(db, { startedAt, outcome: "failed", error: String(e).slice(0, 300) });
    throw e;
  } finally {
    // always restore, even on crash/rejection
    setFlag(db, "0");
    unlockDepth = Math.max(0, unlockDepth - 1);
  }
}

/** Test/diagnostic helper: is the process currently inside an unlock? */
export function unlockInProgress(): boolean { return unlockDepth > 0; }
