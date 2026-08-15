import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { Badge, DataTable, ErrorBox, Loading, YearChips } from "../ui";

interface Detail {
  model: Record<string, unknown>;
  years: { model_year: number; year_status: string; validation_status: string }[];
  aliases: Record<string, unknown>[];
  grouped: Record<string, unknown>[];
  hierarchy: Record<string, unknown>[];
  configurations: Record<string, unknown>[];
  submodels: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  history: Record<string, unknown>[];
  changes: Record<string, unknown>[];
}

export default function ModelDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { apiGet<Detail>(`/api/models/${id}`).then(setData).catch(setErr); }, [id]);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const m = data.model;
  const candidates = data.submodels;
  const valueTable = (rows: Record<string, unknown>[], label: string) => (
    <DataTable hideable={false} columns={[
      { key: "value", label, sortable: false,
        render: (r) => <strong>{String(r.value)}</strong> },
      { key: "confirmed_model_years", label: "Confirmed years", sortable: false },
      { key: "validation_status", label: "Validation", sortable: false,
        render: (r) => <Badge value={String(r.validation_status)} /> },
      { key: "raw_source_value", label: "Evidence (raw source value)", sortable: false,
        render: (r) => <span className="notes">{String(r.raw_source_value ?? "")}</span> },
    ]} rows={rows} />
  );
  const HIER_ORDER = ["Sub-model", "Trim", "Series", "Edition", "Generation", "Chassis"];
  const CONF_ORDER = ["Engine Variant", "Drivetrain Variant", "Body Style",
    "Package", "Commercial Configuration"];
  const SECTION_LABEL: Record<string, string> = {
    "Sub-model": "Sub-models", Trim: "Trims", Series: "Series", Edition: "Editions",
    Generation: "Generations", Chassis: "Chassis identifiers",
    "Engine Variant": "Engines", "Drivetrain Variant": "Drivetrains",
    "Body Style": "Body styles", Package: "Packages",
    "Commercial Configuration": "Commercial configurations",
  };
  return (
    <div>
      <div className="crumbs">
        <Link to="/models">Models</Link> / <Link to={`/makes/${m.make_id}`}>{String(m.standard_make)}</Link> /{" "}
        {String(m.standard_model)}
      </div>
      <h2>{String(m.standard_make)} {String(m.standard_model)}{" "}
        <Badge value={String(m.lifecycle_status)} /> <Badge value={String(m.validation_status)} /></h2>
      <div className="panel">
        <h3>Approved canonical record</h3>
        <dl className="kv">
          <dt>Confirmed model years</dt><dd><strong>{String(m.confirmed_model_years)}</strong>
            {String(m.confirmed_model_years).includes(";") &&
              <span className="tooltip" title="Semicolon-separated segments are separate production runs; the gap is real and preserved."> (non-contiguous)</span>}</dd>
          <dt>First / last confirmed year</dt>
          <dd>{String(m.first_confirmed_model_year)} / {String(m.last_confirmed_model_year)}</dd>
          <dt>Vehicle category</dt><dd>{String(m.vehicle_category)}</dd>
          <dt>Market</dt><dd>{String(m.market)}</dd>
          <dt>Present in original source</dt><dd><Badge value={String(m.present_in_original_source)} /></dd>
          <dt>Catalog origin</dt><dd><Badge value={String(m.catalog_origin)} /></dd>
          <dt>Primary source</dt>
          <dd><a href={String(m.primary_source_url)} target="_blank" rel="noreferrer">{String(m.primary_source_name)}</a></dd>
          {Boolean(m.secondary_source_url) && (<><dt>Secondary source</dt>
            <dd><a href={String(m.secondary_source_url)} target="_blank" rel="noreferrer">{String(m.secondary_source_name)}</a></dd></>)}
          <dt>Source access date</dt><dd>{String(m.source_access_date)}</dd>
          {Boolean(m.notes) && (<><dt>Notes</dt><dd className="notes">{String(m.notes)}</dd></>)}
        </dl>
      </div>
      <div className="panel">
        <h3>Individual supported model years ({data.years.length})</h3>
        <YearChips years={data.years} />
      </div>
      <div className="panel">
        <h3>Vehicle hierarchy</h3>
        {data.hierarchy.length === 0 && (
          <p style={{ color: "var(--muted)" }}>
            No approved Sub-model, Trim, Series, Edition, Generation, or Chassis
            values for this model. Candidates may exist in the review queue below.
          </p>
        )}
        {HIER_ORDER.map((t) => {
          const rows = data.hierarchy.filter((s) => s.classification_type === t);
          if (!rows.length) return null;
          return (
            <div key={t} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: "6px 0" }}>{SECTION_LABEL[t]} ({rows.length})</h4>
              {valueTable(rows, t)}
            </div>
          );
        })}
      </div>
      <div className="panel">
        <h3>Available configurations</h3>
        <p style={{ color: "var(--muted)", fontSize: 12.5 }}>
          Technical vehicle-configuration attributes from certification data.
          These are not Sub-models and never appear in the Sub-model selector.
        </p>
        {CONF_ORDER.map((t) => {
          const rows = data.configurations.filter((s) => s.classification_type === t);
          if (!rows.length) return null;
          return (
            <div key={t} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: "6px 0" }}>{SECTION_LABEL[t]} ({rows.length})</h4>
              {valueTable(rows, t)}
            </div>
          );
        })}
      </div>
      <div className="panel">
        <h3>Review-required variant candidates ({candidates.length})</h3>
        {candidates.length === 0
          ? <p style={{ color: "var(--muted)" }}>None recorded for this model.</p>
          : <DataTable hideable={false} columns={[
              { key: "standard_submodel", label: "Candidate value", sortable: false },
              { key: "submodel_type", label: "Classified as", sortable: false,
                render: (r) => <Badge value={String(r.submodel_type)} /> },
              { key: "validation_status", label: "Status", sortable: false,
                render: (r) => <Badge value={String(r.validation_status)} /> },
              { key: "notes", label: "Notes", sortable: false,
                render: (r) => <span className="notes">{String(r.notes)}</span> },
            ]} rows={candidates} />}
        <p style={{ fontSize: 12.5, color: "var(--muted)" }}>
          Trim, package, chassis and generation values are never approved as Sub-models automatically.
        </p>
      </div>
      <div className="panel">
        <h3>Aliases &amp; raw source values ({data.aliases.length})</h3>
        <DataTable hideable={false} columns={[
          { key: "raw_or_alias_make", label: "Raw make", sortable: false },
          { key: "raw_or_alias_model", label: "Raw value", sortable: false },
          { key: "alias_type", label: "Alias type", sortable: false,
            render: (r) => <Badge value={String(r.alias_type)} /> },
          { key: "confidence", label: "Confidence", sortable: false },
          { key: "notes", label: "Notes", sortable: false,
            render: (r) => <span className="notes">{String(r.notes)}</span> },
        ]} rows={data.aliases} />
      </div>
      {data.grouped.length > 0 && (
        <div className="panel">
          <h3>Grouped compatibility relationships ({data.grouped.length})</h3>
          <DataTable hideable={false} columns={[
            { key: "raw_make", label: "Raw make", sortable: false },
            { key: "raw_grouped_model_value", label: "Raw grouped value", sortable: false },
            { key: "relationship_status", label: "Status", sortable: false,
              render: (r) => <Badge value={String(r.relationship_status)} /> },
            { key: "evidence", label: "Evidence", sortable: false },
          ]} rows={data.grouped} />
        </div>
      )}
      {data.reviews.length > 0 && (
        <div className="panel">
          <h3>Pending review items mentioning this make ({data.reviews.length})</h3>
          <p><Link to={`/review?make=${encodeURIComponent(String(m.standard_make))}`}>Open in Validation review →</Link></p>
        </div>
      )}
      <div className="panel">
        <h3>Import &amp; change history</h3>
        <DataTable hideable={false} columns={[
          { key: "import_timestamp", label: "Imported at", sortable: false },
          { key: "input_filename", label: "File", sortable: false },
          { key: "validation_status", label: "Status", sortable: false },
        ]} rows={data.history} />
        {data.changes.length > 0 && (
          <>
            <h3 style={{ marginTop: 12 }}>Audited changes to this record</h3>
            <DataTable hideable={false} columns={[
              { key: "changed_at", label: "When", sortable: false },
              { key: "action_type", label: "Action", sortable: false },
              { key: "reason", label: "Reason", sortable: false },
            ]} rows={data.changes} />
          </>
        )}
      </div>
    </div>
  );
}
