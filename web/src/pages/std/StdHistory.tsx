import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiSend } from "../../api";
import { Badge, DataTable, ErrorBox, Loading } from "../../ui";

export default function StdHistory() {
  const { id } = useParams();
  const [data, setData] = useState<{ project: Record<string, unknown>;
    stats: Record<string, number>; outcome: string; exports: Record<string, unknown>[];
    mappings: Record<string, unknown>[] } | null>(null);
  const [changes, setChanges] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    apiGet<typeof data>(`/api/std/projects/${id}`).then(setData).catch(setErr);
    apiGet<{ changes: Record<string, unknown>[] }>(`/api/std/projects/${id}/report.json`)
      .then((r) => setChanges(r.changes.slice(0, 300))).catch(setErr);
  }, [id]);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const p = data.project;
  return (
    <div>
      <div className="crumbs">
        <Link to="/std/projects">Standardization</Link> / {String(p.project_name)}
      </div>
      <h2>{String(p.project_name)} <Badge value={String(p.status)} />{" "}
        <Badge value={data.outcome} /></h2>
      <div className="panel">
        <h3>Project</h3>
        <dl className="kv">
          <dt>Input file</dt><dd>{String(p.input_filename)}</dd>
          <dt>Format / worksheet</dt>
          <dd>{String(p.input_format).toUpperCase()} {p.worksheet_name ? `· ${String(p.worksheet_name)}` : ""}</dd>
          <dt>Encoding</dt><dd>{String(p.encoding)}</dd>
          <dt>SHA-256</dt><dd><code style={{ fontSize: 11 }}>{String(p.input_file_hash)}</code></dd>
          <dt>Rows / columns</dt><dd>{String(p.row_count)} / {String(p.column_count)}</dd>
          <dt>Created / updated</dt><dd>{String(p.created_at)} · {String(p.updated_at)}</dd>
          <dt>Standardization outcome</dt><dd><Badge value={data.outcome} /></dd>
        </dl>
        <div className="btn-row">
          <Link className="btn secondary" to={`/std/projects/${id}/map`}>Map columns</Link>
          <Link className="btn secondary" to={`/std/projects/${id}/process`}>Process</Link>
          <Link className="btn secondary" to={`/std/projects/${id}/review`}>Review</Link>
          <Link className="btn" to={`/std/projects/${id}/export`}>Export</Link>
        </div>
      </div>
      <div className="panel">
        <h3>Project value mappings ({data.mappings.length})</h3>
        <p style={{ color: "var(--muted)", fontSize: 12.5 }}>
          These decisions apply to this project only. They are never written to the
          canonical Version 4 catalog; an Admin may raise them as a catalog change proposal.
        </p>
        {data.mappings.length === 0 ? <p style={{ color: "var(--muted)" }}>None yet.</p>
          : <DataTable hideable={false} columns={[
              { key: "field_name", label: "Field", sortable: false },
              { key: "raw_value", label: "Raw value", sortable: false },
              { key: "canonical_value", label: "Canonical value", sortable: false },
              { key: "decision", label: "Decision", sortable: false },
              { key: "applied_row_count", label: "Rows", sortable: false },
            ]} rows={data.mappings} />}
      </div>
      <div className="panel">
        <h3>Audit log (first 300 changes)</h3>
        {!changes ? <Loading /> : changes.length === 0
          ? <p style={{ color: "var(--muted)" }}>No changes recorded.</p>
          : <DataTable hideable={false} columns={[
              { key: "row_number", label: "Row", sortable: false },
              { key: "field_name", label: "Field", sortable: false },
              { key: "original_value", label: "Original", sortable: false },
              { key: "new_value", label: "New", sortable: false },
              { key: "change_source", label: "Source", sortable: false },
              { key: "confidence", label: "Confidence", sortable: false },
              { key: "user_decision", label: "User decision", sortable: false },
            ]} rows={changes} />}
      </div>
      <div className="panel">
        <h3>Retention and deletion</h3>
        <p style={{ color: "var(--muted)", fontSize: 12.5, maxWidth: 880 }}>
          You are always shown exactly what will be removed before anything is deleted.
          Canonical Make, Model, hierarchy, configuration, alias and model-year records are
          never affected by project cleanup, and an audited deletion record is kept.
        </p>
        <div className="btn-row">
          {(["uploads", "exports", "rows", "project"] as const).map((scope) => (
            <button key={scope} className="secondary" onClick={async () => {
              const pv = await apiGet<{ uploadedFiles: { path: string; bytes: number }[];
                exportFiles: { path: string; bytes: number }[]; rows: number;
                changes: number; valueMappings: number; reviewDecisions: number;
                exportRecords: number; bytes: number; temporaryFiles: string[] }>(
                `/api/std/projects/${id}/deletion-preview?scope=${scope}`);
              const summary = [
                `Uploaded files: ${pv.uploadedFiles.length}`,
                `Export files: ${pv.exportFiles.length}`,
                `Temporary files: ${pv.temporaryFiles.length}`,
                `Database rows: ${pv.rows}`,
                `Change records: ${pv.changes}`,
                `Value mappings: ${pv.valueMappings}`,
                `Review decisions: ${pv.reviewDecisions}`,
                `Export records: ${pv.exportRecords}`,
                `Disk space freed: ${(pv.bytes / 1024).toFixed(1)} KB`,
                "Canonical catalog records affected: 0",
              ].join("\n");
              if (!window.confirm(`Delete scope "${scope}" will remove:\n\n${summary}\n\nProceed?`)) return;
              const reason = window.prompt("Reason (recorded in the deletion audit):") ?? "";
              await fetch(`/api/std/projects/${id}?scope=${scope}&reason=${encodeURIComponent(reason)}`,
                { method: "DELETE" });
              if (scope === "project") window.location.href = "/std/projects";
              else window.location.reload();
            }}>Delete {scope}</button>
          ))}
        </div>
      </div>
      <div className="panel">
        <h3>Exports</h3>
        {data.exports.length === 0 ? <p style={{ color: "var(--muted)" }}>None yet.</p>
          : <DataTable hideable={false} columns={[
              { key: "created_at", label: "When", sortable: false },
              { key: "export_type", label: "Type", sortable: false },
              { key: "mode", label: "Mode", sortable: false },
              { key: "filename", label: "File", sortable: false },
            ]} rows={data.exports} />}
      </div>
    </div>
  );
}
