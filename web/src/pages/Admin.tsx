import React, { useEffect, useState } from "react";
import { apiGet, apiSend } from "../api";
import { ErrorBox } from "../ui";

interface Backups { backups: { file: string; size: number; mtime: string }[]; dbPath: string; }

export default function Admin() {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const reload = () => apiGet<Backups>("/api/admin/backups").then(setBackups).catch(setErr);
  useEffect(() => { reload(); }, []);
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await fn();
      setLog((l) => [`${new Date().toLocaleTimeString()} ${label}: OK ${JSON.stringify(result).slice(0, 600)}`, ...l]);
    } catch (e) {
      setLog((l) => [`${new Date().toLocaleTimeString()} ${label}: FAILED ${String(e)}`, ...l]);
    } finally {
      setBusy(null);
      reload();
    }
  };
  if (err) return <ErrorBox error={err} />;
  return (
    <div>
      <h2>Admin</h2>
      <p style={{ color: "var(--muted)", maxWidth: 860 }}>
        Ordinary browsing is read-only. Actions here are recorded in the audit log. Canonical Make
        and Model records are never silently deleted: imports only add or update records inside a
        transaction, and every change records before/after values, a timestamp, an action type,
        and a reason.
      </p>
      <div className="panel">
        <h3>Catalog import</h3>
        <p>Re-imports the latest catalog CSV files from the working directory (prefers{" "}
          <code>*_v2.csv</code> names when present). The full run is transactional: if a mandatory
          validation fails, everything rolls back.</p>
        <button disabled={busy !== null} onClick={() =>
          window.confirm("Re-import catalog files now? The import is transactional and never deletes canonical records.")
          && run("Import catalog", () => apiSend("/api/admin/import", "POST"))}>
          {busy === "Import catalog" ? "Importing…" : "Import updated catalog files"}
        </button>
      </div>
      <div className="panel">
        <h3>Exports</h3>
        <div className="btn-row">
          <a className="btn" href="/api/export/excel">Download complete Excel workbook</a>
          <button className="secondary" disabled={busy !== null}
            onClick={() => run("Regenerate workbook on disk", () => apiSend("/api/export/excel/regenerate", "POST"))}>
            Regenerate workbook in exports/
          </button>
          <a className="btn secondary" href="/api/export/csv/makes">Makes CSV</a>
          <a className="btn secondary" href="/api/export/models.csv">Models CSV</a>
          <a className="btn secondary" href="/api/export/csv/submodels">Sub-models CSV</a>
          <a className="btn secondary" href="/api/export/csv/model-years">Model-year matrix CSV</a>
          <a className="btn secondary" href="/api/export/csv/aliases">Aliases CSV</a>
          <a className="btn secondary" href="/api/export/csv/reviews">Review-required CSV</a>
          <a className="btn secondary" href="/api/export/csv/sources">Sources CSV</a>
        </div>
      </div>
      <div className="panel">
        <h3>Database backups</h3>
        <p>Database: <code>{backups?.dbPath}</code></p>
        <button disabled={busy !== null}
          onClick={() => run("Create backup", () => apiSend("/api/admin/backup", "POST"))}>
          Create backup now
        </button>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data">
            <thead><tr><th className="nosort">Backup file</th><th className="nosort">Size</th>
              <th className="nosort">Created</th></tr></thead>
            <tbody>
              {(backups?.backups ?? []).map((b) => (
                <tr key={b.file}><td>{b.file}</td>
                  <td>{(b.size / 1024 / 1024).toFixed(1)} MB</td>
                  <td>{new Date(b.mtime).toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
          Restore from the command line: <code>npm run db:restore -- backups/&lt;file&gt;.db</code>{" "}
          (restoring replaces the live database, so it is deliberately not a one-click action).
        </p>
      </div>
      <div className="panel">
        <h3>Action log (this session)</h3>
        {log.length === 0 ? <p style={{ color: "var(--muted)" }}>No actions yet.</p>
          : <ul style={{ fontSize: 12.5 }}>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </div>
    </div>
  );
}
