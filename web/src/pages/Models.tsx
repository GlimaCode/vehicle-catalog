import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet, qs } from "../api";
import { Badge, Col, DataTable, ErrorBox, Loading, Pagination } from "../ui";

interface ModelRow extends Record<string, unknown> {
  id: number; make_id: number; standard_make: string; standard_model: string;
  confirmed_model_years: string; first_confirmed_model_year: number;
  last_confirmed_model_year: number; lifecycle_status: string; vehicle_category: string;
  validation_status: string; present_in_original_source: string; catalog_origin: string;
  submodel_count: number;
}
interface MakeOpt { id: number; standard_make: string; }

const SORT_KEYS: Record<string, string> = {
  standard_make: "make", standard_model: "model", first_confirmed_model_year: "first",
  last_confirmed_model_year: "last", vehicle_category: "category",
  lifecycle_status: "lifecycle", validation_status: "validation",
};

export default function Models() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ rows: ModelRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [makes, setMakes] = useState<MakeOpt[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const get = (k: string) => params.get(k) ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  useEffect(() => { apiGet<MakeOpt[]>("/api/selector/makes").then(setMakes); }, []);
  useEffect(() => {
    const t = setTimeout(() =>
      apiGet<typeof data>(`/api/models?${params.toString()}`).then(setData).catch(setErr), 200);
    return () => clearTimeout(t);
  }, [params]);
  if (err) return <ErrorBox error={err} />;
  const cols: Col<ModelRow>[] = [
    { key: "standard_make", label: "Make",
      render: (r) => <Link to={`/makes/${r.make_id}`}>{r.standard_make}</Link> },
    { key: "standard_model", label: "Model",
      render: (r) => <Link to={`/models/${r.id}`}><strong>{r.standard_model}</strong></Link> },
    { key: "confirmed_model_years", label: "Confirmed years", sortable: false },
    { key: "first_confirmed_model_year", label: "First" },
    { key: "last_confirmed_model_year", label: "Last" },
    { key: "lifecycle_status", label: "Lifecycle", render: (r) => <Badge value={r.lifecycle_status} /> },
    { key: "vehicle_category", label: "Category" },
    { key: "validation_status", label: "Validation", render: (r) => <Badge value={r.validation_status} /> },
    { key: "present_in_original_source", label: "In source",
      render: (r) => <Badge value={r.present_in_original_source} /> },
    { key: "catalog_origin", label: "Origin", render: (r) => <Badge value={r.catalog_origin} /> },
    { key: "submodel_count", label: "Variants", sortable: false },
  ];
  const sortParam = get("sort") || "make";
  const sortCol = Object.entries(SORT_KEYS).find(([, v]) => v === sortParam)?.[0];
  return (
    <div>
      <h2>Models {data ? `(${data.total.toLocaleString()})` : ""}</h2>
      <div className="filters">
        <input placeholder="Search model…" value={get("q")} onChange={(e) => set("q", e.target.value)}
          aria-label="Search models" />
        <select value={get("make")} onChange={(e) => set("make", e.target.value)} aria-label="Filter make">
          <option value="">All makes</option>
          {makes.map((m) => <option key={m.id} value={m.id}>{m.standard_make}</option>)}
        </select>
        <input type="number" placeholder="Model year" value={get("year")} style={{ width: 100 }}
          onChange={(e) => set("year", e.target.value)} aria-label="Filter model year" />
        <select value={get("category")} onChange={(e) => set("category", e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {["Passenger Car", "SUV/Crossover", "Pickup Truck", "Minivan", "Van",
            "Light Commercial Vehicle", "Multiple Categories"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={get("lifecycle")} onChange={(e) => set("lifecycle", e.target.value)} aria-label="Lifecycle">
          <option value="">All lifecycles</option>
          {["Active", "Discontinued", "Official Early/Future Model Year"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={get("validation")} onChange={(e) => set("validation", e.target.value)} aria-label="Validation">
          <option value="">All validation</option>
          {["Fully Verified", "Government Verified", "Manufacturer Verified"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <select value={get("original")} onChange={(e) => set("original", e.target.value)} aria-label="In source">
          <option value="">In source: any</option><option value="Yes">Yes</option><option value="No">No</option>
        </select>
        <select value={get("origin")} onChange={(e) => set("origin", e.target.value)} aria-label="Origin">
          <option value="">All origins</option>
          {["Original Source", "Existing Standardized Catalog", "Added - Missing Model",
            "Added - Missing Make and Model"].map((c) => <option key={c}>{c}</option>)}
        </select>
        <label><input type="checkbox" checked={get("hasSubmodels") === "true"}
          onChange={(e) => set("hasSubmodels", e.target.checked ? "true" : "")} /> Has variants</label>
        <label><input type="checkbox" checked={get("hasWarnings") === "true"}
          onChange={(e) => set("hasWarnings", e.target.checked ? "true" : "")} /> Has warnings</label>
      </div>
      <div className="btn-row">
        <a className="btn secondary" href={`/api/export/models.csv?${params.toString()}`}>
          Export current filtered result (CSV)
        </a>
        <a className="btn secondary" href="/api/export/excel">Complete Excel workbook</a>
      </div>
      {!data ? <Loading /> : (
        <>
          <DataTable columns={cols} rows={data.rows}
            sort={sortCol} dir={get("dir") === "desc" ? "desc" : "asc"}
            onSort={(k) => {
              const mapped = SORT_KEYS[k];
              if (!mapped) return;
              if (get("sort") === mapped) set("dir", get("dir") === "desc" ? "asc" : "desc");
              else { set("sort", mapped); }
            }} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total}
            onPage={(p) => set("page", String(p))} />
        </>
      )}
    </div>
  );
}
