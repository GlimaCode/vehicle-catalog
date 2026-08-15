import React, { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiSend } from "../../api";
import { ErrorBox, Loading } from "../../ui";

const FIELDS = ["Make", "Model", "Sub-model", "Trim", "Series", "Edition", "Generation",
  "Chassis", "Model Year", "Year Range", "Engine", "Drivetrain", "Body Style", "Package",
  "Title", "Item ID", "SKU", "Other"];
const SPECIAL = ["Ignore", "Preserve as Custom Field"];

interface Col { column: string; index: number; field: string; merge?: string }

/** Guess a canonical field from the source header name. */
function guess(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map: [string, string][] = [
    ["make", "Make"], ["brand", "Make"], ["manufacturer", "Make"],
    ["model", "Model"], ["submodel", "Sub-model"], ["trim", "Trim"],
    ["series", "Series"], ["edition", "Edition"], ["generation", "Generation"],
    ["chassis", "Chassis"], ["yearrange", "Year Range"], ["years", "Year Range"],
    ["year", "Model Year"], ["engine", "Engine"], ["drivetrain", "Drivetrain"],
    ["drive", "Drivetrain"], ["bodystyle", "Body Style"], ["body", "Body Style"],
    ["package", "Package"], ["title", "Title"], ["itemid", "Item ID"],
    ["sku", "SKU"], ["partnumber", "SKU"],
  ];
  for (const [needle, field] of map) if (h.includes(needle)) return field;
  return "Preserve as Custom Field";
}

export default function StdMap() {
  const { id } = useParams();
  const nav = useNavigate();
  const [preview, setPreview] = useState<{ headers: string[]; rows: string[][];
    rowCount: number } | null>(null);
  const [cols, setCols] = useState<Col[]>([]);
  const [headerRow, setHeaderRow] = useState(1);
  const [preserve, setPreserve] = useState(true);
  const [templates, setTemplates] = useState<Record<string, unknown>[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState("");

  const load = (hr: number) => {
    apiGet<{ preview: { headers: string[]; rows: string[][]; rowCount: number } }>(
      `/api/std/projects/${id}/preview?headerRow=${hr}`)
      .then((d) => {
        setPreview(d.preview);
        setCols(d.preview.headers.map((h, i) => ({ column: h, index: i, field: guess(h) })));
      }).catch(setErr);
  };
  useEffect(() => { load(headerRow); }, [id, headerRow]);
  useEffect(() => { apiGet<Record<string, unknown>[]>("/api/std/templates").then(setTemplates); }, []);

  const setField = (index: number, field: string) =>
    setCols((c) => c.map((x) => (x.index === index ? { ...x, field } : x)));
  const setMerge = (index: number, merge: string) =>
    setCols((c) => c.map((x) => (x.index === index ? { ...x, merge: merge || undefined } : x)));

  const dupFields = new Map<string, number>();
  for (const c of cols) {
    if (SPECIAL.includes(c.field)) continue;
    dupFields.set(c.field, (dupFields.get(c.field) ?? 0) + 1);
  }

  const save = async (thenProcess: boolean) => {
    setErr(null); setMsg("");
    try {
      await apiSend(`/api/std/projects/${id}/mapping`, "POST",
        { mapping: { headerRow, preserveUnmapped: preserve, columns: cols } });
      if (thenProcess) nav(`/std/projects/${id}/process`);
      else setMsg("Mapping saved.");
    } catch (e) { setErr(e); }
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) return;
    await apiSend("/api/std/templates", "POST", { templateName,
      mapping: { headerRow, preserveUnmapped: preserve, columns: cols } });
    setMsg(`Template "${templateName}" saved.`);
    apiGet<Record<string, unknown>[]>("/api/std/templates").then(setTemplates);
  };

  const loadTemplate = (tid: string) => {
    const t = templates.find((x) => String(x.id) === tid);
    if (!t) return;
    const m = JSON.parse(String(t.mapping_json)) as { columns: Col[]; headerRow: number;
      preserveUnmapped: boolean };
    setCols((current) => current.map((c) => {
      const hit = m.columns.find((x) => x.column === c.column)
        ?? m.columns.find((x) => x.index === c.index);
      return hit ? { ...c, field: hit.field, merge: hit.merge } : c;
    }));
    setPreserve(m.preserveUnmapped);
    setMsg(`Loaded mapping template "${String(t.template_name)}".`);
  };

  if (err) return <ErrorBox error={err} />;
  if (!preview) return <Loading />;

  return (
    <div>
      <div className="crumbs">
        <Link to="/std/projects">Standardization</Link> / Map columns
      </div>
      <h2>Map columns</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Choose a canonical field for each source column. Unmapped columns can be preserved
        untouched in the export. At least one column must be mapped to Make or Model.
      </p>
      {msg && <div className="panel" style={{ borderColor: "var(--green)" }}>{msg}</div>}
      <div className="panel">
        <div className="filters">
          <label>Header row:{" "}
            <input type="number" min={1} value={headerRow} style={{ width: 70 }}
              onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value)))} />
          </label>
          <label>
            <input type="checkbox" checked={preserve}
              onChange={(e) => setPreserve(e.target.checked)} />{" "}
            Preserve unmapped columns in the export
          </label>
          <select defaultValue="" onChange={(e) => loadTemplate(e.target.value)}
            aria-label="Load mapping template">
            <option value="">Load a saved mapping template…</option>
            {templates.map((t) => (
              <option key={String(t.id)} value={String(t.id)}>{String(t.template_name)}</option>
            ))}
          </select>
          <input placeholder="Save as template, e.g. eBay Listing Export"
            value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
          <button className="secondary" onClick={saveTemplate}>Save template</button>
        </div>
      </div>
      <div className="panel">
        <h3>Columns ({cols.length})</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="nosort">Source column</th>
                <th className="nosort">Sample values</th>
                <th className="nosort">Canonical field</th>
                <th className="nosort">Merge strategy</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const dup = !SPECIAL.includes(c.field) && (dupFields.get(c.field) ?? 0) > 1;
                return (
                  <tr key={c.index}>
                    <td><strong>{c.column}</strong></td>
                    <td className="notes">
                      {preview.rows.slice(0, 3).map((r) => r[c.index]).filter(Boolean).join(" · ")}
                    </td>
                    <td>
                      <select value={c.field} onChange={(e) => setField(c.index, e.target.value)}
                        aria-label={`Field for ${c.column}`}>
                        {SPECIAL.map((f) => <option key={f}>{f}</option>)}
                        <optgroup label="Vehicle">
                          {FIELDS.map((f) => <option key={f}>{f}</option>)}
                        </optgroup>
                      </select>
                      {dup && <div style={{ fontSize: 11, color: "var(--amber)" }}>
                        duplicate field — choose a merge strategy</div>}
                    </td>
                    <td>
                      {dup ? (
                        <select value={c.merge ?? ""} onChange={(e) => setMerge(c.index, e.target.value)}
                          aria-label={`Merge strategy for ${c.column}`}>
                          <option value="">(none)</option>
                          <option value="first-non-empty">First non-empty</option>
                          <option value="concat">Concatenate</option>
                          <option value="range">Combine into Year Range</option>
                        </select>
                      ) : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="btn-row">
          <button onClick={() => save(true)}>Save mapping and continue →</button>
          <button className="secondary" onClick={() => save(false)}>Save mapping</button>
        </div>
      </div>
    </div>
  );
}
