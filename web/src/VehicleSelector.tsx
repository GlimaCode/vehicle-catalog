/**
 * Reusable cascading Make -> Model -> Sub-model -> Year selector.
 * Only valid combinations are selectable; changing an upstream value clears
 * incompatible downstream selections. Review-required sub-model candidates
 * are hidden unless the caller-facing toggle is enabled.
 */
import React, { useEffect, useMemo, useState } from "react";
import { apiGet, qs } from "./api";
import { Badge } from "./ui";

interface MakeOpt { id: number; standard_make: string; lifecycle_status: string; validation_status: string; }
interface ModelOpt { id: number; standard_model: string; first_confirmed_model_year: number;
  last_confirmed_model_year: number; lifecycle_status: string; validation_status: string; }
interface SubOpt { id: number; standard_submodel: string; submodel_type: string;
  validation_status: string; source_table?: string; confirmed_model_years?: string; }

export interface VehicleSelection {
  make?: MakeOpt; model?: ModelOpt; submodel?: SubOpt; year?: number;
}

export default function VehicleSelector({ onChange }: { onChange?: (sel: VehicleSelection) => void }) {
  const [makes, setMakes] = useState<MakeOpt[]>([]);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [subs, setSubs] = useState<SubOpt[]>([]);
  const [years, setYears] = useState<number[]>([]);
  const [makeId, setMakeId] = useState<number | "">("");
  const [modelId, setModelId] = useState<number | "">("");
  const [subId, setSubId] = useState<number | "">("");
  const [year, setYear] = useState<number | "">("");
  const [makeFilter, setMakeFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [includeReview, setIncludeReview] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");

  useEffect(() => { apiGet<MakeOpt[]>("/api/selector/makes").then(setMakes); }, []);
  useEffect(() => {
    setModels([]); setSubs([]); setYears([]);
    setModelId(""); setSubId(""); setYear("");
    if (makeId) apiGet<ModelOpt[]>(`/api/selector/models${qs({ make: makeId })}`).then(setModels);
  }, [makeId]);
  useEffect(() => {
    setSubs([]); setYears([]); setSubId(""); setYear("");
    if (modelId) {
      apiGet<SubOpt[]>(`/api/selector/submodels${qs({ model: modelId, includeReview,
        types: typeFilter })}`).then(setSubs);
      apiGet<number[]>(`/api/selector/years${qs({ model: modelId })}`).then(setYears);
    }
  }, [modelId, includeReview, typeFilter]);
  useEffect(() => {
    if (modelId) {
      const sel = subs.find((s) => s.id === subId);
      apiGet<number[]>(`/api/selector/years${qs({ model: modelId,
        submodel: subId || undefined, table: sel?.source_table })}`)
        .then((ys) => { setYears(ys); if (year && !ys.includes(Number(year))) setYear(""); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subId]);

  useEffect(() => {
    onChange?.({
      make: makes.find((m) => m.id === makeId),
      model: models.find((m) => m.id === modelId),
      submodel: subs.find((s) => s.id === subId),
      year: year === "" ? undefined : Number(year),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [makeId, modelId, subId, year]);

  const filteredMakes = useMemo(() =>
    makes.filter((m) => m.standard_make.toLowerCase().includes(makeFilter.toLowerCase())),
    [makes, makeFilter]);
  const filteredModels = useMemo(() =>
    models.filter((m) => m.standard_model.toLowerCase().includes(modelFilter.toLowerCase())),
    [models, modelFilter]);
  const selModel = models.find((m) => m.id === modelId);

  return (
    <div>
      <div className="selector">
        <div>
          <label htmlFor="vs-make">1. Make</label>
          <input id="vs-make-search" placeholder="Type to filter makes…" value={makeFilter}
            onChange={(e) => setMakeFilter(e.target.value)} aria-label="Filter makes" />
          <select id="vs-make" size={8} value={makeId}
            onChange={(e) => setMakeId(e.target.value ? Number(e.target.value) : "")}
            aria-label="Select make" style={{ marginTop: 4 }}>
            {filteredMakes.map((m) => (
              <option key={m.id} value={m.id}>{m.standard_make}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="vs-model">2. Model</label>
          <input placeholder="Type to filter models…" value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)} aria-label="Filter models"
            disabled={!makeId} />
          <select id="vs-model" size={8} value={modelId} disabled={!makeId}
            onChange={(e) => setModelId(e.target.value ? Number(e.target.value) : "")}
            aria-label="Select model" style={{ marginTop: 4 }}>
            {filteredModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.standard_model} ({m.first_confirmed_model_year}-{m.last_confirmed_model_year})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="vs-sub">3. Sub-model (where available)</label>
          <select id="vs-sub" size={8} value={subId} disabled={!modelId}
            onChange={(e) => setSubId(e.target.value ? Number(e.target.value) : "")}
            aria-label="Select sub-model">
            <option value="">(none / base model)</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}
                title={`${s.submodel_type} · ${s.confirmed_model_years ?? ""} · ${s.validation_status}`}>
                {s.standard_submodel} [{s.submodel_type}
                {s.confirmed_model_years ? ` · ${s.confirmed_model_years}` : ""}
                {" · "}{s.validation_status}]
              </option>
            ))}
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Variant type filter" style={{ marginTop: 4 }}>
            <optgroup label="Hierarchy (default)">
              <option value="">Sub-model / Trim / Series / Edition (default)</option>
              <option value="Sub-model">Sub-models only</option>
              <option value="Trim">Trims only</option>
              <option value="Series">Series only</option>
              <option value="Edition">Editions only</option>
            </optgroup>
            <optgroup label="Advanced hierarchy filters">
              <option value="Generation">Generations</option>
              <option value="Chassis">Chassis identifiers</option>
            </optgroup>
            <optgroup label="Advanced configuration filters (not Sub-models)">
              <option value="Engine Variant">Engines</option>
              <option value="Drivetrain Variant">Drivetrains</option>
              <option value="Body Style">Body styles</option>
              <option value="Package">Packages</option>
              <option value="Commercial Configuration">Commercial configurations</option>
            </optgroup>
          </select>
          <label style={{ marginTop: 4 }}>
            <input type="checkbox" checked={includeReview}
              onChange={(e) => setIncludeReview(e.target.checked)} />{" "}
            Show review-required candidates
          </label>
        </div>
        <div>
          <label htmlFor="vs-year">4. Model year</label>
          <select id="vs-year" size={8} value={year} disabled={!modelId}
            onChange={(e) => setYear(e.target.value ? Number(e.target.value) : "")}
            aria-label="Select model year">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      {selModel && (
        <p style={{ marginTop: 10 }}>
          Selection validity: <Badge value={selModel.validation_status} />{" "}
          <Badge value={selModel.lifecycle_status} />
          {subId !== "" && subs.find((s) => s.id === subId)?.validation_status === "Review Required" && (
            <> <Badge value="Review Required"
              title="This sub-model candidate has not been verified against an authoritative source." /></>
          )}
        </p>
      )}
    </div>
  );
}
