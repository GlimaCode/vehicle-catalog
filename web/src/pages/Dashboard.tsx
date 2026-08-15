import React, { useEffect, useState } from "react";
import { apiGet } from "../api";
import { BarChart, ErrorBox, Loading } from "../ui";

interface Summary {
  meta: Record<string, string>;
  cards: Record<string, number>;
  modelsByDecade: { k: string; n: number }[];
  modelsByCategory: { k: string; n: number }[];
  makesByLifecycle: { k: string; n: number }[];
  validationDistribution: { k: string; n: number }[];
  lastImports: { import_timestamp: string; input_filename: string; rows_read: number;
    validation_status: string }[];
}

const CARDS: [string, string][] = [
  ["makes", "Makes"], ["models", "Models"],
  ["submodels", "Sub-models"], ["trims", "Trims"],
  ["series", "Series"], ["editions", "Editions"],
  ["generations", "Generations"], ["chassis", "Chassis values"],
  ["engineConfigurations", "Engine configurations"],
  ["drivetrainConfigurations", "Drivetrain configurations"],
  ["bodyStyles", "Body styles"], ["packages", "Packages"],
  ["commercialConfigurations", "Commercial configurations"],
  ["reviewRequired", "Review-required values"],
  ["modelYears", "Model-year records"], ["activeModels", "Active Models"],
  ["discontinuedModels", "Discontinued Models"], ["fullyVerified", "Fully Verified"],
  ["governmentVerified", "Government Verified"], ["manufacturerVerified", "Manufacturer Verified"],
  ["originalSource", "Original-source Models"],
  ["externallyAdded", "Externally added Models"], ["aliases", "Alias mappings"],
];

export default function Dashboard() {
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { apiGet<Summary>("/api/summary").then(setData).catch(setErr); }, []);
  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;
  return (
    <div>
      <h2>Dashboard</h2>
      <p style={{ color: "var(--muted)" }}>
        Catalog version: <strong>{data.meta.catalog_version}</strong> · Research cutoff:{" "}
        <strong>{data.meta.research_cutoff}</strong> · Last import:{" "}
        <strong>{data.meta.last_import}</strong>
      </p>
      <div className="cards">
        {CARDS.map(([key, label]) => (
          <div className="card" key={key}>
            <div className="num">{(data.cards[key] ?? 0).toLocaleString()}</div>
            <div className="label">{label}</div>
          </div>
        ))}
      </div>
      <div className="grid2">
        <div className="panel">
          <h3>Models by decade of first confirmed year</h3>
          <BarChart data={data.modelsByDecade} />
        </div>
        <div className="panel">
          <h3>Models by vehicle category</h3>
          <BarChart data={data.modelsByCategory} />
        </div>
        <div className="panel">
          <h3>Makes by lifecycle status</h3>
          <BarChart data={data.makesByLifecycle} />
        </div>
        <div className="panel">
          <h3>Validation-status distribution (models)</h3>
          <BarChart data={data.validationDistribution} />
        </div>
      </div>
      <div className="panel">
        <h3>Recent imports</h3>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th className="nosort">Timestamp</th><th className="nosort">File</th>
              <th className="nosort">Rows</th><th className="nosort">Status</th></tr></thead>
            <tbody>
              {data.lastImports.map((r, i) => (
                <tr key={i}><td>{r.import_timestamp}</td><td>{r.input_filename}</td>
                  <td>{r.rows_read}</td><td>{r.validation_status}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
