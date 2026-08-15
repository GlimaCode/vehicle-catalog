/** SQLite connection + normalized schema for the US Make/Model catalog. */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(APP_ROOT, "data");
export const BACKUP_DIR = path.join(APP_ROOT, "backups");
export const EXPORT_DIR = path.join(APP_ROOT, "exports");
/**
 * Database selection: an explicit CATALOG_DB always wins; otherwise the app
 * prefers the Phase 2 database (catalog-v2.db) when it exists, while the
 * Phase 1 database remains untouched at data/catalog.db.
 */
const VERSIONED_DBS = ["catalog-v6.db", "catalog-v5.1.db", "catalog-v5.db",
  "catalog-v4.db", "catalog-v3.db", "catalog-v2.db", "catalog.db"]
  .map((f) => path.join(DATA_DIR, f));
export const DB_PATH = process.env.CATALOG_DB ??
  (VERSIONED_DBS.find((p) => fs.existsSync(p)) ?? VERSIONED_DBS[VERSIONED_DBS.length - 1]);
/** Isolated workspace for uploaded files and per-project generated outputs. */
export const UPLOAD_DIR = process.env.CATALOG_UPLOADS ?? path.join(APP_ROOT, "uploads");
export const PROJECT_EXPORT_DIR = path.join(EXPORT_DIR, "standardization");
/**
 * Directory holding the catalog CSV files. Resolution order:
 * 1. CATALOG_DIR environment variable
 * 2. ./catalog-files inside the app (portable release layout)
 * 3. the parent directory (development layout)
 * No path is hard-coded; the app works from any extracted folder.
 */
const BUNDLED_CATALOG = path.join(APP_ROOT, "catalog-files");
const BUNDLED_MASTERS = ["_v3", "_v2", ""].map((suffix) =>
  path.join(BUNDLED_CATALOG, `Complete_US_Make_Model_Catalog_1980_to_2026-07-15${suffix}.csv`));
export const CATALOG_DIR = process.env.CATALOG_DIR ??
  (BUNDLED_MASTERS.some((p) => fs.existsSync(p))
    ? BUNDLED_CATALOG : path.resolve(APP_ROOT, ".."));

for (const d of [DATA_DIR, BACKUP_DIR, EXPORT_DIR]) fs.mkdirSync(d, { recursive: true });
for (const d of [process.env.CATALOG_UPLOADS ?? path.join(APP_ROOT, "uploads"),
  path.join(EXPORT_DIR, "standardization")]) fs.mkdirSync(d, { recursive: true });

let _db: Database.Database | null = null;

