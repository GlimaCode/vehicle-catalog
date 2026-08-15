import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../api";
import { Badge, DataTable, ErrorBox, Loading } from "../../ui";

export default function StdProjects() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    apiGet<Record<string, unknown>[]>("/api/std/projects").then(setRows).catch(setErr);
  }, []);
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Loading />;
  return (
    <div>
      <h2>Standardization projects ({rows.length})</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Upload an automotive CSV or Excel file, map its columns, standardize it against the
        frozen Version 4 canonical catalog, review anything uncertain, and export a corrected
        file. The canonical catalog is read-only here: project decisions never modify it.
      </p>
      <div className="btn-row">
        <Link className="btn" to="/std/upload">Upload a file</Link>
        <Link className="btn secondary" to="/std/templates">Mapping templates</Link>
        <a className="btn secondary" href="/api/std/lookup-workbook.xlsx">
          Canonical Vehicle Lookup.xlsx
        </a>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No projects yet. Upload a file to get started.</div>
      ) : (
        <DataTable columns={[
          { key: "project_name", label: "Project", sortable: false,
            render: (r) => <Link to={`/std/projects/${r.id}`}><strong>{String(r.project_name)}</strong></Link> },
          { key: "input_filename", label: "Input file", sortable: false },
          { key: "created_at", label: "Created", sortable: false },
          { key: "row_count", label: "Rows", sortable: false },
          { key: "status", label: "Status", sortable: false,
            render: (r) => <Badge value={String(r.status)} /> },
          { key: "review_count", label: "Review", sortable: false },
          { key: "changed_rows", label: "Changed rows", sortable: false },
          { key: "export_count", label: "Exports", sortable: false },
        ]} rows={rows} />
      )}
    </div>
  );
}
