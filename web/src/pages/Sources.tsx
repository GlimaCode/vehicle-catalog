import React, { useEffect, useState } from "react";
import { apiGet } from "../api";
import { DataTable, ErrorBox, Loading } from "../ui";

interface SourcesData {
  sources: Record<string, unknown>[];
  importRuns: Record<string, unknown>[];
  coverage: Record<string, unknown>[];
  auditChanges: Record<string, unknown>[];
  meta: Record<string, string>;
}

export default function Sources() {
  const [data, setData] = useState<SourcesData | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { apiGet<SourcesData>("/api/sources").then(setData).catch(setErr); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  return (
    <div>
      <h2>Sources &amp; audit</h2>
      <div className="panel">
        <h3>Catalog metadata</h3>
        <dl className="kv">
          {Object.entries(data.meta).map(([k, v]) => (
            <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
          ))}
        </dl>
        <div className="btn-row">
          <a className="btn secondary" href="/api/export/csv/sources">Export sources (CSV)</a>
        </div>
      </div>
      <div className="panel">
        <h3>Source systems</h3>
        <DataTable hideable={false} columns={[
          { key: "source_name", label: "Source", sortable: false },
          { key: "source_url", label: "URL", sortable: false,
            render: (r) => <a href={String(r.source_url)} target="_blank" rel="noreferrer">{String(r.source_url)}</a> },
          { key: "source_type", label: "Type", sortable: false },
          { key: "evidence_type", label: "Evidence", sortable: false },
          { key: "access_date", label: "Access date", sortable: false },
          { key: "known_limitations", label: "Known limitations", sortable: false,
            render: (r) => <span className="notes">{String(r.known_limitations)}</span> },
        ]} rows={data.sources} />
      </div>
      <div className="panel">
        <h3>Year-by-year coverage report</h3>
        <DataTable hideable={false} columns={[
          { key: "model_year", label: "Year", sortable: false },
          { key: "verified_make_count", label: "Makes", sortable: false },
          { key: "verified_model_count", label: "Models", sortable: false },
          { key: "government_source_coverage", label: "Government coverage", sortable: false },
          { key: "discrepancy_count", label: "Single-source records", sortable: false },
          { key: "coverage_status", label: "Status", sortable: false },
        ]} rows={data.coverage} />
      </div>
      <div className="panel">
        <h3>Import log</h3>
        <DataTable hideable={false} columns={[
          { key: "import_timestamp", label: "Timestamp", sortable: false },
          { key: "input_filename", label: "File", sortable: false },
          { key: "input_file_hash", label: "SHA-256", sortable: false,
            render: (r) => <code style={{ fontSize: 11 }}>{String(r.input_file_hash).slice(0, 16)}…</code> },
          { key: "rows_read", label: "Read", sortable: false },
          { key: "rows_imported", label: "New", sortable: false },
          { key: "rows_updated", label: "Updated", sortable: false },
          { key: "rows_rejected", label: "Rejected", sortable: false },
          { key: "validation_status", label: "Status", sortable: false },
        ]} rows={data.importRuns} />
      </div>
      <div className="panel">
        <h3>Audited data changes</h3>
        {data.auditChanges.length === 0
          ? <p style={{ color: "var(--muted)" }}>No manual changes recorded yet.</p>
          : <DataTable hideable={false} columns={[
              { key: "changed_at", label: "When", sortable: false },
              { key: "action_type", label: "Action", sortable: false },
              { key: "entity_table", label: "Table", sortable: false },
              { key: "entity_id", label: "Record", sortable: false },
              { key: "reason", label: "Reason", sortable: false },
            ]} rows={data.auditChanges} />}
      </div>
    </div>
  );
}
