/**
 * Creates data/catalog-v6.db from the frozen Version 5.1 database, applies
 * migration 008, and seeds the default title rules, abbreviations and
 * templates. Canonical tables are copied verbatim and never rewritten.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../server/migrate.ts";
import { seedTitleCatalogs } from "../server/title/seed.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(APP, "data", "catalog-v5.1.db");
const DEST = path.join(APP, "data", "catalog-v6.db");

if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);
for (const f of [DEST, `${DEST}-wal`, `${DEST}-shm`]) fs.rmSync(f, { force: true });

// VACUUM INTO produces a self-contained copy with no WAL dependency
const src = new Database(SRC, { readonly: true });
src.exec(`VACUUM INTO '${DEST.replace(/\\/g, "/").replace(/'/g, "''")}'`);
src.close();

const db = new Database(DEST);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const applied = runMigrations(db);
const seeded = seedTitleCatalogs(db);

const CANONICAL = ["makes", "models", "model_years", "vehicle_hierarchy_values",
  "hierarchy_value_years", "vehicle_configuration_values",
  "configuration_value_years", "aliases", "grouped_model_relationships"];
const counts = Object.fromEntries(CANONICAL.map((t) =>
  [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));

db.pragma("wal_checkpoint(TRUNCATE)");
const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
const fk = db.prepare("PRAGMA foreign_key_check").all();
const triggers = db.prepare(
  "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").pluck().get();
const titleTables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'title%'
   ORDER BY name`).pluck().all();
db.close();
for (const f of [`${DEST}-wal`, `${DEST}-shm`]) fs.rmSync(f, { force: true });

console.log(JSON.stringify({
  database: DEST,
  megabytes: Number((fs.statSync(DEST).size / 1048576).toFixed(2)),
  migrationsApplied: applied,
  titleTables,
  seeded,
  canonicalCounts: counts,
  integrity, foreignKeyViolations: fk.length, triggers,
}, null, 2));
