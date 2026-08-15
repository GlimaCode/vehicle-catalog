/** REST API for the File Standardization workspace (canonical catalog: read-only). */
import express, { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { norm } from "../db.js";
import { previewFile, listWorksheets } from "./parse.js";
import { CanonicalResolver } from "./resolver.js";
import { saveUpload, createProject, getProject, setMapping, processProject,
  applyDecision, applyToAll, countIdentical, projectStats, projectOutcome,
  refreshStatus, CANONICAL_FIELDS, type ProjectMapping, type Decision } from "./project.js";
import { exportCsvWithStats, exportXlsxWithStats, streamExportCsv, buildChangeReport,
  buildReviewOnlyWorkbook, valueMappingCsv, jsonReport, buildLookupWorkbook,
  writeAllOutputs, type ExportMode } from "./exports.js";
import { assertSafeUpload, UnsafeFileError } from "../security/workbook.js";
import { withLock, LockBusyError, currentHolders } from "../security/locks.js";
import { enterStandardizationContext, exitStandardizationContext } from "../canonical_lock.js";
import { previewDeletion, executeDeletion, applyRetentionPolicy,
  type DeleteScope } from "../retention.js";
import { loadConfig } from "../config.js";

const running = new Map<number, Promise<unknown>>();

export function createStandardizeApi(db: Database.Database): Router {
  const api = Router();
  api.use(express.json({ limit: "50mb" }));
  /**
   * Everything under /api/std runs inside the standardization context, which
   * makes any canonical-catalog unlock attempt throw. Nothing reachable from
   * this router can modify the frozen Version 4 catalog.
   */
  api.use((_req, res, next) => {
    enterStandardizationContext();
    res.on("finish", exitStandardizationContext);
    res.on("close", exitStandardizationContext);
    next();
  });
  const all = <T = Record<string, unknown>>(sql: string, p: unknown[] = []): T[] =>
    db.prepare(sql).all(...p) as T[];

  // ------------------------------- upload -------------------------------
  api.post("/upload", express.raw({ type: "*/*", limit: "512mb" }), async (req, res) => {
    try {
      const filename = String(req.header("X-Filename") ?? "upload.csv");
      const projectName = req.header("X-Project-Name")
        ? decodeURIComponent(String(req.header("X-Project-Name"))) : undefined;
      const buf = req.body as Buffer;
      if (!buf?.length) return res.status(400).json({ error: "Empty upload" });
      // untrusted input: inspect signature, structure and limits before storing
      const inspection = assertSafeUpload(buf, filename);
      const { stored, hash, storageId, displayName } = saveUpload(buf, filename);
      const worksheets = /\.xlsx$/i.test(displayName) ? await listWorksheets(stored) : [];
      const id = await createProject(db, { filename, stored, hash, projectName, storageId });
      const preview = await previewFile(stored, {
        worksheetName: worksheets[0]?.name, headerRow: 1 });
      if (inspection.warnings.length) {
        db.prepare(`INSERT INTO security_events (event_type, detail, project_id)
          VALUES ('upload-warning', ?, ?)`)
          .run(JSON.stringify(inspection.warnings), id);
      }
      res.json({ ok: true, projectId: id, worksheets, preview,
        fileSize: buf.length, filename: displayName, hash, inspection });
    } catch (e) {
      if (e instanceof UnsafeFileError) {
        db.prepare(`INSERT INTO security_events (event_type, detail)
          VALUES ('upload-rejected', ?)`).run(JSON.stringify(e.details.reasons));
        return res.status(415).json({ error: e.message, inspection: e.details });
      }
      res.status(422).json({ error: String(e) });
    }
  });

  api.get("/projects", (_req, res) => {
    res.json(all(`SELECT p.*,
      (SELECT COUNT(*) FROM standardization_rows r WHERE r.project_id=p.id
        AND r.review_required=1 AND r.excluded=0) review_count,
      (SELECT COUNT(DISTINCT row_number) FROM standardization_changes c
        WHERE c.project_id=p.id AND c.field_name<>'(row)') changed_rows,
      (SELECT COUNT(*) FROM project_exports e WHERE e.project_id=p.id) export_count
      FROM standardization_projects p ORDER BY p.id DESC`));
  });

  api.get("/projects/:id", (req, res) => {
    const p = getProject(db, Number(req.params.id));
    if (!p) return res.status(404).json({ error: "Project not found" });
    res.json({ project: p, stats: projectStats(db, Number(req.params.id)),
      outcome: projectOutcome(db, Number(req.params.id)),
      exports: all("SELECT * FROM project_exports WHERE project_id=? ORDER BY id DESC",
        [req.params.id]),
      mappings: all("SELECT * FROM project_value_mappings WHERE project_id=?",
        [req.params.id]) });
  });

  api.get("/projects/:id/preview", async (req, res) => {
    const p = getProject(db, Number(req.params.id));
    if (!p) return res.status(404).json({ error: "Project not found" });
    try {
      const preview = await previewFile(String(p.stored_path), {
        worksheetName: req.query.worksheet ? String(req.query.worksheet)
          : (p.worksheet_name ? String(p.worksheet_name) : undefined),
        headerRow: Number(req.query.headerRow ?? p.header_row),
        previewRows: 20 });
      res.json({ preview, fileSize: fs.statSync(String(p.stored_path)).size });
    } catch (e) {
      res.status(422).json({ error: String(e) });
    }
  });

  api.patch("/projects/:id", (req, res) => {
    const { worksheetName, headerRow, projectName, autoApplyHigh, notes } = req.body ?? {};
    db.prepare(`UPDATE standardization_projects SET
      worksheet_name=COALESCE(?, worksheet_name),
      header_row=COALESCE(?, header_row),
      project_name=COALESCE(?, project_name),
      auto_apply_high_confidence=COALESCE(?, auto_apply_high_confidence),
      notes=COALESCE(?, notes), updated_at=datetime('now') WHERE id=?`)
      .run(worksheetName ?? null, headerRow ?? null, projectName ?? null,
        autoApplyHigh == null ? null : (autoApplyHigh ? 1 : 0), notes ?? null,
        req.params.id);
    res.json({ ok: true, project: getProject(db, Number(req.params.id)) });
  });

  api.get("/fields", (_req, res) => res.json({ fields: CANONICAL_FIELDS }));

  // ------------------------------- mapping -------------------------------
  api.post("/projects/:id/mapping", (req, res) => {
    const mapping = req.body?.mapping as ProjectMapping;
    if (!mapping?.columns) return res.status(400).json({ error: "mapping.columns required" });
    const used = new Map<string, number>();
    for (const c of mapping.columns) {
      if (c.field === "Ignore" || c.field === "Preserve as Custom Field") continue;
      used.set(c.field, (used.get(c.field) ?? 0) + 1);
    }
    const dupes = [...used.entries()].filter(([, n]) => n > 1)
      .filter(([f]) => !mapping.columns.some((c) => c.field === f && c.merge));
    if (dupes.length) {
      return res.status(400).json({
        error: `Two columns map to the same field without a merge strategy: `
          + dupes.map(([f]) => f).join(", ") });
    }
    const hasVehicle = mapping.columns.some((c) => c.field === "Make" || c.field === "Model");
    if (!hasVehicle) {
      return res.status(400).json({
        error: "At least one column must be mapped to Make or Model before "
          + "vehicle standardization can run." });
    }
    setMapping(db, Number(req.params.id), mapping, req.body?.templateId);
    res.json({ ok: true });
  });

  // ------------------------------ processing ------------------------------
  api.post("/projects/:id/process", (req, res) => {
    const id = Number(req.params.id);
    if (running.has(id)) {
      return res.status(409).json({ error:
        "This project is already being processed. Wait for the current run to "
        + "finish, or cancel it, rather than starting it twice." });
    }
    if (running.size >= loadConfig().processing.maxConcurrentProjects) {
      return res.status(429).json({ error:
        `${running.size} projects are already processing (configured maximum). `
        + "Wait for one to finish before starting another." });
    }
    const resume = req.body?.resume === true;
    // project-scoped lock: other projects can process concurrently
    const job = withLock("process", id, `Processing project ${id}`,
      () => processProject(db, id, { resume }))
      .catch((e) => {
        if (e instanceof LockBusyError) throw e;
        db.prepare(`UPDATE standardization_projects SET status='Failed', notes=?,
          recovery_state=? WHERE id=?`)
          .run(String(e), "Run failed; the project can be re-processed.", id);
      })
      .finally(() => running.delete(id));
    running.set(id, job);
    res.json({ ok: true, started: true, resume });
  });

  api.get("/locks", (_req, res) => res.json({ holders: currentHolders(),
    running: [...running.keys()] }));
  api.post("/projects/:id/cancel", (req, res) => {
    db.prepare("UPDATE standardization_projects SET cancel_requested=1 WHERE id=?")
      .run(req.params.id);
    res.json({ ok: true });
  });
  api.get("/projects/:id/progress", (req, res) => {
    const p = getProject(db, Number(req.params.id));
    if (!p) return res.status(404).json({ error: "Project not found" });
    res.json({ status: p.status, processed: p.processed_rows, total: p.row_count,
      running: running.has(Number(req.params.id)) });
  });

  // -------------------------------- rows --------------------------------
  api.get("/projects/:id/rows", (req, res) => {
    const id = Number(req.params.id);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));
    const where = ["project_id=?"];
    const params: unknown[] = [id];
    if (req.query.review === "true") where.push("review_required=1 AND excluded=0");
    if (req.query.excluded === "true") where.push("excluded=1");
    const w = "WHERE " + where.join(" AND ");
    const total = (db.prepare(`SELECT COUNT(*) n FROM standardization_rows ${w}`)
      .get(...params) as { n: number }).n;
    const rows = all(`SELECT row_number, original_json, normalized_json, review_required,
      excluded, user_decision, conflict_reason FROM standardization_rows ${w}
      ORDER BY row_number LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
      .map((r) => ({ ...r, original: JSON.parse(String(r.original_json)),
        normalized: JSON.parse(String(r.normalized_json ?? "{}")) }));
    res.json({ rows, total, page, pageSize });
  });

  api.post("/projects/:id/decision", (req, res) => {
    const { rowNumber, field, decision, value, notes } = req.body ?? {};
    try {
      applyDecision(db, Number(req.params.id), Number(rowNumber), String(field),
        decision as Decision, value, notes);
      res.json({ ok: true, status: refreshStatus(db, Number(req.params.id)) });
    } catch (e) {
      res.status(422).json({ error: String(e) });
    }
  });

  api.get("/projects/:id/identical-count", (req, res) => {
    res.json({ count: countIdentical(db, Number(req.params.id),
      String(req.query.field), String(req.query.value ?? "")) });
  });

  api.post("/projects/:id/apply-all", (req, res) => {
    const { field, rawValue, canonicalValue, decision, make, model, notes } = req.body ?? {};
    try {
      const affected = applyToAll(db, Number(req.params.id), String(field),
        String(rawValue), canonicalValue ?? null,
        String(decision ?? "Apply to All Identical Values"), { make, model }, notes);
      res.json({ ok: true, affected });
    } catch (e) {
      res.status(422).json({ error: String(e) });
    }
  });

  /** Canonical suggestions for the review UI (read-only lookups). */
  api.get("/suggestions", (req, res) => {
    const make = req.query.make ? String(req.query.make) : null;
    const model = req.query.model ? String(req.query.model) : null;
    const resolver = new CanonicalResolver(db);
    if (make && model) {
      return res.json({ hierarchy: resolver.hierarchyValuesFor(make, model)
        .map((v) => ({ value: v.value, type: v.type, years: v.yearsText })) });
    }
    if (make) {
      const mk = all<{ id: number }>("SELECT id FROM makes WHERE norm_make=?", [norm(make)]);
      if (!mk.length) return res.json({ models: [] });
      return res.json({ models: all(`SELECT standard_model value, confirmed_model_years years
        FROM models WHERE make_id=? ORDER BY standard_model`, [mk[0].id]) });
    }
    res.json({ makes: all("SELECT standard_make value FROM makes ORDER BY standard_make") });
  });

  // ------------------------------- templates -------------------------------
  api.get("/templates", (_req, res) =>
    res.json(all("SELECT * FROM mapping_templates ORDER BY template_name")));
  api.post("/templates", (req, res) => {
    const { templateName, description, mapping } = req.body ?? {};
    if (!templateName || !mapping) {
      return res.status(400).json({ error: "templateName and mapping are required" });
    }
    try {
      const info = db.prepare(`INSERT INTO mapping_templates (template_name, description,
        mapping_json) VALUES (?,?,?)
        ON CONFLICT(template_name) DO UPDATE SET mapping_json=excluded.mapping_json,
          description=excluded.description, updated_at=datetime('now')`)
        .run(templateName, description ?? "", JSON.stringify(mapping));
      res.json({ ok: true, id: Number(info.lastInsertRowid) });
    } catch (e) {
      res.status(422).json({ error: String(e) });
    }
  });
  api.post("/templates/:id/duplicate", (req, res) => {
    const t = db.prepare("SELECT * FROM mapping_templates WHERE id=?").get(req.params.id) as
      { template_name: string; description: string; mapping_json: string } | undefined;
    if (!t) return res.status(404).json({ error: "Template not found" });
    const name = `${t.template_name} (copy)`;
    const info = db.prepare(`INSERT INTO mapping_templates (template_name, description,
      mapping_json) VALUES (?,?,?)`).run(name, t.description, t.mapping_json);
    res.json({ ok: true, id: Number(info.lastInsertRowid), name });
  });
  api.delete("/templates/:id", (req, res) => {
    db.prepare("DELETE FROM mapping_templates WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  // -------------------------- catalog change proposals --------------------------
  api.get("/proposals", (_req, res) =>
    res.json(all("SELECT * FROM catalog_change_proposals ORDER BY id DESC")));
  api.post("/proposals", (req, res) => {
    const { recordType, rawValue, proposedValue, makeContext, modelContext,
      projectIds, occurrences, evidence, notes } = req.body ?? {};
    const info = db.prepare(`INSERT INTO catalog_change_proposals (proposed_record_type,
      raw_value, proposed_canonical_value, make_context, model_context,
      supporting_project_ids, occurrence_count, evidence, reviewer_notes)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(recordType ?? "Alias", rawValue, proposedValue ?? null, makeContext ?? null,
        modelContext ?? null, JSON.stringify(projectIds ?? []), occurrences ?? 0,
        evidence ?? "", notes ?? "");
    res.json({ ok: true, id: Number(info.lastInsertRowid),
      note: "Proposal recorded. The canonical Version 4 catalog is unchanged; "
        + "promotion requires an explicit catalog release." });
  });

  // -------------------------------- exports --------------------------------
  const recordExport = (id: number, type: string, mode: string, filename: string,
    rowCount: number, neutralized = 0) => {
    db.prepare(`INSERT INTO project_exports (project_id, export_type, mode, filename,
      row_count, neutralized_cells, formula_protection_applied)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, type, mode, filename, rowCount, neutralized,
        neutralized > 0 ? "Yes" : "No");
    db.prepare(`UPDATE standardization_projects SET status='Exported',
      completed_at=datetime('now') WHERE id=? AND status='Ready to Export'`).run(id);
  };

  api.get("/projects/:id/export.csv", async (req, res) => {
    const id = Number(req.params.id);
    const mode = (req.query.mode === "replacement" ? "replacement" : "audit") as ExportMode;
    const sort = req.query.sort === "make-model" ? "make-model" : "source";
    try {
      const name = `project-${id}-standardized-${mode}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      // the body streams, so the per-export count is not known when headers are
      // sent; the row-level "Formula Injection Protection Applied" column carries it
      res.setHeader("X-Formula-Injection-Protection-Applied", "Enabled");
      // streamed to the client row-by-row: memory stays flat for any size
      const protection = await withLock("export", id, `Exporting project ${id}`,
        () => streamExportCsv(db, id, mode, (chunk) => res.write(chunk), { sort }));
      recordExport(id, "CSV", mode, name, projectStats(db, id).exportRows,
        protection.neutralizedCells);
      res.end();
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get("/projects/:id/export.xlsx", async (req, res) => {
    const id = Number(req.params.id);
    const mode = (req.query.mode === "replacement" ? "replacement" : "audit") as ExportMode;
    const sort = req.query.sort === "make-model" ? "make-model" : "source";
    try {
      const { wb, protection } = await withLock("export", id, `Exporting project ${id}`,
        () => exportXlsxWithStats(db, id, mode, { sort }));
      const name = `project-${id}-standardized-${mode}.xlsx`;
      recordExport(id, "XLSX", mode, name, wb.worksheets[0].actualRowCount - 1,
        protection.neutralizedCells);
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("X-Formula-Injection-Protection-Applied",
        protection.neutralizedCells > 0 ? "Yes" : "No");
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get("/projects/:id/change-report.xlsx", async (req, res) => {
    const id = Number(req.params.id);
    const p = getProject(db, id)!;
    const wb = await buildChangeReport(db, id);
    const base = String(p.input_filename).replace(/\.[^.]+$/, "");
    const name = `${base}_Standardization_Changes.xlsx`;
    recordExport(id, "Change report", "", name, 0);
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    await wb.xlsx.write(res);
    res.end();
  });

  api.get("/projects/:id/review.xlsx", async (req, res) => {
    const id = Number(req.params.id);
    const wb = await buildReviewOnlyWorkbook(db, id);
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",
      `attachment; filename="project-${id}-review.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  api.get("/projects/:id/value-mappings.csv", (req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="project-${req.params.id}-value-mappings.csv"`);
    res.send(valueMappingCsv(db, Number(req.params.id)));
  });

  api.get("/projects/:id/report.json", (req, res) => {
    res.json(jsonReport(db, Number(req.params.id)));
  });

  /** Write every output to the project export folder on disk (atomically). */
  api.post("/projects/:id/export-all", async (req, res) => {
    const id = Number(req.params.id);
    const mode = (req.body?.mode === "replacement" ? "replacement" : "audit") as ExportMode;
    try {
      const result = await withLock("export", id, `Exporting project ${id}`,
        () => writeAllOutputs(db, id, mode));
      recordExport(id, "All outputs", mode, result.directory,
        projectStats(db, id).exportRows, result.protection.neutralizedCells);
      res.json({ ok: true, directory: result.directory, files: result.files,
        outcome: projectOutcome(db, id),
        formulaInjectionProtectionApplied: result.protection.neutralizedCells > 0,
        neutralizedCells: result.protection.neutralizedCells });
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  // ------------------------- retention and deletion -------------------------
  const SCOPES: DeleteScope[] = ["uploads", "exports", "rows", "project", "all-projects"];

  /** Preview exactly what a deletion would remove. Nothing is deleted here. */
  api.get("/projects/:id/deletion-preview", (req, res) => {
    const scope = String(req.query.scope ?? "project") as DeleteScope;
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: "Unknown scope" });
    res.json(previewDeletion(db, Number(req.params.id), scope));
  });

  api.delete("/projects/:id", async (req, res) => {
    const id = Number(req.params.id);
    const scope = String(req.query.scope ?? "project") as DeleteScope;
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: "Unknown scope" });
    // a delete that matched nothing must not report success
    if (!getProject(db, id)) return res.status(404).json({ error: "Project not found" });
    if (running.has(id)) {
      return res.status(409).json({ error:
        "This project is currently processing. Cancel the run before deleting it." });
    }
    try {
      const result = await withLock("delete", id, `Deleting project ${id}`,
        () => executeDeletion(db, id, scope, String(req.query.reason ?? "")));
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof LockBusyError) return res.status(409).json({ error: e.message });
      res.status(500).json({ error: String(e) });
    }
  });

  api.get("/retention", (_req, res) => {
    res.json({ policy: loadConfig().retention,
      deletions: all("SELECT * FROM project_deletions ORDER BY id DESC LIMIT 100"),
      securityEvents: all("SELECT * FROM security_events ORDER BY id DESC LIMIT 100") });
  });

  api.post("/retention/apply", (_req, res) => {
    res.json({ ok: true, ...applyRetentionPolicy(db) });
  });

  api.get("/lookup-workbook.xlsx", async (_req, res) => {
    const wb = await buildLookupWorkbook(db);
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",
      'attachment; filename="Canonical Vehicle Lookup.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  });

  return api;
}
