/**
 * Schema migrations. Additive only - Phase 1 databases are never destroyed.
 * Migration 002 extends `submodels` for the Phase 2 hierarchy: raw source
 * values, catalog origin, secondary source, lifecycle/category, review status.
 */
import type Database from "better-sqlite3";

const MIGRATIONS: { id: string; apply: (db: Database.Database) => void }[] = [
  {
    id: "002_v2_submodels",
    apply: (db) => {
      const cols = new Set((db.prepare("PRAGMA table_info(submodels)").all() as
        { name: string }[]).map((c) => c.name));
      const add = (name: string, ddl: string) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE submodels ADD COLUMN ${name} ${ddl}`);
      };
      add("secondary_source_name", "TEXT");
      add("secondary_source_url", "TEXT");
      add("raw_source_value", "TEXT");
      add("catalog_origin", "TEXT DEFAULT ''");
      add("present_in_original_source", "TEXT DEFAULT 'No'");
      add("lifecycle_status", "TEXT DEFAULT ''");
      add("vehicle_category", "TEXT DEFAULT ''");
      add("market", "TEXT DEFAULT 'United States'");
      add("review_status", "TEXT DEFAULT 'Approved'");
      const rcols = new Set((db.prepare("PRAGMA table_info(validation_reviews)").all() as
        { name: string }[]).map((c) => c.name));
      if (!rcols.has("possible_classification")) {
        db.exec("ALTER TABLE validation_reviews ADD COLUMN possible_classification TEXT");
      }
    },
  },
  {
    id: "003_review_submodel_uniqueness",
    apply: (db) => {
      // Sub-model candidates need candidate_submodel inside the uniqueness key;
      // SQLite table constraints cannot be altered, so rebuild additively.
      db.exec(`
        CREATE TABLE IF NOT EXISTS validation_reviews_new (
          id INTEGER PRIMARY KEY,
          candidate_make TEXT NOT NULL,
          candidate_model TEXT NOT NULL,
          candidate_submodel TEXT NOT NULL DEFAULT '',
          candidate_model_years TEXT,
          issue_type TEXT NOT NULL,
          reason_not_approved TEXT NOT NULL,
          primary_source_name TEXT, primary_source_url TEXT,
          secondary_source_name TEXT, secondary_source_url TEXT,
          recommended_next_action TEXT,
          review_status TEXT NOT NULL DEFAULT 'Pending',
          notes TEXT,
          possible_classification TEXT,
          UNIQUE (candidate_make, candidate_model, candidate_submodel, issue_type)
        );
        INSERT OR IGNORE INTO validation_reviews_new (id, candidate_make,
          candidate_model, candidate_submodel, candidate_model_years, issue_type,
          reason_not_approved, primary_source_name, primary_source_url,
          secondary_source_name, secondary_source_url, recommended_next_action,
          review_status, notes, possible_classification)
        SELECT id, candidate_make, candidate_model, COALESCE(candidate_submodel, ''),
          candidate_model_years, issue_type, reason_not_approved,
          primary_source_name, primary_source_url, secondary_source_name,
          secondary_source_url, recommended_next_action, review_status, notes,
          possible_classification
        FROM validation_reviews;
        DROP TABLE validation_reviews;
        ALTER TABLE validation_reviews_new RENAME TO validation_reviews;
        CREATE INDEX IF NOT EXISTS idx_reviews_status ON validation_reviews(review_status);
        CREATE INDEX IF NOT EXISTS idx_reviews_issue ON validation_reviews(issue_type);
      `);
    },
  },
  {
    id: "004_v3_hierarchy_configuration_split",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS vehicle_hierarchy_values (
          id INTEGER PRIMARY KEY,
          model_id INTEGER NOT NULL REFERENCES models(id),
          value TEXT NOT NULL,
          classification_type TEXT NOT NULL
            CHECK (classification_type IN
              ('Sub-model','Trim','Series','Edition','Generation','Chassis')),
          confirmed_model_years TEXT,
          first_confirmed_model_year INTEGER,
          last_confirmed_model_year INTEGER,
          validation_status TEXT NOT NULL,
          raw_source_value TEXT,
          source_name TEXT, source_url TEXT,
          secondary_source_name TEXT, secondary_source_url TEXT,
          source_access_date TEXT,
          source_organization_count INTEGER DEFAULT 1,
          source_dataset_count INTEGER DEFAULT 1,
          notes TEXT,
          norm_value TEXT NOT NULL,
          UNIQUE (model_id, norm_value, classification_type)
        );
        CREATE TABLE IF NOT EXISTS hierarchy_value_years (
          id INTEGER PRIMARY KEY,
          hierarchy_value_id INTEGER NOT NULL REFERENCES vehicle_hierarchy_values(id),
          model_year INTEGER NOT NULL,
          validation_status TEXT NOT NULL,
          source_name TEXT, source_url TEXT, notes TEXT,
          UNIQUE (hierarchy_value_id, model_year)
        );
        CREATE TABLE IF NOT EXISTS vehicle_configuration_values (
          id INTEGER PRIMARY KEY,
          model_id INTEGER NOT NULL REFERENCES models(id),
          value TEXT NOT NULL,
          classification_type TEXT NOT NULL
            CHECK (classification_type IN
              ('Engine Variant','Drivetrain Variant','Body Style','Package',
               'Commercial Configuration')),
          confirmed_model_years TEXT,
          first_confirmed_model_year INTEGER,
          last_confirmed_model_year INTEGER,
          validation_status TEXT NOT NULL,
          raw_source_value TEXT,
          source_name TEXT, source_url TEXT,
          secondary_source_name TEXT, secondary_source_url TEXT,
          source_access_date TEXT,
          source_organization_count INTEGER DEFAULT 1,
          source_dataset_count INTEGER DEFAULT 1,
          notes TEXT,
          norm_value TEXT NOT NULL,
          UNIQUE (model_id, norm_value, classification_type)
        );
        CREATE TABLE IF NOT EXISTS configuration_value_years (
          id INTEGER PRIMARY KEY,
          configuration_value_id INTEGER NOT NULL
            REFERENCES vehicle_configuration_values(id),
          model_year INTEGER NOT NULL,
          validation_status TEXT NOT NULL,
          source_name TEXT, source_url TEXT, notes TEXT,
          UNIQUE (configuration_value_id, model_year)
        );
        CREATE INDEX IF NOT EXISTS idx_hier_model ON vehicle_hierarchy_values(model_id);
        CREATE INDEX IF NOT EXISTS idx_hier_type ON vehicle_hierarchy_values(classification_type);
        CREATE INDEX IF NOT EXISTS idx_hier_norm ON vehicle_hierarchy_values(norm_value);
        CREATE INDEX IF NOT EXISTS idx_conf_model ON vehicle_configuration_values(model_id);
        CREATE INDEX IF NOT EXISTS idx_conf_type ON vehicle_configuration_values(classification_type);
        CREATE INDEX IF NOT EXISTS idx_conf_norm ON vehicle_configuration_values(norm_value);
      `);
      const mcols = new Set((db.prepare("PRAGMA table_info(models)").all() as
        { name: string }[]).map((c) => c.name));
      if (!mcols.has("source_organization_count")) {
        db.exec("ALTER TABLE models ADD COLUMN source_organization_count INTEGER DEFAULT 1");
      }
      if (!mcols.has("source_dataset_count")) {
        db.exec("ALTER TABLE models ADD COLUMN source_dataset_count INTEGER DEFAULT 1");
      }
      const scols = new Set((db.prepare("PRAGMA table_info(sources)").all() as
        { name: string }[]).map((c) => c.name));
      if (!scols.has("source_organization")) {
        db.exec("ALTER TABLE sources ADD COLUMN source_organization TEXT");
        db.exec("ALTER TABLE sources ADD COLUMN source_dataset TEXT");
      }
      const rcols = new Set((db.prepare("PRAGMA table_info(validation_reviews)").all() as
        { name: string }[]).map((c) => c.name));
      if (!rcols.has("priority")) {
        db.exec("ALTER TABLE validation_reviews ADD COLUMN priority TEXT DEFAULT ''");
      }
    },
  },
  {
    id: "005_v5_standardization_workspace",
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mapping_templates (
          id INTEGER PRIMARY KEY,
          template_name TEXT NOT NULL UNIQUE,
          description TEXT,
          mapping_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS standardization_projects (
          id INTEGER PRIMARY KEY,
          project_name TEXT NOT NULL,
          input_filename TEXT NOT NULL,
          input_file_hash TEXT NOT NULL,
          input_format TEXT NOT NULL,
          worksheet_name TEXT,
          row_count INTEGER NOT NULL DEFAULT 0,
          column_count INTEGER NOT NULL DEFAULT 0,
          mapping_template_id INTEGER REFERENCES mapping_templates(id),
          mapping_json TEXT,
          status TEXT NOT NULL DEFAULT 'Uploaded'
            CHECK (status IN ('Uploaded','Mapped','Processing','Review Required',
                              'Ready to Export','Exported','Failed')),
          encoding TEXT,
          header_row INTEGER NOT NULL DEFAULT 1,
          stored_path TEXT,
          processed_rows INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          auto_apply_high_confidence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          notes TEXT
        );
        CREATE TABLE IF NOT EXISTS standardization_rows (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES standardization_projects(id),
          row_number INTEGER NOT NULL,
          original_json TEXT NOT NULL,
          normalized_json TEXT,
          make_status TEXT, model_status TEXT, hierarchy_status TEXT,
          year_status TEXT,
          review_required INTEGER NOT NULL DEFAULT 0,
          excluded INTEGER NOT NULL DEFAULT 0,
          user_decision TEXT,
          conflict_reason TEXT,
          notes TEXT,
          UNIQUE (project_id, row_number)
        );
        CREATE INDEX IF NOT EXISTS idx_std_rows_project ON standardization_rows(project_id);
        CREATE INDEX IF NOT EXISTS idx_std_rows_review
          ON standardization_rows(project_id, review_required);
        CREATE TABLE IF NOT EXISTS standardization_changes (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES standardization_projects(id),
          row_id INTEGER REFERENCES standardization_rows(id),
          row_number INTEGER,
          field_name TEXT NOT NULL,
          original_value TEXT,
          new_value TEXT,
          change_source TEXT NOT NULL,
          confidence TEXT,
          user_decision TEXT,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_std_changes_project
          ON standardization_changes(project_id);
        CREATE TABLE IF NOT EXISTS project_value_mappings (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES standardization_projects(id),
          field_name TEXT NOT NULL,
          make_context TEXT NOT NULL DEFAULT '',
          model_context TEXT NOT NULL DEFAULT '',
          raw_value TEXT NOT NULL,
          norm_raw_value TEXT NOT NULL,
          canonical_value TEXT,
          canonical_classification TEXT,
          decision TEXT NOT NULL,
          confidence TEXT,
          applied_row_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          notes TEXT,
          UNIQUE (project_id, field_name, make_context, model_context, norm_raw_value)
        );
        CREATE INDEX IF NOT EXISTS idx_pvm_lookup
          ON project_value_mappings(project_id, field_name, norm_raw_value);
        CREATE TABLE IF NOT EXISTS catalog_change_proposals (
          id INTEGER PRIMARY KEY,
          proposed_record_type TEXT NOT NULL,
          raw_value TEXT NOT NULL,
          proposed_canonical_value TEXT,
          make_context TEXT, model_context TEXT,
          supporting_project_ids TEXT,
          occurrence_count INTEGER NOT NULL DEFAULT 0,
          evidence TEXT,
          proposal_status TEXT NOT NULL DEFAULT 'Proposed'
            CHECK (proposal_status IN ('Proposed','Under Review','Accepted','Rejected')),
          reviewer_notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS project_exports (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES standardization_projects(id),
          export_type TEXT NOT NULL,
          mode TEXT,
          filename TEXT NOT NULL,
          row_count INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: "006_canonical_readonly_guard",
    apply: (db) => {
      // The canonical catalog is read-only for ordinary operations. Writes are
      // only possible while catalog_meta.canonical_unlocked = '1', which the
      // catalog importers set deliberately (see withCanonicalUnlocked()).
      const CANONICAL = ["makes", "models", "model_years",
        "vehicle_hierarchy_values", "hierarchy_value_years",
        "vehicle_configuration_values", "configuration_value_years", "aliases",
        "grouped_model_relationships"];
      const guard = `(SELECT value FROM catalog_meta WHERE key='canonical_unlocked')
        IS NOT '1'`;
      for (const t of CANONICAL) {
        for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
          db.exec(`
            CREATE TRIGGER IF NOT EXISTS trg_ro_${t}_${op.toLowerCase()}
            BEFORE ${op} ON ${t} WHEN ${guard}
            BEGIN SELECT RAISE(ABORT,
              'canonical catalog is read-only (Version 4 baseline is frozen)');
            END;`);
        }
      }
    },
  },
  {
    id: "007_v51_hardening",
    apply: (db) => {
      const cols = new Set((db.prepare("PRAGMA table_info(standardization_projects)")
        .all() as { name: string }[]).map((c) => c.name));
      const add = (name: string, ddl: string) => {
        if (!cols.has(name)) {
          db.exec(`ALTER TABLE standardization_projects ADD COLUMN ${name} ${ddl}`);
        }
      };
      // internal storage identity, independent of the uploaded filename
      add("storage_id", "TEXT");
      add("display_filename", "TEXT");
      add("upload_removed", "INTEGER NOT NULL DEFAULT 0");
      add("upload_sha256", "TEXT");
      add("last_progress_at", "TEXT");
      add("recovery_state", "TEXT");
      add("retention_policy", "TEXT");

      const ecols = new Set((db.prepare("PRAGMA table_info(project_exports)")
        .all() as { name: string }[]).map((c) => c.name));
      if (!ecols.has("neutralized_cells")) {
        db.exec("ALTER TABLE project_exports ADD COLUMN neutralized_cells INTEGER NOT NULL DEFAULT 0");
        db.exec("ALTER TABLE project_exports ADD COLUMN formula_protection_applied TEXT DEFAULT 'No'");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS project_deletions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          project_name TEXT,
          display_filename TEXT,
          input_file_hash TEXT,
          rows_deleted INTEGER NOT NULL DEFAULT 0,
          changes_deleted INTEGER NOT NULL DEFAULT 0,
          value_mappings_deleted INTEGER NOT NULL DEFAULT 0,
          exports_deleted INTEGER NOT NULL DEFAULT 0,
          files_deleted INTEGER NOT NULL DEFAULT 0,
          bytes_freed INTEGER NOT NULL DEFAULT 0,
          scope TEXT NOT NULL,
          reason TEXT,
          deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS security_events (
          id INTEGER PRIMARY KEY,
          event_type TEXT NOT NULL,
          detail TEXT,
          project_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_projects_status
          ON standardization_projects(status);
      `);
    },
  },
  {
    id: "008_v6_title_optimizer",
    apply: (db) => {
      // The Title Optimizer is a separate module. It never touches canonical
      // tables; its rules, templates and abbreviations are project-level data.
      db.exec(`
        CREATE TABLE IF NOT EXISTS title_optimization_projects (
          id INTEGER PRIMARY KEY,
          project_name TEXT NOT NULL,
          input_filename TEXT NOT NULL,
          display_filename TEXT,
          input_file_hash TEXT NOT NULL,
          input_format TEXT NOT NULL,
          worksheet_name TEXT,
          storage_id TEXT,
          stored_path TEXT,
          upload_removed INTEGER NOT NULL DEFAULT 0,
          source_project_id INTEGER REFERENCES standardization_projects(id),
          row_count INTEGER NOT NULL DEFAULT 0,
          column_count INTEGER NOT NULL DEFAULT 0,
          header_row INTEGER NOT NULL DEFAULT 1,
          encoding TEXT,
          mapping_json TEXT,
          template_id INTEGER REFERENCES title_templates(id),
          max_characters INTEGER NOT NULL DEFAULT 80,
          status TEXT NOT NULL DEFAULT 'Uploaded'
            CHECK (status IN ('Uploaded','Mapped','Processing','Review Required',
                              'Ready to Export','Exported','Failed')),
          processed_rows INTEGER NOT NULL DEFAULT 0,
          cancel_requested INTEGER NOT NULL DEFAULT 0,
          recovery_state TEXT,
          last_progress_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          notes TEXT
        );
        CREATE TABLE IF NOT EXISTS title_optimization_rows (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES title_optimization_projects(id),
          row_number INTEGER NOT NULL,
          source_json TEXT NOT NULL,
          original_title TEXT NOT NULL,
          original_length INTEGER NOT NULL,
          proposed_title TEXT,
          proposed_length INTEGER,
          final_title TEXT,
          final_length INTEGER,
          characters_removed INTEGER NOT NULL DEFAULT 0,
          applied_rules TEXT,
          removed_information TEXT,
          preserved_information TEXT,
          validation_warnings TEXT,
          title_status TEXT NOT NULL DEFAULT 'Manual Review Required'
            CHECK (title_status IN ('Already Within Limit','Optimized',
              'Optimized with Warning','Manual Review Required',
              'Unable to Reach Limit','Excluded')),
          user_decision TEXT,
          manually_edited INTEGER NOT NULL DEFAULT 0,
          excluded INTEGER NOT NULL DEFAULT 0,
          template_id INTEGER REFERENCES title_templates(id),
          notes TEXT,
          UNIQUE (project_id, row_number)
        );
        CREATE TABLE IF NOT EXISTS title_optimization_changes (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES title_optimization_projects(id),
          row_id INTEGER REFERENCES title_optimization_rows(id),
          row_number INTEGER NOT NULL,
          stage INTEGER NOT NULL,
          rule_id TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          before_value TEXT NOT NULL,
          after_value TEXT NOT NULL,
          characters_saved INTEGER NOT NULL DEFAULT 0,
          removed_phrase TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS title_templates (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          pattern TEXT NOT NULL,
          required_fields TEXT NOT NULL DEFAULT '[]',
          optional_fields TEXT NOT NULL DEFAULT '[]',
          field_priority TEXT NOT NULL DEFAULT '[]',
          is_default INTEGER NOT NULL DEFAULT 0,
          project_id INTEGER REFERENCES title_optimization_projects(id),
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS title_rules (
          id INTEGER PRIMARY KEY,
          rule_id TEXT NOT NULL UNIQUE,
          rule_name TEXT NOT NULL,
          stage INTEGER NOT NULL,
          description TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          destructive INTEGER NOT NULL DEFAULT 0,
          project_id INTEGER REFERENCES title_optimization_projects(id),
          notes TEXT
        );
        CREATE TABLE IF NOT EXISTS title_abbreviation_mappings (
          id INTEGER PRIMARY KEY,
          full_value TEXT NOT NULL,
          abbreviated_value TEXT NOT NULL,
          applicable_field TEXT NOT NULL DEFAULT 'Any',
          minimum_characters_saved INTEGER NOT NULL DEFAULT 1,
          ambiguity_risk TEXT NOT NULL DEFAULT 'Low'
            CHECK (ambiguity_risk IN ('Low','Medium','High')),
          approval_status TEXT NOT NULL DEFAULT 'Approved'
            CHECK (approval_status IN ('Approved','Pending','Rejected')),
          project_id INTEGER REFERENCES title_optimization_projects(id),
          notes TEXT,
          UNIQUE (full_value, applicable_field, project_id)
        );
        CREATE TABLE IF NOT EXISTS title_manual_decisions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES title_optimization_projects(id),
          row_id INTEGER REFERENCES title_optimization_rows(id),
          row_number INTEGER NOT NULL,
          decision TEXT NOT NULL,
          original_title TEXT NOT NULL,
          proposed_title TEXT,
          final_title TEXT,
          final_length INTEGER,
          validation_result TEXT,
          template_id INTEGER REFERENCES title_templates(id),
          notes TEXT,
          decided_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_title_rows_project
          ON title_optimization_rows(project_id, row_number);
        CREATE INDEX IF NOT EXISTS idx_title_rows_status
          ON title_optimization_rows(project_id, title_status);
        CREATE INDEX IF NOT EXISTS idx_title_changes_project
          ON title_optimization_changes(project_id, row_number);
        CREATE INDEX IF NOT EXISTS idx_title_decisions_project
          ON title_manual_decisions(project_id, row_number);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const done = new Set((db.prepare("SELECT id FROM schema_migrations").all() as
    { id: string }[]).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    m.apply(db);
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(m.id);
    applied.push(m.id);
  }
  return applied;
}
