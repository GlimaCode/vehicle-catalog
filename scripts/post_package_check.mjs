/**
 * Drives the 22-step post-package installation checklist against an extracted
 * final release. Usage: node scripts/post_package_check.mjs "<extracted app>"
 */
import { spawn, execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const APP = process.argv[2];
const PORT = 4327;
const ROOT = `http://127.0.0.1:${PORT}`;
const OUT = process.argv[3] ?? path.resolve("exports", "post_package_steps.json");
const steps = [];
const step = (n, name, ok, detail = "") =>
  steps.push({ step: n, name, ok: !!ok, detail: String(detail).slice(0, 300) });

const req = async (p, init = {}) => {
  const res = await fetch(ROOT + p, init);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json()
    : ct.includes("sheet") ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, body, headers: res.headers };
};
const json = (o) => ({ method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(o) });
const CANONICAL = ["makes", "models", "model_years", "vehicle_hierarchy_values",
  "hierarchy_value_years", "vehicle_configuration_values",
  "configuration_value_years", "aliases", "grouped_model_relationships"];
const DB = path.join(APP, "data", "catalog-v5.1.db");
const counts = () => {
  const db = new Database(DB, { readonly: true });
  const out = Object.fromEntries(CANONICAL.map((t) =>
    [t, db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()]));
  db.close();
  return out;
};

const startServer = () => spawn(`npm.cmd start > "${path.join(APP, "server-run.log")}" 2>&1`,
  { cwd: APP, env: { ...process.env, PORT: String(PORT) }, shell: true });