export function getDb(dbPath: string = DB_PATH): Database.Database {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Normalization used for dedup keys and punctuation/hyphen-insensitive
 * search. `+` is retained because it is semantically significant in model
 * names (Lexus RX 450h vs RX 450h+ are different vehicles).
 */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9+]/g, "");
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS makes (
  id INTEGER PRIMARY KEY,
  standard_make TEXT NOT NULL UNIQUE,
  official_display_name TEXT NOT NULL,
  us_market_start_year INTEGER,
  us_market_end_year INTEGER,
  lifecycle_status TEXT NOT NULL,
  present_in_original_source TEXT NOT NULL,
  catalog_origin TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  primary_source_name TEXT, primary_source_url TEXT,
  secondary_source_name TEXT, secondary_source_url TEXT,
  notes TEXT,
  norm_make TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_makes_norm ON makes(norm_make);
CREATE INDEX IF NOT EXISTS idx_makes_lifecycle ON makes(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_makes_validation ON makes(validation_status);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  make_id INTEGER NOT NULL REFERENCES makes(id),
  standard_model TEXT NOT NULL,
  confirmed_model_years TEXT NOT NULL,
  first_confirmed_model_year INTEGER NOT NULL,
  last_confirmed_model_year INTEGER NOT NULL,
  lifecycle_status TEXT NOT NULL,
  vehicle_category TEXT NOT NULL,
  market TEXT NOT NULL,
  present_in_original_source TEXT NOT NULL,
  catalog_origin TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  primary_source_name TEXT, primary_source_url TEXT,
  secondary_source_name TEXT, secondary_source_url TEXT,
  source_access_date TEXT,
  notes TEXT,
  norm_model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (make_id, norm_model)
);
CREATE INDEX IF NOT EXISTS idx_models_make ON models(make_id);
CREATE INDEX IF NOT EXISTS idx_models_norm ON models(norm_model);
CREATE INDEX IF NOT EXISTS idx_models_name ON models(standard_model);
CREATE INDEX IF NOT EXISTS idx_models_lifecycle ON models(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_models_validation ON models(validation_status);
CREATE INDEX IF NOT EXISTS idx_models_category ON models(vehicle_category);

CREATE TABLE IF NOT EXISTS model_years (
  id INTEGER PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES models(id),
  model_year INTEGER NOT NULL,
  year_status TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  source_name TEXT, source_url TEXT,
  notes TEXT,
  UNIQUE (model_id, model_year)
);
CREATE INDEX IF NOT EXISTS idx_model_years_year ON model_years(model_year);
CREATE INDEX IF NOT EXISTS idx_model_years_model ON model_years(model_id);

CREATE TABLE IF NOT EXISTS submodels (
  id INTEGER PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES models(id),
  standard_submodel TEXT NOT NULL,
  submodel_type TEXT NOT NULL,
  first_confirmed_model_year INTEGER,
  last_confirmed_model_year INTEGER,
  confirmed_model_years TEXT,
  validation_status TEXT NOT NULL,
  source_name TEXT, source_url TEXT,
  notes TEXT,
  norm_submodel TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (model_id, norm_submodel, submodel_type)
);
CREATE INDEX IF NOT EXISTS idx_submodels_model ON submodels(model_id);
CREATE INDEX IF NOT EXISTS idx_submodels_norm ON submodels(norm_submodel);
CREATE INDEX IF NOT EXISTS idx_submodels_type ON submodels(submodel_type);
CREATE INDEX IF NOT EXISTS idx_submodels_validation ON submodels(validation_status);

CREATE TABLE IF NOT EXISTS submodel_years (
  id INTEGER PRIMARY KEY,
  submodel_id INTEGER NOT NULL REFERENCES submodels(id),
  model_year INTEGER NOT NULL,
  validation_status TEXT NOT NULL,
  source_name TEXT, source_url TEXT,
  notes TEXT,
  UNIQUE (submodel_id, model_year)
);

CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY,
  raw_or_alias_make TEXT NOT NULL,
  raw_or_alias_model TEXT NOT NULL,
  raw_or_alias_submodel TEXT,
  canonical_make_id INTEGER REFERENCES makes(id),
  canonical_model_id INTEGER REFERENCES models(id),
  canonical_submodel_id INTEGER REFERENCES submodels(id),
  alias_type TEXT NOT NULL,
  source_file_or_source_name TEXT,
  confidence TEXT,
  notes TEXT,
  norm_make TEXT NOT NULL,
  norm_model TEXT NOT NULL,
  UNIQUE (norm_make, norm_model, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_aliases_norm_model ON aliases(norm_model);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases(canonical_model_id);

CREATE TABLE IF NOT EXISTS grouped_model_relationships (
  id INTEGER PRIMARY KEY,
  raw_make TEXT NOT NULL,
  raw_grouped_model_value TEXT NOT NULL,
  canonical_make_id INTEGER REFERENCES makes(id),
  canonical_model_id INTEGER REFERENCES models(id),
  relationship_status TEXT NOT NULL,
  evidence TEXT,
  notes TEXT,
  norm_value TEXT NOT NULL,
  UNIQUE (raw_make, norm_value, canonical_make_id, canonical_model_id)
);
CREATE INDEX IF NOT EXISTS idx_grouped_norm ON grouped_model_relationships(norm_value);
CREATE INDEX IF NOT EXISTS idx_grouped_model ON grouped_model_relationships(canonical_model_id);

CREATE TABLE IF NOT EXISTS validation_reviews (
  id INTEGER PRIMARY KEY,
  candidate_make TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  candidate_submodel TEXT,
  candidate_model_years TEXT,
  issue_type TEXT NOT NULL,
  reason_not_approved TEXT NOT NULL,
  primary_source_name TEXT, primary_source_url TEXT,
  secondary_source_name TEXT, secondary_source_url TEXT,
  recommended_next_action TEXT,
  review_status TEXT NOT NULL DEFAULT 'Pending',
  notes TEXT,
  UNIQUE (candidate_make, candidate_model, issue_type)
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON validation_reviews(review_status);
CREATE INDEX IF NOT EXISTS idx_reviews_issue ON validation_reviews(issue_type);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  source_name TEXT NOT NULL UNIQUE,
  source_url TEXT,
  source_type TEXT,
  access_date TEXT,
  evidence_type TEXT,
  known_limitations TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  import_timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  input_filename TEXT NOT NULL,
  input_file_hash TEXT NOT NULL,
  rows_read INTEGER NOT NULL,
  rows_imported INTEGER NOT NULL,
  rows_updated INTEGER NOT NULL,
  rows_rejected INTEGER NOT NULL,
  validation_status TEXT NOT NULL,
  error_log TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS audit_changes (
  id INTEGER PRIMARY KEY,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  action_type TEXT NOT NULL,
  entity_table TEXT NOT NULL,
  entity_id INTEGER,
  before_value TEXT,
  after_value TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS coverage_report (
  id INTEGER PRIMARY KEY,
  model_year INTEGER NOT NULL UNIQUE,
  verified_make_count INTEGER,
  verified_model_count INTEGER,
  government_source_coverage TEXT,
  manufacturer_source_coverage TEXT,
  discrepancy_count INTEGER,
  unresolved_candidate_count INTEGER,
  coverage_status TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initSchema(db: Database.Database): void {
  db.exec(SCHEMA);
  runMigrations(db);          // additive migrations (Phase 2+); never destructive
}
