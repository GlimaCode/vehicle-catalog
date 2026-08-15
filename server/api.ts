/** REST API: browsing, filtering, global search, selector, exports, admin. */
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { norm, BACKUP_DIR, DB_PATH } from "./db.js";
import { runImport } from "./importer.js";
import { buildWorkbook, toCsv, writeWorkbook } from "./exporter.js";
import { loadConfig } from "./config.js";
import { bindingSummary } from "./security/http.js";

type Row = Record<string, unknown>;

export function createApi(db: Database.Database): Router {
  const api = Router();
  api.use(express.json());
  const all = <T = Row>(sql: string, params: unknown[] = []): T[] =>
    db.prepare(sql).all(...params) as T[];
  const one = <T = Row>(sql: string, params: unknown[] = []): T | undefined =>
    db.prepare(sql).get(...params) as T | undefined;
  const n = (sql: string, params: unknown[] = []): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  // ------------------------------ dashboard ------------------------------
  api.get("/summary", (_req, res) => {
    const group = (sql: string) => all<{ k: string; n: number }>(sql);
    res.json({
      meta: Object.fromEntries(all<{ key: string; value: string }>(
        "SELECT key, value FROM catalog_meta").map((r) => [r.key, r.value])),
      cards: {
        makes: n("SELECT COUNT(*) n FROM makes"),
        models: n("SELECT COUNT(*) n FROM models"),
        submodels: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Sub-model'"),
        trims: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Trim'"),
        series: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Series'"),
        editions: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Edition'"),
        generations: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Generation'"),
        chassis: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values WHERE classification_type='Chassis'"),
        engineConfigurations: n("SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type='Engine Variant'"),
        drivetrainConfigurations: n("SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type='Drivetrain Variant'"),
        bodyStyles: n("SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type='Body Style'"),
        packages: n("SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type='Package'"),
        commercialConfigurations: n("SELECT COUNT(*) n FROM vehicle_configuration_values WHERE classification_type='Commercial Configuration'"),
        approvedSubmodels: n("SELECT COUNT(*) n FROM vehicle_hierarchy_values"),
        submodelCandidates: n("SELECT COUNT(*) n FROM submodels WHERE validation_status='Review Required'"),
        modelYears: n("SELECT COUNT(*) n FROM model_years"),
        activeModels: n("SELECT COUNT(*) n FROM models WHERE lifecycle_status='Active'"),
        discontinuedModels: n("SELECT COUNT(*) n FROM models WHERE lifecycle_status='Discontinued'"),
        fullyVerified: n("SELECT COUNT(*) n FROM models WHERE validation_status='Fully Verified'"),
        governmentVerified: n("SELECT COUNT(*) n FROM models WHERE validation_status='Government Verified'"),
        manufacturerVerified: n("SELECT COUNT(*) n FROM models WHERE validation_status='Manufacturer Verified'"),
        reviewRequired: n("SELECT COUNT(*) n FROM validation_reviews WHERE review_status='Pending'"),
        originalSource: n("SELECT COUNT(*) n FROM models WHERE present_in_original_source='Yes'"),
        externallyAdded: n("SELECT COUNT(*) n FROM models WHERE catalog_origin LIKE 'Added%'"),
        aliases: n("SELECT COUNT(*) n FROM aliases"),
      },
      modelsByDecade: group(`SELECT (first_confirmed_model_year/10*10) || 's' k, COUNT(*) n
        FROM models GROUP BY 1 ORDER BY 1`),
      modelsByCategory: group("SELECT vehicle_category k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"),
      makesByLifecycle: group("SELECT lifecycle_status k, COUNT(*) n FROM makes GROUP BY 1 ORDER BY 2 DESC"),
      validationDistribution: group("SELECT validation_status k, COUNT(*) n FROM models GROUP BY 1 ORDER BY 2 DESC"),
      lastImports: all("SELECT * FROM import_runs ORDER BY id DESC LIMIT 8"),
    });
  });

  // ------------------------------ makes ------------------------------
  const MAKE_LIST_SQL = `
    SELECT k.*, (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id) model_count,
      (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id AND m.lifecycle_status='Active') active_model_count
    FROM makes k`;
  api.get("/makes", (req, res) => {
    const q = String(req.query.q ?? "");
    const rows = all(MAKE_LIST_SQL + (q ? " WHERE k.norm_make LIKE ?" : "") +
      " ORDER BY k.standard_make", q ? [`%${norm(q)}%`] : []);
    res.json({ rows, total: rows.length });
  });
  api.get("/makes/:id", (req, res) => {
    const make = one(MAKE_LIST_SQL + " WHERE k.id=?", [req.params.id]);
    if (!make) return res.status(404).json({ error: "Make not found" });
    res.json({
      make,
      models: all(`SELECT m.*,
        (SELECT COUNT(*) FROM vehicle_hierarchy_values s WHERE s.model_id=m.id) submodel_count
        FROM models m WHERE m.make_id=? ORDER BY m.standard_model`, [req.params.id]),
      aliases: all(`SELECT a.*, mm.standard_model canonical_model FROM aliases a
        LEFT JOIN models mm ON mm.id=a.canonical_model_id
        WHERE a.canonical_make_id=? ORDER BY a.raw_or_alias_model`, [req.params.id]),
      submodelCount: n(`SELECT COUNT(*) n FROM vehicle_hierarchy_values s
        JOIN models m ON m.id=s.model_id WHERE m.make_id=?`, [req.params.id]),
      warnings: all(`SELECT * FROM validation_reviews WHERE candidate_make=?
        AND review_status='Pending' LIMIT 100`, [(make as Row).standard_make]),
    });
  });

  // ------------------------------ models ------------------------------
  function modelFilters(req: express.Request): { where: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = req.query;
    if (p.make) { where.push("k.id = ?"); params.push(Number(p.make)); }
    if (p.q) { where.push("(m.norm_model LIKE ? OR k.norm_make LIKE ?)");
      params.push(`%${norm(String(p.q))}%`, `%${norm(String(p.q))}%`); }
    if (p.year) { where.push("EXISTS (SELECT 1 FROM model_years y WHERE y.model_id=m.id AND y.model_year=?)");
      params.push(Number(p.year)); }
    if (p.category) { where.push("m.vehicle_category = ?"); params.push(String(p.category)); }
    if (p.lifecycle) { where.push("m.lifecycle_status = ?"); params.push(String(p.lifecycle)); }
    if (p.validation) { where.push("m.validation_status = ?"); params.push(String(p.validation)); }
    if (p.original) { where.push("m.present_in_original_source = ?"); params.push(String(p.original)); }
    if (p.origin) { where.push("m.catalog_origin = ?"); params.push(String(p.origin)); }
    if (p.active === "true") where.push("m.lifecycle_status='Active'");
    if (p.active === "false") where.push("m.lifecycle_status='Discontinued'");
    if (p.hasSubmodels === "true") {
      where.push("EXISTS (SELECT 1 FROM vehicle_hierarchy_values s WHERE s.model_id=m.id)");
    }
    if (p.hasWarnings === "true") {
      where.push(`EXISTS (SELECT 1 FROM validation_reviews v WHERE v.review_status='Pending'
        AND v.candidate_make = k.standard_make)`);
    }
    return { where: where.length ? "WHERE " + where.join(" AND ") : "", params };
  }
  const MODEL_SORTS: Record<string, string> = {
    make: "k.standard_make", model: "m.standard_model",
    first: "m.first_confirmed_model_year", last: "m.last_confirmed_model_year",
    category: "m.vehicle_category", lifecycle: "m.lifecycle_status",
    validation: "m.validation_status",
  };
  const MODEL_LIST_SQL = (where: string, order: string) => `
    SELECT m.id, k.id make_id, k.standard_make, m.standard_model, m.confirmed_model_years,
      m.first_confirmed_model_year, m.last_confirmed_model_year, m.lifecycle_status,
      m.vehicle_category, m.validation_status, m.present_in_original_source, m.catalog_origin,
      m.market, m.primary_source_name, m.primary_source_url, m.notes,
      (SELECT COUNT(*) FROM vehicle_hierarchy_values s WHERE s.model_id=m.id) submodel_count,
      (SELECT COUNT(*) FROM vehicle_configuration_values c WHERE c.model_id=m.id) configuration_count
    FROM models m JOIN makes k ON k.id=m.make_id ${where} ${order}`;

  api.get("/models", (req, res) => {
    const { where, params } = modelFilters(req);
    const sortKey = MODEL_SORTS[String(req.query.sort ?? "make")] ?? "k.standard_make";
    const dir = req.query.dir === "desc" ? "DESC" : "ASC";
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize ?? 50)));
    const total = n(`SELECT COUNT(*) n FROM models m JOIN makes k ON k.id=m.make_id ${where}`, params);
    const rows = all(MODEL_LIST_SQL(where, `ORDER BY ${sortKey} ${dir}, m.standard_model LIMIT ? OFFSET ?`),
      [...params, pageSize, (page - 1) * pageSize]);
    res.json({ rows, total, page, pageSize });
  });

  api.get("/models/:id", (req, res) => {
    const model = one(`SELECT m.*, k.standard_make FROM models m JOIN makes k ON k.id=m.make_id WHERE m.id=?`,
      [req.params.id]);
    if (!model) return res.status(404).json({ error: "Model not found" });
    const mk = (model as Row).standard_make as string;
    res.json({
      model,
      years: all("SELECT * FROM model_years WHERE model_id=? ORDER BY model_year", [req.params.id]),
      aliases: all(`SELECT * FROM aliases WHERE canonical_model_id=? ORDER BY raw_or_alias_model LIMIT 300`, [req.params.id]),
      grouped: all(`SELECT * FROM grouped_model_relationships WHERE canonical_model_id=?`, [req.params.id]),
      hierarchy: all(`SELECT * FROM vehicle_hierarchy_values WHERE model_id=?
        ORDER BY classification_type, value`, [req.params.id]),
      configurations: all(`SELECT * FROM vehicle_configuration_values WHERE model_id=?
        ORDER BY classification_type, value`, [req.params.id]),
      submodels: all(`SELECT * FROM submodels WHERE model_id=? AND review_status<>'Approved'
        ORDER BY standard_submodel`, [req.params.id]),
      reviews: all(`SELECT * FROM validation_reviews WHERE candidate_make=? AND review_status='Pending' LIMIT 50`, [mk]),
      history: all(`SELECT * FROM import_runs ORDER BY id DESC LIMIT 5`),
      changes: all(`SELECT * FROM audit_changes WHERE entity_table='models' AND entity_id=? ORDER BY id DESC`,
        [req.params.id]),
    });
  });

  // ------------------------------ year browser ------------------------------
  api.get("/years/:year", (req, res) => {
    const y = Number(req.params.year);
    const params: unknown[] = [y];
    let where = "";
    if (req.query.make) { where += " AND k.id=?"; params.push(Number(req.query.make)); }
    if (req.query.category) { where += " AND m.vehicle_category=?"; params.push(String(req.query.category)); }
    const rows = all(`
      SELECT k.id make_id, k.standard_make, m.id model_id, m.standard_model, m.vehicle_category,
        m.lifecycle_status, y.validation_status, y.year_status, m.confirmed_model_years
      FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
      WHERE y.model_year=? ${where}
      ORDER BY k.standard_make, m.standard_model`, params);
    res.json({
      year: y, rows,
      makes: all(`SELECT DISTINCT k.id, k.standard_make FROM model_years y
        JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
        WHERE y.model_year=? ORDER BY k.standard_make`, [y]),
      coverage: one("SELECT * FROM coverage_report WHERE model_year=?", [y]),
      submodels: all(`SELECT k.standard_make, m.standard_model, s.value standard_submodel,
        s.classification_type submodel_type
        FROM hierarchy_value_years sy JOIN vehicle_hierarchy_values s ON s.id=sy.hierarchy_value_id
        JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        WHERE sy.model_year=? LIMIT 2000`, [y]),
    });
  });

  // ------------- classified values (hierarchy + configuration) -------------
  api.get("/submodels", (req, res) => {
    const grp = String(req.query.group ?? "hierarchy");
    const build = (table: string) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (req.query.make) { where.push("k.id=?"); params.push(Number(req.query.make)); }
      if (req.query.model) { where.push("m.id=?"); params.push(Number(req.query.model)); }
      if (req.query.type) { where.push("s.classification_type=?"); params.push(String(req.query.type)); }
      if (req.query.validation) { where.push("s.validation_status=?"); params.push(String(req.query.validation)); }
      if (req.query.year) {
        const yt = table === "vehicle_hierarchy_values"
          ? ["hierarchy_value_years", "hierarchy_value_id"]
          : ["configuration_value_years", "configuration_value_id"];
        where.push(`EXISTS (SELECT 1 FROM ${yt[0]} y WHERE y.${yt[1]}=s.id AND y.model_year=?)`);
        params.push(Number(req.query.year));
      }
      if (req.query.q) { where.push("s.norm_value LIKE ?"); params.push(`%${norm(String(req.query.q))}%`); }
      const w = where.length ? "WHERE " + where.join(" AND ") : "";
      return all(`SELECT s.id, s.value standard_submodel, s.classification_type submodel_type,
        s.confirmed_model_years, s.validation_status, s.raw_source_value,
        s.source_name, s.notes, k.standard_make, m.standard_model, m.id model_id
        FROM ${table} s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id ${w}
        ORDER BY k.standard_make, m.standard_model, s.classification_type, s.value
        LIMIT 3000`, params);
    };
    let rows: Row[] = [];
    if (grp === "hierarchy" || grp === "all") rows = rows.concat(build("vehicle_hierarchy_values"));
    if (grp === "configuration" || grp === "all") rows = rows.concat(build("vehicle_configuration_values"));
    if (grp === "candidates") {
      rows = all(`SELECT s.id, s.standard_submodel, s.submodel_type, s.confirmed_model_years,
        s.validation_status, s.raw_source_value, s.source_name, s.notes,
        k.standard_make, m.standard_model, m.id model_id
        FROM submodels s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        WHERE s.review_status<>'Approved' LIMIT 2000`);
    }
    res.json({ rows, total: rows.length });
  });

  // ------------------------------ aliases ------------------------------
  api.get("/aliases", (req, res) => {
    const q = norm(String(req.query.q ?? ""));
    const params: unknown[] = q ? [`%${q}%`, `%${q}%`] : [];
    const rows = all(`SELECT a.*, k.standard_make canonical_make, m.standard_model canonical_model
      FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
      LEFT JOIN models m ON m.id=a.canonical_model_id
      ${q ? "WHERE a.norm_model LIKE ? OR a.norm_make LIKE ?" : ""}
      ORDER BY a.raw_or_alias_make, a.raw_or_alias_model LIMIT 500`, params);
    res.json({ rows, total: rows.length });
  });

  // ------------------------------ global search ------------------------------
  api.get("/search", (req, res) => {
    const raw = String(req.query.q ?? "").trim();
    const q = norm(raw);
    if (!q) return res.json({ query: raw, results: [] });
    const results: Row[] = [];
    for (const r of all(`SELECT id, standard_make FROM makes WHERE norm_make=?`, [q])) {
      results.push({ kind: "make", exact: true, reason: "Exact make match", ...r });
    }
    for (const r of all(`SELECT m.id, m.standard_model, k.standard_make, k.id make_id
        FROM models m JOIN makes k ON k.id=m.make_id WHERE m.norm_model=?`, [q])) {
      results.push({ kind: "model", exact: true, reason: "Exact model match (punctuation-insensitive)", ...r });
    }
    for (const r of all(`SELECT a.*, k.standard_make canonical_make, m.standard_model canonical_model,
        a.canonical_model_id FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
        LEFT JOIN models m ON m.id=a.canonical_model_id
        WHERE a.norm_model=? OR a.norm_make=?`, [q, q])) {
      results.push({ kind: "alias", exact: true,
        reason: `Alias match (${(r as Row).alias_type}) - canonical mapping shown`, ...r });
    }
    for (const r of all(`SELECT id, standard_make FROM makes WHERE norm_make LIKE ? AND norm_make<>?
        ORDER BY standard_make LIMIT 10`, [`%${q}%`, q])) {
      results.push({ kind: "make", exact: false, reason: "Partial make match", ...r });
    }
    for (const r of all(`SELECT m.id, m.standard_model, k.standard_make, k.id make_id
        FROM models m JOIN makes k ON k.id=m.make_id
        WHERE m.norm_model LIKE ? AND m.norm_model<>? ORDER BY m.standard_model LIMIT 25`, [`%${q}%`, q])) {
      results.push({ kind: "model", exact: false, reason: "Partial model match", ...r });
    }
    for (const r of all(`SELECT a.*, k.standard_make canonical_make, m.standard_model canonical_model
        FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
        LEFT JOIN models m ON m.id=a.canonical_model_id
        WHERE (a.norm_model LIKE ? AND a.norm_model<>?) LIMIT 25`, [`%${q}%`, q])) {
      results.push({ kind: "alias", exact: false, reason: `Partial alias match (${(r as Row).alias_type})`, ...r });
    }
    for (const r of all(`SELECT g.*, k.standard_make canonical_make, m.standard_model canonical_model
        FROM grouped_model_relationships g LEFT JOIN makes k ON k.id=g.canonical_make_id
        LEFT JOIN models m ON m.id=g.canonical_model_id WHERE g.norm_value LIKE ? LIMIT 15`, [`%${q}%`])) {
      results.push({ kind: "grouped", exact: false, reason: "Grouped compatibility value match", ...r });
    }
    for (const r of all(`SELECT s.id, s.value standard_submodel,
        s.classification_type submodel_type, s.validation_status,
        m.standard_model, m.id model_id, k.standard_make
        FROM vehicle_hierarchy_values s
        JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        WHERE s.norm_value LIKE ? ORDER BY (s.norm_value=?) DESC LIMIT 15`,
        [`%${q}%`, q])) {
      const row = r as Row;
      results.push({ kind: "submodel", exact: norm(String(row.standard_submodel)) === q,
        reason: `${row.submodel_type} match (${row.validation_status}) - ` +
          "vehicle hierarchy value, not a Model", ...r });
    }
    for (const r of all(`SELECT s.id, s.value standard_submodel,
        s.classification_type submodel_type, s.validation_status,
        m.standard_model, m.id model_id, k.standard_make
        FROM vehicle_configuration_values s
        JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        WHERE s.norm_value LIKE ? ORDER BY (s.norm_value=?) DESC LIMIT 10`,
        [`%${q}%`, q])) {
      const row = r as Row;
      results.push({ kind: "configuration", exact: norm(String(row.standard_submodel)) === q,
        reason: `${row.submodel_type} match (${row.validation_status}) - ` +
          "vehicle configuration attribute, not a Model or Sub-model", ...r });
    }
    for (const r of all(`SELECT s.id, s.standard_submodel, s.submodel_type,
        s.validation_status, m.standard_model, m.id model_id, k.standard_make
        FROM submodels s JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        WHERE s.review_status<>'Approved' AND s.norm_submodel LIKE ? LIMIT 8`, [`%${q}%`])) {
      const row = r as Row;
      results.push({ kind: "submodel-candidate", exact: false,
        reason: `Review-required candidate (${row.submodel_type}) - not approved`, ...r });
    }
    res.json({ query: raw, normalized: q, results: results.slice(0, 80) });
  });

  // ------------------------------ cascading selector ------------------------------
  api.get("/selector/makes", (_req, res) => {
    res.json(all("SELECT id, standard_make, lifecycle_status, validation_status FROM makes ORDER BY standard_make"));
  });
  api.get("/selector/models", (req, res) => {
    res.json(all(`SELECT id, standard_model, first_confirmed_model_year, last_confirmed_model_year,
      lifecycle_status, validation_status FROM models WHERE make_id=? ORDER BY standard_model`,
      [Number(req.query.make)]));
  });
  const HIER_TYPES = ["Sub-model", "Trim", "Series", "Edition", "Generation", "Chassis"];
  const CONF_TYPES = ["Engine Variant", "Drivetrain Variant", "Body Style",
    "Package", "Commercial Configuration"];
  api.get("/selector/submodels", (req, res) => {
    const includeReview = req.query.includeReview === "true";
    // Default third-level selector: approved Sub-model / Trim / Series /
    // Edition only. Generation and Chassis are advanced hierarchy filters;
    // configuration types come from the configuration table and are never
    // shown in the Sub-model dropdown.
    const defaultTypes = ["Sub-model", "Trim", "Series", "Edition"];
    const requested = String(req.query.types ?? "").split(",").filter(Boolean);
    const useTypes = requested.length ? requested : defaultTypes;
    const hierTypes = useTypes.filter((t) => HIER_TYPES.includes(t));
    const confTypes = useTypes.filter((t) => CONF_TYPES.includes(t));
    const out: Row[] = [];
    if (hierTypes.length) {
      out.push(...all(`SELECT id, value standard_submodel,
        classification_type submodel_type, validation_status, confirmed_model_years,
        'hierarchy' source_table
        FROM vehicle_hierarchy_values
        WHERE model_id=? AND classification_type IN (${hierTypes.map(() => "?").join(",")})
        ORDER BY classification_type, value`,
        [Number(req.query.model), ...hierTypes]));
    }
    if (confTypes.length) {
      out.push(...all(`SELECT id, value standard_submodel,
        classification_type submodel_type, validation_status, confirmed_model_years,
        'configuration' source_table
        FROM vehicle_configuration_values
        WHERE model_id=? AND classification_type IN (${confTypes.map(() => "?").join(",")})
        ORDER BY classification_type, value`,
        [Number(req.query.model), ...confTypes]));
    }
    if (includeReview) {
      out.push(...all(`SELECT id, standard_submodel, submodel_type, validation_status,
        'review-candidate' source_table FROM submodels
        WHERE model_id=? AND review_status<>'Approved'`, [Number(req.query.model)]));
    }
    res.json(out);
  });
  api.get("/selector/types", (_req, res) => {
    res.json({ hierarchy: HIER_TYPES, configuration: CONF_TYPES,
      selectorDefault: ["Sub-model", "Trim", "Series", "Edition"] });
  });
  api.get("/selector/years", (req, res) => {
    if (req.query.submodel) {
      const table = req.query.table === "configuration"
        ? ["configuration_value_years", "configuration_value_id"]
        : ["hierarchy_value_years", "hierarchy_value_id"];
      const rows = all(`SELECT model_year FROM ${table[0]} WHERE ${table[1]}=?
        ORDER BY model_year`, [Number(req.query.submodel)]);
      if (rows.length) return res.json(rows.map((r) => (r as Row).model_year));
      // fall through to model years when the value has no verified years
    }
    res.json(all(`SELECT model_year FROM model_years WHERE model_id=? ORDER BY model_year`,
      [Number(req.query.model)]).map((r) => (r as Row).model_year));
  });

  // ------------------------------ reviews ------------------------------
  api.get("/reviews", (req, res) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.issue) { where.push("issue_type=?"); params.push(String(req.query.issue)); }
    if (req.query.status) { where.push("review_status=?"); params.push(String(req.query.status)); }
    if (req.query.make) { where.push("candidate_make=?"); params.push(String(req.query.make)); }
    if (req.query.q) { where.push("(candidate_model LIKE ? OR candidate_make LIKE ?)");
      params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = 50;
    const total = n(`SELECT COUNT(*) n FROM validation_reviews ${w}`, params);
    const rows = all(`SELECT * FROM validation_reviews ${w}
      ORDER BY candidate_make, candidate_model LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);
    res.json({ rows, total, page, pageSize,
      issueTypes: all("SELECT issue_type k, COUNT(*) n FROM validation_reviews GROUP BY 1 ORDER BY 2 DESC") });
  });
  api.patch("/reviews/:id", (req, res) => {
    const allowed = ["Pending", "Approved", "Rejected", "Needs More Evidence", "Corrected"];
    const { review_status, notes, reason } = req.body ?? {};
    if (review_status && !allowed.includes(review_status)) {
      return res.status(400).json({ error: `review_status must be one of ${allowed.join(", ")}` });
    }
    const before = one("SELECT * FROM validation_reviews WHERE id=?", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Not found" });
    db.prepare("UPDATE validation_reviews SET review_status=COALESCE(?,review_status), notes=COALESCE(?,notes) WHERE id=?")
      .run(review_status ?? null, notes ?? null, req.params.id);
    const after = one("SELECT * FROM validation_reviews WHERE id=?", [req.params.id]);
    db.prepare(`INSERT INTO audit_changes (action_type, entity_table, entity_id, before_value, after_value, reason)
      VALUES ('review-update','validation_reviews',?,?,?,?)`)
      .run(req.params.id, JSON.stringify(before), JSON.stringify(after), reason ?? "");
    res.json({ ok: true, row: after,
      note: "Review status updated. Approved items are NOT auto-promoted into the canonical catalog; " +
        "promotion requires a validated catalog re-import." });
  });

  // ------------------------------ sources & audit ------------------------------
  api.get("/sources", (_req, res) => {
    res.json({
      sources: all("SELECT * FROM sources ORDER BY source_name"),
      importRuns: all("SELECT * FROM import_runs ORDER BY id DESC LIMIT 200"),
      coverage: all("SELECT * FROM coverage_report ORDER BY model_year"),
      auditChanges: all("SELECT * FROM audit_changes ORDER BY id DESC LIMIT 200"),
      meta: Object.fromEntries(all<{ key: string; value: string }>(
        "SELECT key, value FROM catalog_meta").map((r) => [r.key, r.value])),
    });
  });

  // ------------------------------ exports ------------------------------
  api.get("/export/excel", async (_req, res) => {
    const wb = buildWorkbook(db);
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",
      'attachment; filename="Complete_US_Make_Model_Submodel_Catalog_1980_to_2026-07-15.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });

  const CSV_EXPORTS: Record<string, { sql: string; cols: { header: string; key: string }[] }> = {
    makes: {
      sql: `SELECT k.*, (SELECT COUNT(*) FROM models m WHERE m.make_id=k.id) model_count
        FROM makes k ORDER BY standard_make`,
      cols: [["Standard Make", "standard_make"], ["Official Display Name", "official_display_name"],
        ["US Market Start Year", "us_market_start_year"], ["US Market End Year", "us_market_end_year"],
        ["Lifecycle Status", "lifecycle_status"], ["Model Count", "model_count"],
        ["Present in Original Source", "present_in_original_source"], ["Catalog Origin", "catalog_origin"],
        ["Validation Status", "validation_status"], ["Primary Source URL", "primary_source_url"],
        ["Notes", "notes"]].map(([header, key]) => ({ header, key })),
    },
    submodels: {
      sql: `SELECT s.*, k.standard_make, m.standard_model FROM submodels s
        JOIN models m ON m.id=s.model_id JOIN makes k ON k.id=m.make_id
        ORDER BY k.standard_make, m.standard_model, s.standard_submodel`,
      cols: [["Standard Make", "standard_make"], ["Standard Model", "standard_model"],
        ["Standard Sub-model", "standard_submodel"], ["Sub-model Type", "submodel_type"],
        ["Validation Status", "validation_status"], ["Source", "source_name"], ["Notes", "notes"]]
        .map(([header, key]) => ({ header, key })),
    },
    aliases: {
      sql: `SELECT a.*, k.standard_make canonical_make, COALESCE(m.standard_model,'') canonical_model
        FROM aliases a LEFT JOIN makes k ON k.id=a.canonical_make_id
        LEFT JOIN models m ON m.id=a.canonical_model_id ORDER BY raw_or_alias_make, raw_or_alias_model`,
      cols: [["Raw or Alias Make", "raw_or_alias_make"], ["Raw or Alias Model", "raw_or_alias_model"],
        ["Canonical Make", "canonical_make"], ["Canonical Model", "canonical_model"],
        ["Alias Type", "alias_type"], ["Confidence", "confidence"], ["Notes", "notes"]]
        .map(([header, key]) => ({ header, key })),
    },
    reviews: {
      sql: "SELECT * FROM validation_reviews ORDER BY candidate_make, candidate_model",
      cols: [["Candidate Make", "candidate_make"], ["Candidate Model", "candidate_model"],
        ["Candidate Years", "candidate_model_years"], ["Issue Type", "issue_type"],
        ["Reason Not Approved", "reason_not_approved"], ["Review Status", "review_status"],
        ["Recommended Next Action", "recommended_next_action"], ["Notes", "notes"]]
        .map(([header, key]) => ({ header, key })),
    },
    "model-years": {
      sql: `SELECT k.standard_make, m.standard_model, y.model_year, m.vehicle_category,
        m.lifecycle_status, y.validation_status, y.source_url
        FROM model_years y JOIN models m ON m.id=y.model_id JOIN makes k ON k.id=m.make_id
        ORDER BY y.model_year, k.standard_make, m.standard_model`,
      cols: [["Standard Make", "standard_make"], ["Standard Model", "standard_model"],
        ["Model Year", "model_year"], ["Vehicle Category", "vehicle_category"],
        ["Lifecycle Status", "lifecycle_status"], ["Validation Status", "validation_status"],
        ["Source", "source_url"]].map(([header, key]) => ({ header, key })),
    },
    sources: {
      sql: "SELECT * FROM sources ORDER BY source_name",
      cols: [["Source Name", "source_name"], ["Source URL", "source_url"],
        ["Source Type", "source_type"], ["Evidence Type", "evidence_type"],
        ["Access Date", "access_date"], ["Known Limitations", "known_limitations"]]
        .map(([header, key]) => ({ header, key })),
    },
  };
  api.get("/export/csv/:name", (req, res) => {
    const spec = CSV_EXPORTS[req.params.name];
    if (!spec) return res.status(404).json({ error: "Unknown export" });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="catalog_${req.params.name}.csv"`);
    res.send(toCsv(all(spec.sql), spec.cols));
  });
  /** Filtered model export honoring current table filters and sort. */
  api.get("/export/models.csv", (req, res) => {
    const { where, params } = modelFilters(req);
    const sortKey = MODEL_SORTS[String(req.query.sort ?? "make")] ?? "k.standard_make";
    const dir = req.query.dir === "desc" ? "DESC" : "ASC";
    const rows = all(MODEL_LIST_SQL(where, `ORDER BY ${sortKey} ${dir}, m.standard_model`), params);
    const cols = [["Standard Make", "standard_make"], ["Standard Model", "standard_model"],
      ["Confirmed Model Years", "confirmed_model_years"],
      ["First Confirmed Model Year", "first_confirmed_model_year"],
      ["Last Confirmed Model Year", "last_confirmed_model_year"],
      ["Lifecycle Status", "lifecycle_status"], ["Vehicle Category", "vehicle_category"],
      ["Validation Status", "validation_status"],
      ["Present in Original Source", "present_in_original_source"],
      ["Catalog Origin", "catalog_origin"], ["Sub-model Count", "submodel_count"],
      ["Primary Source URL", "primary_source_url"], ["Notes", "notes"]]
      .map(([header, key]) => ({ header, key }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="catalog_models_filtered.csv"');
    res.send(toCsv(rows, cols));
  });

  // ------------------------------ admin ------------------------------
  api.post("/admin/import", (_req, res) => {
    try {
      const report = runImport(db);
      res.json({ ok: true, report });
    } catch (e) {
      res.status(422).json({ ok: false, error: String(e),
        report: (e as { report?: unknown }).report ?? null });
    }
  });
  api.post("/admin/backup", (_req, res) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(BACKUP_DIR, `catalog-${stamp}.db`);
    db.prepare("VACUUM INTO ?").run(dest);
    db.prepare(`INSERT INTO audit_changes (action_type, entity_table, before_value, after_value, reason)
      VALUES ('backup','database',NULL,?,?)`).run(dest, "Manual backup from admin UI");
    res.json({ ok: true, path: dest });
  });
  api.get("/admin/backups", (_req, res) => {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db"))
      .map((f) => ({ file: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size,
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }));
    res.json({ backups: files, dbPath: DB_PATH });
  });
  api.get("/admin/binding", (_req, res) => {
    const cfg = loadConfig();
    res.json({
      summary: bindingSummary(),
      bindAddress: cfg.server.bindAddress,
      port: cfg.server.port,
      allowLanAccess: cfg.server.allowLanAccess,
      reachableFrom: cfg.server.allowLanAccess
        ? "This machine and other machines on the local network"
        : "This machine only (loopback)",
    });
  });
  api.post("/export/excel/regenerate", async (_req, res) => {
    const p = await writeWorkbook(db);
    res.json({ ok: true, path: p });
  });

  return api;
}
