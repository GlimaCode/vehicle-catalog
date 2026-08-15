import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, qs } from "../api";
import { Badge, DataTable, ErrorBox, Loading } from "../ui";

export default function Submodels() {
  const [group, setGroup] = useState("hierarchy");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ rows: Record<string, unknown>[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    const t = setTimeout(() =>
      apiGet<typeof data>(`/api/submodels${qs({ group, type, q })}`)
        .then(setData).catch(setErr), 200);
    return () => clearTimeout(t);
  }, [group, type, q]);
  if (err) return <ErrorBox error={err} />;
  return (
    <div>
      <h2>Sub-models &amp; classified variants</h2>
      <p style={{ color: "var(--muted)", maxWidth: 880 }}>
        <strong>Vehicle hierarchy</strong> (Sub-model, Trim, Series, Edition, Generation,
        Chassis) is kept separate from <strong>vehicle configuration</strong> (Engine,
        Drivetrain, Body Style, Package, Commercial Configuration). Every value traces to a
        government certification record with per-year evidence; unresolved candidates stay
        in the review queue and never enter approved selector data.
      </p>
      <div className="filters">
        <select value={group} onChange={(e) => { setGroup(e.target.value); setType(""); }}
          aria-label="Value group">
          <option value="hierarchy">Vehicle hierarchy</option>
          <option value="configuration">Vehicle configuration</option>
          <option value="all">Both groups</option>
          <option value="candidates">Review-required candidates</option>
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Classification type">
          <option value="">All types in group</option>
          {(group === "configuration"
            ? ["Engine Variant", "Drivetrain Variant", "Body Style", "Package",
               "Commercial Configuration"]
            : ["Sub-model", "Trim", "Series", "Edition", "Generation", "Chassis"])
            .map((t) => <option key={t}>{t}</option>)}
        </select>
        <input placeholder="Search sub-model…" value={q} onChange={(e) => setQ(e.target.value)}
          aria-label="Search sub-models" />
        <a className="btn secondary" href="/api/export/csv/submodels">Export CSV</a>
      </div>
      {!data ? <Loading /> : (
        <DataTable columns={[
          { key: "standard_make", label: "Make", sortable: false },
          { key: "standard_model", label: "Model", sortable: false,
            render: (r) => <Link to={`/models/${r.model_id}`}>{String(r.standard_model)}</Link> },
          { key: "standard_submodel", label: "Sub-model / variant", sortable: false,
            render: (r) => <strong>{String(r.standard_submodel)}</strong> },
          { key: "submodel_type", label: "Type", sortable: false,
            render: (r) => <Badge value={String(r.submodel_type)} /> },
          { key: "confirmed_model_years", label: "Confirmed years", sortable: false,
            render: (r) => String(r.confirmed_model_years ?? "—") },
          { key: "validation_status", label: "Validation", sortable: false,
            render: (r) => <Badge value={String(r.validation_status)} /> },
          { key: "source_name", label: "Source", sortable: false },
          { key: "notes", label: "Notes", sortable: false,
            render: (r) => <span className="notes">{String(r.notes ?? "")}</span> },
        ]} rows={data.rows} />
      )}
    </div>
  );
}
