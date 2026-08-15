import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, apiSend } from "../../api";
import { DataTable, ErrorBox, Loading } from "../../ui";

export default function StdTemplates() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const load = () => {
    apiGet<Record<string, unknown>[]>("/api/std/templates").then(setRows).catch(setErr);
  };
  useEffect(load, []);
  if (err) return <ErrorBox error={err} />;
  if (!rows) return <Loading />;
  return (
    <div>
      <div className="crumbs"><Link to="/std/projects">Standardization</Link> / Mapping templates</div>
      <h2>Mapping templates ({rows.length})</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Reusable column mappings, saved from the Map Columns page. Load a template when a
        recurring file layout arrives (for example <em>eBay Listing Export</em>,{" "}
        <em>Master Catalog</em>, <em>Competitor File</em>, <em>Make Model Source</em> or{" "}
        <em>Seat Cover Inventory</em>).
      </p>
      {rows.length === 0 ? (
        <div className="empty">
          No templates yet. Save one from the Map Columns step of any project.
        </div>
      ) : (
        <DataTable columns={[
          { key: "template_name", label: "Template", sortable: false },
          { key: "description", label: "Description", sortable: false },
          { key: "created_at", label: "Created", sortable: false },
          { key: "updated_at", label: "Updated", sortable: false },
          { key: "fields", label: "Mapped fields", sortable: false,
            render: (r) => {
              const m = JSON.parse(String(r.mapping_json)) as
                { columns: { field: string }[] };
              const fields = [...new Set(m.columns.map((c) => c.field))]
                .filter((f) => f !== "Ignore" && f !== "Preserve as Custom Field");
              return <span className="notes">{fields.join(", ")}</span>;
            } },
          { key: "actions", label: "Actions", sortable: false,
            render: (r) => (
              <span style={{ display: "flex", gap: 6 }}>
                <button className="secondary" style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={async () => {
                    await apiSend(`/api/std/templates/${r.id}/duplicate`, "POST");
                    load();
                  }}>Duplicate</button>
                <button className="secondary" style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={async () => {
                    if (!window.confirm(`Delete template "${String(r.template_name)}"?`)) return;
                    await fetch(`/api/std/templates/${r.id}`, { method: "DELETE" });
                    load();
                  }}>Delete</button>
              </span>
            ) },
        ]} rows={rows} />
      )}
    </div>
  );
}
