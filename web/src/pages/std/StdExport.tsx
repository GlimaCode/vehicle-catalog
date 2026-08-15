import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiSend } from "../../api";
import { Badge, DataTable, ErrorBox, Loading } from "../../ui";

export default function StdExport() {
  const { id } = useParams();
  const [data, setData] = useState<{ project: Record<string, unknown>;
    stats: Record<string, number>; outcome: string;
    exports: Record<string, unknown>[] } | null>(null);
  const [mode, setMode] = useState<"audit" | "replacement">("audit");
  const [sort, setSort] = useState<"source" | "make-model">("source");
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState("");

  const load = () => { apiGet<typeof data>(`/api/std/projects/${id}`).then(setData).catch(setErr); };
  useEffect(load, [id]);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const q = `?mode=${mode}&sort=${sort}`;

  return (
    <div>
      <div className="crumbs">
        <Link to="/std/projects">Standardization</Link> /{" "}
        <Link to={`/std/projects/${id}`}>{String(data.project.project_name)}</Link> / Export
      </div>
      <h2>Export results <Badge value={data.outcome} /></h2>
      {data.stats.reviewRows > 0 && (
        <div className="error">
          {data.stats.reviewRows} row(s) still require review. The file can be exported, but
          it is reported as <strong>{data.outcome}</strong>, not "Standardized", until every
          conflict is resolved.
        </div>
      )}
      <div className="panel">
        <h3>Export options</h3>
        <div className="filters">
          <label>Mode:{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as "audit" | "replacement")}>
              <option value="audit">Audit mode — keep original columns and add standardized ones (default)</option>
              <option value="replacement">Replacement mode — replace mapped source fields with approved values</option>
            </select>
          </label>
          <label>Row order:{" "}
            <select value={sort} onChange={(e) => setSort(e.target.value as "source" | "make-model")}>
              <option value="source">Preserve source row order (default)</option>
              <option value="make-model">Sort by Make then Model</option>
            </select>
          </label>
        </div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, maxWidth: 900 }}>
          Replacement mode only substitutes values that were applied automatically or that
          you approved. Title, Item ID, SKU and custom columns are never altered unless they
          are mapped and authorized.
        </p>
        <div className="btn-row">
          <a className="btn" href={`/api/std/projects/${id}/export.csv${q}`}>Standardized CSV</a>
          <a className="btn" href={`/api/std/projects/${id}/export.xlsx${q}`}>Standardized XLSX</a>
          <a className="btn secondary" href={`/api/std/projects/${id}/change-report.xlsx`}>
            Change report XLSX
          </a>
          <a className="btn secondary" href={`/api/std/projects/${id}/review.xlsx`}>Review-only XLSX</a>
          <a className="btn secondary" href={`/api/std/projects/${id}/value-mappings.csv`}>
            Value mappings CSV
          </a>
          <a className="btn secondary" href={`/api/std/projects/${id}/report.json`}>JSON report</a>
          <button className="secondary" onClick={async () => {
            const r = await apiSend<{ directory: string; outcome: string }>(
              `/api/std/projects/${id}/export-all`, "POST", { mode });
            setMsg(`All outputs written to ${r.directory} (outcome: ${r.outcome}).`);
            load();
          }}>Write all outputs to disk</button>
        </div>
        {msg && <p style={{ color: "var(--green)" }}>{msg}</p>}
      </div>
      <div className="panel">
        <h3>Summary</h3>
        <dl className="kv">
          <dt>Input rows</dt><dd>{data.stats.inputRows}</dd>
          <dt>Exported rows</dt><dd>{data.stats.exportRows}</dd>
          <dt>Excluded rows</dt><dd>{data.stats.excluded}</dd>
          <dt>Rows requiring review</dt><dd>{data.stats.reviewRows}</dd>
          <dt>Total changed fields</dt><dd>{data.stats.changedFields}</dd>
        </dl>
      </div>
      <div className="panel">
        <h3>Export history</h3>
        {data.exports.length === 0 ? <p style={{ color: "var(--muted)" }}>No exports yet.</p>
          : <DataTable hideable={false} columns={[
              { key: "created_at", label: "When", sortable: false },
              { key: "export_type", label: "Type", sortable: false },
              { key: "mode", label: "Mode", sortable: false },
              { key: "filename", label: "File", sortable: false },
              { key: "row_count", label: "Rows", sortable: false },
            ]} rows={data.exports} />}
      </div>
    </div>
  );
}
