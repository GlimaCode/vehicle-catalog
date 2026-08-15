/**
 * Drives the 12-step clean-install checklist against an extracted release.
 * Usage: node scripts/clean_install_check.mjs "<path to extracted app>"
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP = process.argv[2];
const PORT = 4318;
const ROOT = `http://127.0.0.1:${PORT}`;
const steps = [];
const step = (n, name, ok, detail = "") =>
  steps.push({ step: n, name, ok: !!ok, detail: String(detail).slice(0, 300) });

const req = async (p, init = {}) => {
  const res = await fetch(ROOT + p, init);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
};

const server = spawn("npm.cmd", ["start"], {
  cwd: APP, env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"], shell: true,
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

try {
  let up = false;
  for (let i = 0; i < 90; i++) {
    try { await req("/api/summary"); up = true; break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  step(3, "start-app.bat server starts and serves the catalog API", up,
    serverLog.split("\n").find((l) => l.includes("listening")) ?? "");
  if (!up) throw new Error("server did not start");

  step("3b", "Binds to 127.0.0.1 only (local machine only)",
    /127\.0\.0\.1:\d+ \(local machine only\)/.test(serverLog),
    serverLog.split("\n").find((l) => l.includes("listening")) ?? "");

  // 4 + 5: upload sample CSV and XLSX
  const uploads = {};
  for (const [label, file] of [["CSV", "sample_vehicle_listings.csv"],
    ["XLSX", "sample_vehicle_listings.xlsx"]]) {
    const buf = fs.readFileSync(path.join(APP, "samples", file));
    const res = await fetch(ROOT + "/api/std/upload", { method: "POST", body: buf,
      headers: { "X-Filename": file, "Content-Type": "application/octet-stream" } });
    const body = await res.json();
    uploads[label] = body;
    step(label === "CSV" ? 4 : 5, `Upload the sample ${label}`,
      res.status === 200 && body.projectId > 0,
      `status=${res.status} rows=${body?.preview?.rowCount}`);
  }

  // 6: process both
  for (const [label, up2] of Object.entries(uploads)) {
    const headers = up2.preview.headers;
    const columns = headers.map((h, i) => ({ column: h, index: i,
      field: h === "Year" ? "Model Year"
        : ["Make", "Model", "Trim", "Drivetrain", "Title", "Item ID"].includes(h) ? h
        : "Preserve as Custom Field" }));
    await req(`/api/std/projects/${up2.projectId}/mapping`, { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mapping: { headerRow: 1, preserveUnmapped: true, columns } }) });
    await req(`/api/std/projects/${up2.projectId}/process`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{}" });
    let done = false;
    for (let i = 0; i < 60; i++) {
      const pr = await req(`/api/std/projects/${up2.projectId}/progress`);
      if (!pr.body.running && pr.body.status !== "Processing") { done = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const info = await req(`/api/std/projects/${up2.projectId}`);
    step(6, `Process the ${label} file`, done && info.body.stats.inputRows === 10,
      `rows=${info.body.stats.inputRows} outcome=${info.body.outcome}`);
  }

  // 7: review a conflict
  const pid = uploads.CSV.projectId;
  const rows = await req(`/api/std/projects/${pid}/rows?review=true&pageSize=50`);
  const conflictRow = rows.body.rows.find((r) =>
    Object.values(r.normalized.fields).some((f) => f.confidence === "Conflict"));
  const field = conflictRow && Object.entries(conflictRow.normalized.fields)
    .find(([, f]) => f.confidence === "Conflict")[0];
  const decision = await req(`/api/std/projects/${pid}/decision`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rowNumber: conflictRow.row_number, field,
      decision: "Keep Original", notes: "clean-install check" }) });
  step(7, "Review and resolve a cross-brand conflict",
    !!conflictRow && decision.status === 200,
    `row ${conflictRow?.row_number} field ${field}`);

  // 8: export CSV and XLSX
  const csv = await req(`/api/std/projects/${pid}/export.csv?mode=audit`);
  const xlsxRes = await fetch(`${ROOT}/api/std/projects/${pid}/export.xlsx?mode=audit`);
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  step(8, "Export standardized CSV and XLSX",
    csv.status === 200 && String(csv.body).includes("Standard Make")
    && xlsxRes.status === 200 && xlsxBuf.length > 5000,
    `csv=${String(csv.body).length}B xlsx=${xlsxBuf.length}B `
    + `protection=${csv.headers.get("x-formula-injection-protection-applied")}`);

  // 9: change report
  const reportRes = await fetch(`${ROOT}/api/std/projects/${pid}/change-report.xlsx`);
  const reportBuf = Buffer.from(await reportRes.arrayBuffer());
  step(9, "Generate a change report", reportRes.status === 200 && reportBuf.length > 5000,
    `${reportBuf.length} bytes`);

  // 10: backup
  const backup = await req("/api/admin/backup", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{}" });
  step(10, "Create a database backup", backup.status === 200 && !!backup.body.path,
    String(backup.body.path ?? backup.body.error));
} catch (e) {
  step("error", "Unexpected failure", false, String(e));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 1500));
}

// 11 + 12: restart and confirm history survives
const server2 = spawn("npm.cmd", ["start"], {
  cwd: APP, env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"], shell: true,
});
let log2 = "";
server2.stdout.on("data", (d) => { log2 += d.toString(); });
try {
  let up = false;
  for (let i = 0; i < 90; i++) {
    try { await req("/api/summary"); up = true; break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  step(11, "Stop and restart the application", up,
    log2.split("\n").find((l) => l.includes("listening")) ?? "");
  const projects = await req("/api/std/projects");
  const hasHistory = Array.isArray(projects.body) && projects.body.length >= 2
    && projects.body.every((p) => p.row_count > 0);
  step(12, "Project history remains available after restart", hasHistory,
    `${projects.body.length} project(s)`);
} finally {
  server2.kill();
}

const report = {
  generatedAt: new Date().toISOString(),
  application: APP,
  steps,
  status: steps.every((s) => s.ok) ? "PASS" : "FAIL",
};
fs.writeFileSync(path.resolve("exports", "clean_install_steps.json"),
  JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
