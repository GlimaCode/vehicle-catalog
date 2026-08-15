import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { Badge, Col, DataTable, ErrorBox, Loading } from "../ui";

interface Detail {
  make: Record<string, unknown>;
  models: Record<string, unknown>[];
  aliases: Record<string, unknown>[];
  submodelCount: number;
  warnings: Record<string, unknown>[];
}

export default function MakeDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Detail | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("standard_model");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  useEffect(() => { apiGet<Detail>(`/api/makes/${id}`).then(setData).catch(setErr); }, [id]);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  const mk = data.make;
  const models = data.models
    .filter((m) => String(m.standard_model).toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      const av = a[sort], bv = b[sort];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? cmp : -cmp;
    });
  const cols: Col<Record<string, unknown>>[] = [
    { key: "standard_model", label: "Model",
      render: (r) => <Link to={`/models/${r.id}`}>{String(r.standard_model)}</Link> },
    { key: "confirmed_model_years", label: "Confirmed years" },
    { key: "lifecycle_status", label: "Lifecycle", render: (r) => <Badge value={String(r.lifecycle_status)} /> },
    { key: "vehicle_category", label: "Category" },
    { key: "validation_status", label: "Validation", render: (r) => <Badge value={String(r.validation_status)} /> },
    { key: "submodel_count", label: "Variants" },
  ];
  return (
    <div>
      <div className="crumbs"><Link to="/makes">Makes</Link> / {String(mk.standard_make)}</div>
      <h2>{String(mk.official_display_name)} <Badge value={String(mk.lifecycle_status)} /></h2>
      <div className="panel">
        <dl className="kv">
          <dt>US market years</dt><dd>{String(mk.us_market_start_year)}–{mk.us_market_end_year ? String(mk.us_market_end_year) : "present"}</dd>
          <dt>Validation</dt><dd><Badge value={String(mk.validation_status)} /></dd>
          <dt>Present in original source</dt><dd><Badge value={String(mk.present_in_original_source)} /></dd>
          <dt>Catalog origin</dt><dd><Badge value={String(mk.catalog_origin)} /></dd>
          <dt>Models / active</dt><dd>{String(mk.model_count)} / {String(mk.active_model_count)}</dd>
          <dt>Sub-model candidates</dt><dd>{data.submodelCount}</dd>
          <dt>Primary source</dt>
          <dd><a href={String(mk.primary_source_url)} target="_blank" rel="noreferrer">{String(mk.primary_source_name)}</a></dd>
          {Boolean(mk.secondary_source_url) && (<><dt>Secondary source</dt>
            <dd><a href={String(mk.secondary_source_url)} target="_blank" rel="noreferrer">{String(mk.secondary_source_name)}</a></dd></>)}
          {Boolean(mk.notes) && (<><dt>Notes</dt><dd className="notes">{String(mk.notes)}</dd></>)}
        </dl>
      </div>
      {data.warnings.length > 0 && (
        <div className="panel">
          <h3>Validation warnings ({data.warnings.length} pending review items reference this make)</h3>
          <p><Link to={`/review?make=${encodeURIComponent(String(mk.standard_make))}`}>
            Open in Validation review →</Link></p>
        </div>
      )}
      <div className="panel">
        <h3>Models ({models.length})</h3>
        <div className="filters">
          <input placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <DataTable columns={cols} rows={models} sort={sort} dir={dir}
          onSort={(k) => { sort === k ? setDir(dir === "asc" ? "desc" : "asc") : (setSort(k), setDir("asc")); }} />
      </div>
      <div className="panel">
        <h3>Aliases resolving to this make ({data.aliases.length})</h3>
        <DataTable hideable={false} columns={[
          { key: "raw_or_alias_make", label: "Raw make", sortable: false },
          { key: "raw_or_alias_model", label: "Raw model", sortable: false },
          { key: "canonical_model", label: "Canonical model", sortable: false },
          { key: "alias_type", label: "Alias type", sortable: false,
            render: (r) => <Badge value={String(r.alias_type)} /> },
          { key: "confidence", label: "Confidence", sortable: false },
        ]} rows={data.aliases} />
      </div>
    </div>
  );
}
