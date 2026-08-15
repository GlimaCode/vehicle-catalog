/**
 * Title Optimizer HTTP API.
 *
 * Mounted at /api/title. Like the standardization router, every request runs
 * inside the standardization context, so no route here can reach
 * withCanonicalUnlocked() - canonical data is unreachable from HTTP input.
 */
import express, { Router } from "express";
import type Database from "better-sqlite3";
import { assertSafeUpload, UnsafeFileError } from "../security/workbook.js";
import { LockBusyError, withLock } from "../security/locks.js";
import { enterStandardizationContext } from "../canonical_lock.js";
import { previewFile } from "../standardize/parse.js";
import { loadConfig } from "../config.js";
import {
  applyTitleDecision, applyToSimilar, approveAllWithinLimit, createTitleProject,
  getTitleProject, loadAbbreviations, loadEnabledRules, processTitleProject,
  saveTitleUpload, setTitleMapping, titleProjectStats, TITLE_FIELDS,
} from "./project.js";
import {
  buildTitleReport, exportTitleXlsx, streamTitleCsv, type TitleExportMode,
} from "./exports.js";

export function createTitleApi(db: Database.Database): Router {
  const api = Router();
  api.use(express.json({ limit: "2mb" }));
  // Everything under /api/title is a standardization-class operation.
  api.use((_req, _res, next) => { enterStandardizationContext(); next(); });

  const running = new Map<number, { cancelled: boolean }>();
  const all = <T>(sql: string, params: unknown[] = []) =>
    db.prepare(sql).all(...params) as T[];

  // ---------------------------------------------------------------- metadata
  api.get("/fields", (_req, res) => {
    res.json({ fields: TITLE_FIELDS, mandatory: ["Title"],
      maxCharacters: loadConfig().title.maxCharacters,
      characterCounting: "Unicode code points" });
  });

  api.get("/rules", (req, res) => {
    const pid = req.query.project ? Number(req.query.project) : null;
    res.json({ rules: all(`SELECT * FROM title_rules
      WHERE project_id IS NULL OR project_id=? ORDER BY stage, rule_id`, [pid ?? -1]),
      enabled: [...loadEnabledRules(db, pid)] });
  });

  api.post("/rules/:ruleId", (req, res) => {
    const enabled = req.body?.enabled ? 1 : 0;
    const projectId = req.body?.projectId ? Number(req.body.projectId) : null;
    if (projectId) {
      // a project-level override never changes the global rule catalog
      const base = db.prepare("SELECT * FROM title_rules WHERE rule_id=? AND project_id IS NULL")
        .get(req.params.ruleId) as Record<string, any> | undefined;
      if (!base) return res.status(404).json({ error: "Rule not found" });
      db.prepare(`INSERT INTO title_rules (rule_id, rule_name, stage, description,
        enabled, destructive, project_id) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(rule_id) DO UPDATE SET enabled=excluded.enabled`)
        .run(`${base.rule_id}@${projectId}`, base.rule_name, base.stage,
          base.description, enabled, base.destructive, projectId);
    } else {
      db.prepare("UPDATE title_rules SET enabled=? WHERE rule_id=?")
        .run(enabled, req.params.ruleId);
    }
    res.json({ ok: true });
  });

  api.get("/abbreviations", (req, res) => {
    const pid = req.query.project ? Number(req.query.project) : null;
    res.json({ abbreviations: loadAbbreviations(db, pid) });
  });

  api.post("/abbreviations", (req, res) => {
    const b = req.body ?? {};
    if (!b.full || !b.abbreviated) {
      return res.status(400).json({ error: "full and abbreviated are required" });
    }
    if (/leather/i.test(String(b.full))) {
      return res.status(400).json({
        error: "Leather and Genuine Leather must never be abbreviated." });
    }
    db.prepare(`INSERT INTO title_abbreviation_mappings
      (full_value, abbreviated_value, applicable_field, minimum_characters_saved,
       ambiguity_risk, approval_status, project_id, notes)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(full_value, applicable_field, project_id)
      DO UPDATE SET abbreviated_value=excluded.abbreviated_value,
        ambiguity_risk=excluded.ambiguity_risk,
        approval_status=excluded.approval_status, notes=excluded.notes`)
      .run(b.full, b.abbreviated, b.field ?? "Any", b.minimumCharactersSaved ?? 1,
        b.ambiguityRisk ?? "Low", b.approvalStatus ?? "Approved",
        b.projectId ?? null, b.notes ?? null);
    res.json({ ok: true });
  });

  // --------------------------------------------------------------- templates
  api.get("/templates", (_req, res) => {
    res.json({ templates: all("SELECT * FROM title_templates ORDER BY is_default DESC, name") });
  });

  api.post("/templates", (req, res) => {
    const b = req.body ?? {};
    if (!b.name || !b.pattern) {
      return res.status(400).json({ error: "name and pattern are required" });
    }
    try {
      const info = db.prepare(`INSERT INTO title_templates
        (name, pattern, required_fields, optional_fields, field_priority,
         is_default, project_id, notes) VALUES (?,?,?,?,?,?,?,?)`)
        .run(b.name, b.pattern, JSON.stringify(b.required ?? []),
          JSON.stringify(b.optional ?? []), JSON.stringify(b.priority ?? []),
          b.isDefault ? 1 : 0, b.projectId ?? null, b.notes ?? null);
      if (b.isDefault) {
        db.prepare("UPDATE title_templates SET is_default=0 WHERE id<>?")
          .run(info.lastInsertRowid);
      }
      res.json({ ok: true, id: Number(info.lastInsertRowid) });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  api.post("/templates/:id/duplicate", (req, res) => {
    const src = db.prepare("SELECT * FROM title_templates WHERE id=?")
      .get(Number(req.params.id)) as Record<string, any> | undefined;
    if (!src) return res.status(404).json({ error: "Template not found" });
    const name = String(req.body?.name ?? `${src.name} (copy)`);
    const info = db.prepare(`INSERT INTO title_templates
      (name, pattern, required_fields, optional_fields, field_priority, is_default,
       project_id, notes) VALUES (?,?,?,?,?,0,?,?)`)
      .run(name, src.pattern, src.required_fields, src.optional_fields,
        src.field_priority, req.body?.projectId ?? null,
        `Duplicated from "${src.name}"`);
    res.json({ ok: true, id: Number(info.lastInsertRowid), name });
  });

  api.post("/templates/:id/default", (req, res) => {
    const id = Number(req.params.id);
    db.prepare("UPDATE title_templates SET is_default = (id = ?)").run(id);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- projects
  api.get("/projects", (_req, res) => {
    res.json(all(`SELECT p.*,
      (SELECT COUNT(*) FROM title_optimization_rows r WHERE r.project_id=p.id) row_count_actual,
      (SELECT COUNT(*) FROM title_optimization_rows r WHERE r.project_id=p.id
        AND r.title_status IN ('Manual Review Required','Unable to Reach Limit')) review_count
      FROM title_optimization_projects p ORDER BY p.id DESC`));
  });

  api.post("/upload", express.raw({ type: "*/*", limit: "512mb" }), async (req, res) => {
    const filename = String(req.header("X-Filename") ?? "upload.csv");
    try {
      assertSafeUpload(req.body as Buffer, filename);
    } catch (e) {
      if (e instanceof UnsafeFileError) {
        db.prepare(`INSERT INTO security_events (event_type, detail)
          VALUES ('title-upload-rejected', ?)`).run(String(e.message));
        return res.status(415).json({ error: e.message });
      }
      return res.status(400).json({ error: String(e) });
    }
    try {
      const saved = saveTitleUpload(req.body as Buffer, filename);
      const projectId = await createTitleProject(db, {
        filename, stored: saved.stored, hash: saved.hash,
        storageId: saved.storageId,
        sourceProjectId: req.query.from ? Number(req.query.from) : undefined,
      });
      const project = getTitleProject(db, projectId)!;
      const preview = await previewFile(saved.stored, { previewRows: 20 });
      res.json({ projectId, filename: saved.displayName, preview,
        maxCharacters: project.max_characters });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  /** Creates a title project from an existing standardization project's export. */
  api.post("/from-standardization/:id", async (req, res) => {
    const sourceId = Number(req.params.id);
    const src = db.prepare("SELECT * FROM standardization_projects WHERE id=?")
      .get(sourceId) as Record<string, any> | undefined;
    if (!src) return res.status(404).json({ error: "Standardization project not found" });
    if (!src.stored_path) {
      return res.status(400).json({ error: "The source upload is no longer available." });
    }
    try {
      const projectId = await createTitleProject(db, {
        filename: String(src.display_filename ?? src.input_filename),
        stored: String(src.stored_path), hash: String(src.input_file_hash),
        projectName: `${src.project_name} (titles)`,
        storageId: (src.storage_id as string) ?? undefined,
        sourceProjectId: sourceId,
      });
      res.json({ ok: true, projectId });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  api.get("/projects/:id", (req, res) => {
    const id = Number(req.params.id);
    const project = getTitleProject(db, id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({ project, stats: titleProjectStats(db, id),
      decisions: all("SELECT * FROM title_manual_decisions WHERE project_id=? ORDER BY id DESC",
        [id]) });
  });

  api.post("/projects/:id/mapping", (req, res) => {
    try {
      setTitleMapping(db, Number(req.params.id), req.body?.mapping);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message ?? e) });
    }
  });

  api.post("/projects/:id/process", async (req, res) => {
    const id = Number(req.params.id);
    if (running.has(id)) return res.status(409).json({ error: "Already processing" });
    const signal = { cancelled: false };
    running.set(id, signal);
    try {
      const result = await withLock("title-process", id, `Optimizing titles for ${id}`,
        () => processTitleProject(db, id, {
          templateId: req.body?.templateId ?? null, signal }));
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      db.prepare(`UPDATE title_optimization_projects SET status='Failed',
        notes=? WHERE id=?`).run(String(e), id);
      res.status(500).json({ error: String(e) });
    } finally {
      running.delete(id);
    }
  });

  api.post("/projects/:id/cancel", (req, res) => {
    const signal = running.get(Number(req.params.id));
    if (signal) signal.cancelled = true;
    res.json({ ok: true, cancelling: !!signal });
  });

  api.get("/projects/:id/progress", (req, res) => {
    const id = Number(req.params.id);
    const p = getTitleProject(db, id);
    if (!p) return res.status(404).json({ error: "Project not found" });
    res.json({ status: p.status, processed: p.processed_rows, total: p.row_count,
      running: running.has(id) });
  });

  // ------------------------------------------------------------------ review
  api.get("/projects/:id/rows", (req, res) => {
    const id = Number(req.params.id);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize ?? 50)));
    const filters: string[] = ["project_id = ?"];
    const params: unknown[] = [id];
    if (req.query.status) { filters.push("title_status = ?"); params.push(req.query.status); }
    if (req.query.overLimit === "true") {
      const p = getTitleProject(db, id);
      filters.push("COALESCE(final_length, proposed_length) > ?");
      params.push(Number(p?.max_characters ?? 80));
    }
    if (req.query.manualReview === "true") {
      filters.push("title_status IN ('Manual Review Required','Unable to Reach Limit')");
    }
    if (req.query.make) {
      filters.push("json_extract(source_json,'$.Make') = ?"); params.push(req.query.make);
    }
    if (req.query.model) {
      filters.push("json_extract(source_json,'$.Model') = ?"); params.push(req.query.model);
    }
    const where = `WHERE ${filters.join(" AND ")}`;
    const total = db.prepare(`SELECT COUNT(*) FROM title_optimization_rows ${where}`)
      .pluck().get(...params) as number;
    const rows = all(`SELECT * FROM title_optimization_rows ${where}
      ORDER BY row_number LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    res.json({ rows, total, page, pageSize });
  });

  api.post("/projects/:id/decision", (req, res) => {
    try {
      res.json(applyTitleDecision(db, Number(req.params.id), req.body));
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message ?? e) });
    }
  });

  api.post("/projects/:id/approve-within-limit", (req, res) => {
    res.json(approveAllWithinLimit(db, Number(req.params.id)));
  });

  api.post("/projects/:id/apply-to-similar", (req, res) => {
    try {
      res.json(applyToSimilar(db, Number(req.params.id), Number(req.body?.rowNumber)));
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message ?? e) });
    }
  });

  // ----------------------------------------------------------------- exports
  const modeOf = (req: express.Request): TitleExportMode =>
    (req.query.mode === "replacement" ? "replacement" : "audit");

  api.get("/projects/:id/export.csv", async (req, res) => {
    const id = Number(req.params.id);
    const mode = modeOf(req);
    try {
      const name = `title-project-${id}-${mode}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("X-Formula-Injection-Protection-Applied", "Enabled");
      await withLock("title-export", id, `Exporting titles for ${id}`,
        () => streamTitleCsv(db, id, mode, (chunk) => res.write(chunk)));
      markExported(id);
      res.end();
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get("/projects/:id/export.xlsx", async (req, res) => {
    const id = Number(req.params.id);
    const mode = modeOf(req);
    try {
      const { wb, protection } = await withLock("title-export", id,
        `Exporting titles for ${id}`, () => exportTitleXlsx(db, id, mode));
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="title-project-${id}-${mode}.xlsx"`);
      res.setHeader("X-Formula-Injection-Protection-Applied",
        protection.neutralizedCells > 0 ? "Yes" : "No");
      await wb.xlsx.write(res);
      markExported(id);
      res.end();
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get("/projects/:id/report.xlsx", async (req, res) => {
    const id = Number(req.params.id);
    const p = getTitleProject(db, id);
    if (!p) return res.status(404).json({ error: "Project not found" });
    const base = String(p.display_filename ?? p.input_filename).replace(/\.[^.]+$/, "");
    try {
      const wb = await buildTitleReport(db, id);
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="${base}_Title_Optimization_Report.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  function markExported(id: number) {
    db.prepare(`UPDATE title_optimization_projects SET status='Exported',
      completed_at=datetime('now') WHERE id=? AND status IN ('Ready to Export','Review Required')`)
      .run(id);
  }

  return api;
}