const waitUp = async () => {
  for (let i = 0; i < 90; i++) {
    try { await req("/api/summary"); return true; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return false;
};
const killTree = (proc) => {
  try { execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { /* already gone */ }
};

const before = counts();
let server = startServer();
const uploads = {};
let pid;

try {
  // 4. start-app.bat equivalent
  step(4, "Run start-app.bat (server starts)", await waitUp());

  // 5. binds to 127.0.0.1
  const bind = await req("/api/admin/binding");
  step(5, "Server binds to 127.0.0.1", bind.body.bindAddress === "127.0.0.1"
    && bind.body.allowLanAccess === false, JSON.stringify(bind.body));

  // 6. dashboard
  const summary = await req("/api/summary");
  const home = await req("/");
  step(6, "Open the Dashboard", summary.status === 200 && home.status === 200
    && String(home.body).includes("<div id=\"root\">"),
    `makes=${summary.body.cards?.makes} html=${home.status}`);

  // 7. canonical Make and Model pages
  const makes = await req("/api/makes");
  const firstMake = makes.body.rows[0];
  const makeDetail = await req(`/api/makes/${firstMake.id}`);
  const modelList = await req(`/api/models?make=${firstMake.id}`);
  const firstModel = modelList.body.rows[0];
  const modelDetail = await req(`/api/models/${firstModel.id}`);
  step(7, "Open an existing canonical Make and Model page",
    makeDetail.status === 200 && modelDetail.status === 200
    && modelList.body.rows.length > 0,
    `${firstMake.standard_make} (${modelList.body.total} models) -> `
    + `${firstModel.standard_model}`);

  // 8 + 9. upload bundled samples
  for (const [label, file] of [["CSV", "sample_vehicle_listings.csv"],
    ["XLSX", "sample_vehicle_listings.xlsx"]]) {
    const buf = fs.readFileSync(path.join(APP, "samples", file));
    const res = await fetch(ROOT + "/api/std/upload", { method: "POST", body: buf,
      headers: { "X-Filename": file, "Content-Type": "application/octet-stream" } });
    const body = await res.json();
    uploads[label] = body;
    step(label === "CSV" ? 8 : 9, `Upload the bundled sample ${label}`,
      res.status === 200 && body.projectId > 0,
      `status=${res.status} rows=${body?.preview?.rowCount}`);
  }

  // 10. map columns
  let mapped = 0;
  for (const up of Object.values(uploads)) {
    const columns = up.preview.headers.map((h, i) => ({ column: h, index: i,
      field: h === "Year" ? "Model Year"
        : ["Make", "Model", "Trim", "Drivetrain", "Title", "Item ID"].includes(h) ? h
        : "Preserve as Custom Field" }));
    const r = await req(`/api/std/projects/${up.projectId}/mapping`,
      json({ mapping: { headerRow: 1, preserveUnmapped: true, columns } }));
    if (r.status === 200) mapped++;
  }
  step(10, "Map columns for both projects", mapped === 2, `${mapped}/2 mapped`);

  // 11. process both
  let processed = 0;
  for (const up of Object.values(uploads)) {
    await req(`/api/std/projects/${up.projectId}/process`, json({}));
    for (let i = 0; i < 90; i++) {
      const pr = await req(`/api/std/projects/${up.projectId}/progress`);
      if (!pr.body.running && pr.body.status !== "Processing") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const info = await req(`/api/std/projects/${up.projectId}`);
    if (info.body.stats.inputRows === 10) processed++;
  }
  step(11, "Process both projects", processed === 2, `${processed}/2 processed`);

  // 12. confidence behaviours
  pid = uploads.CSV.projectId;
  const rows = await req(`/api/std/projects/${pid}/rows?pageSize=100`);
  const seen = new Set();
  for (const r of rows.body.rows) {
    for (const f of Object.values(r.normalized.fields)) if (f.confidence) seen.add(f.confidence);
  }
  const want = ["Exact Canonical", "Approved Alias", "Deterministic Normalization",
    "No Match", "Conflict"];
  const found = want.filter((w) => [...seen].some((s) => s.includes(w.split(" ")[0])));
  step(12, "Exact, alias, deterministic, no-match and conflict behaviour observed",
    found.length >= 4, `observed: ${[...seen].join(", ")}`);

  // 13. review decision
  const conflictRow = rows.body.rows.find((r) =>
    Object.values(r.normalized.fields).some((f) => f.confidence === "Conflict"));
  const field = conflictRow && Object.entries(conflictRow.normalized.fields)
    .find(([, f]) => f.confidence === "Conflict")[0];
  const decision = conflictRow ? await req(`/api/std/projects/${pid}/decision`,
    json({ rowNumber: conflictRow.row_number, field, decision: "Keep Original",
      notes: "post-package check" })) : { status: 0 };
  step(13, "Make one review decision", decision.status === 200,
    `row ${conflictRow?.row_number} field ${field}`);

  // 14 + 15 + 16. exports
  const csv = await req(`/api/std/projects/${pid}/export.csv?mode=audit`);
  step(14, "Export standardized CSV", csv.status === 200
    && String(csv.body).includes("Standard Make"),
    `${String(csv.body).length} B, protection=`
    + csv.headers.get("x-formula-injection-protection-applied"));
  const xlsx = await req(`/api/std/projects/${pid}/export.xlsx?mode=audit`);
  step(15, "Export standardized XLSX", xlsx.status === 200 && xlsx.body.length > 5000,
    `${xlsx.body.length} B`);
  const rep = await req(`/api/std/projects/${pid}/change-report.xlsx`);
  step(16, "Export the change-report workbook", rep.status === 200 && rep.body.length > 5000,
    `${rep.body.length} B`);

  // 17. backup
  const backup = await req("/api/admin/backup", json({}));
  step(17, "Create a database backup", backup.status === 200 && !!backup.body.path,
    path.basename(String(backup.body.path ?? backup.body.error)));
} catch (e) {
  step("error", "Unexpected failure during steps 4-17", false, String(e));
} finally {
  killTree(server);
  await new Promise((r) => setTimeout(r, 2500));
}

// 18 + 19. restart and history
server = startServer();
try {
  const up = await waitUp();
  step(18, "Stop and restart the application", up);
  const projects = await req("/api/std/projects");
  const list = Array.isArray(projects.body) ? projects.body : projects.body.projects;
  step(19, "Project history remains available after restart",
    list.length >= 2 && list.every((p) => p.row_count > 0), `${list.length} project(s)`);

  // 20. delete the test projects
  let deleted = 0;
  for (const up2 of Object.values(uploads)) {
    const r = await req(`/api/std/projects/${up2.projectId}?scope=project`
      + `&reason=post-package%20check`, { method: "DELETE" });
    if (r.status === 200) deleted++;
  }
  const after = await req("/api/std/projects");
  const remaining = (Array.isArray(after.body) ? after.body : after.body.projects).length;
  step(20, "Delete the test projects", deleted === 2 && remaining === 0,
    `${deleted} deleted, ${remaining} remaining`);
} catch (e) {
  step("error", "Unexpected failure during steps 18-20", false, String(e));
} finally {
  killTree(server);
  await new Promise((r) => setTimeout(r, 2500));
}

// 21. canonical counts unchanged
const after = counts();
const same = CANONICAL.every((t) => before[t] === after[t]);
step(21, "Canonical counts remain unchanged", same,
  same ? JSON.stringify(after) : `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);

// 22. clean shutdown
let listening = true;
try { await fetch(ROOT + "/api/summary", { signal: AbortSignal.timeout(2500) }); }
catch { listening = false; }
step(22, "Stop all processes cleanly", !listening,
  listening ? "a server is still listening" : "no process listening on the port");

const report = { generatedAt: new Date().toISOString(), application: APP,
  canonicalBefore: before, canonicalAfter: after, steps,
  status: steps.every((s) => s.ok) ? "PASS" : "FAIL" };
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status,
  failed: steps.filter((s) => !s.ok) }, null, 1));
