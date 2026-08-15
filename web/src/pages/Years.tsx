import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, qs } from "../api";
import { Badge, DataTable, ErrorBox, Loading } from "../ui";

interface YearData {
  year: number;
  rows: Record<string, unknown>[];
  makes: { id: number; standard_make: string }[];
  coverage: Record<string, unknown> | null;
  submodels: Record<string, unknown>[];
}

export default function Years() {
  const { year } = useParams();
  const nav = useNavigate();
  const y = Number(year ?? 2026);
  const [data, setData] = useState<YearData | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [make, setMake] = useState("");
  const [category, setCategory] = useState("");
  useEffect(() => {
    setData(null);
    apiGet<YearData>(`/api/years/${y}${qs({ make, category })}`).then(setData).catch(setErr);
  }, [y, make, category]);
  if (err) return <ErrorBox error={err} />;
  const years = Array.from({ length: 2027 - 1980 + 1 }, (_, i) => 1980 + i);
  return (
    <div>
      <h2>Year browser</h2>
      <div className="filters">
        <label>Model year:{" "}
          <select value={y} onChange={(e) => nav(`/years/${e.target.value}`)} aria-label="Model year">
            {years.map((yy) => <option key={yy} value={yy}>{yy}</option>)}
          </select>
        </label>
        <select value={make} onChange={(e) => setMake(e.target.value)} aria-label="Filter make">
          <option value="">All makes</option>
          {(data?.makes ?? []).map((m) => <option key={m.id} value={m.id}>{m.standard_make}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter category">
          <option value="">All categories</option>
          {["Passenger Car", "SUV/Crossover", "Pickup Truck", "Minivan", "Van",
            "Light Commercial Vehicle", "Multiple Categories"].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      {!data ? <Loading /> : (
        <>
          {data.coverage && (
            <div className="panel">
              <h3>Source coverage for {y}</h3>
              <dl className="kv">
                <dt>Government source coverage</dt><dd>{String(data.coverage.government_source_coverage)}</dd>
                <dt>Coverage status</dt><dd>{String(data.coverage.coverage_status)}</dd>
                <dt>Single-source records this year</dt><dd>{String(data.coverage.discrepancy_count)}</dd>
                <dt>Coverage note</dt><dd className="notes">{String(data.coverage.notes)}</dd>
              </dl>
            </div>
          )}
          <div className="panel">
            <h3>{data.rows.length.toLocaleString()} models from{" "}
              {new Set(data.rows.map((r) => r.standard_make)).size} makes in {y}</h3>
            <DataTable columns={[
              { key: "standard_make", label: "Make", sortable: false,
                render: (r) => <Link to={`/makes/${r.make_id}`}>{String(r.standard_make)}</Link> },
              { key: "standard_model", label: "Model", sortable: false,
                render: (r) => <Link to={`/models/${r.model_id}`}>{String(r.standard_model)}</Link> },
              { key: "vehicle_category", label: "Category", sortable: false },
              { key: "lifecycle_status", label: "Lifecycle", sortable: false,
                render: (r) => <Badge value={String(r.lifecycle_status)} /> },
              { key: "validation_status", label: "Validation", sortable: false,
                render: (r) => <Badge value={String(r.validation_status)} /> },
              { key: "year_status", label: "Year status", sortable: false,
                render: (r) => <Badge value={String(r.year_status)} /> },
              { key: "confirmed_model_years", label: "Full range", sortable: false },
            ]} rows={data.rows} />
          </div>
          <div className="panel">
            <h3>Approved sub-models supported in {y}</h3>
            {data.submodels.length === 0
              ? <p style={{ color: "var(--muted)" }}>
                  None. Sub-model candidates exist only as review-required entries; no sub-model has
                  verified per-year evidence yet.</p>
              : <DataTable hideable={false} columns={[
                  { key: "standard_make", label: "Make", sortable: false },
                  { key: "standard_model", label: "Model", sortable: false },
                  { key: "standard_submodel", label: "Sub-model", sortable: false },
                  { key: "submodel_type", label: "Type", sortable: false },
                ]} rows={data.submodels} />}
          </div>
        </>
      )}
    </div>
  );
}
