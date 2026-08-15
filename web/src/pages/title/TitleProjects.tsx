import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../api";
import { Badge, DataTable, ErrorBox, Loading } from "../../ui";

export default function TitleProjects() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    apiGet<Record<string, unknown>[]>("/api/title/projects").then(setRows).catch(setErr);
  }, []);
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Loading />;
  return (
    <div>
      <h2>Title optimization projects ({rows.length})</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Optimize listing titles to a maximum length (80 Unicode characters by default)
        without losing fitment or product identity. Only the mapped Title value is ever
        changed &mdash; Item ID, SKU, Make, Model, Year, Material, Color, Variation and
        every other source column are returned exactly as supplied. The canonical catalog
        is read-only here.
      </p>
      <div className="btn-row">
        <Link className="btn" to="/title/upload">Upload a file</Link>
        <Link className="btn secondary" to="/title/templates">Title templates</Link>
        <Link className="btn secondary" to="/title/rules">Rules &amp; abbreviations</Link>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No title projects yet. Upload a file to get started.</div>
      ) : (
        <DataTable columns={[
          { key: "project_name", label: "Project", sortable: false,
            render: (r) => <Link to={`/title/projects/${r.id}/review`}>
              <strong>{String(r.project_name)}</strong></Link> },
          { key: "input_filename", label: "Input file", sortable: false },
          { key: "created_at", label: "Created", sortable: false },
          { key: "row_count", label: "Rows", sortable: false },
          { key: "max_characters", label: "Limit", sortable: false },
          { key: "status", label: "Status", sortable: false,
            render: (r) => <Badge value={String(r.status)} /> },
          { key: "review_count", label: "Needs review", sortable: false },
        ]} rows={rows} />
      )}
    </div>
  );
}
