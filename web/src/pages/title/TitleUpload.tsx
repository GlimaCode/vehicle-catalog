import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../../api";
import { ErrorBox } from "../../ui";

const TITLE_FIELDS = ["Title", "Year", "Year Range", "Make", "Model", "Sub-model",
  "Trim", "Material", "Color", "Variation", "Product Type", "Position", "Side",
  "Row", "Quantity", "Fitment", "Item ID", "SKU", "Other"];
const IGNORE = "Preserve as Custom Field";

interface UploadResult {
  projectId: number; filename: string; maxCharacters: number;
  preview: { format: string; headers: string[]; rows: string[][]; rowCount: number;
    columnCount: number };
}

/** Guesses a field from the column name; the user can always override it. */
function guessField(header: string): string {
  const h = header.trim().toLowerCase();
  const exact = TITLE_FIELDS.find((f) => f.toLowerCase() === h);
  if (exact) return exact;
  if (/^(product\s*)?title|listing\s*name|item\s*name/.test(h)) return "Title";
  if (/year\s*range|years/.test(h)) return "Year Range";
  if (/^year$/.test(h)) return "Year";
  if (/sub[-\s]?model/.test(h)) return "Sub-model";
  if (/product\s*type|category/.test(h)) return "Product Type";
  if (/item\s*(id|number)|listing\s*id/.test(h)) return "Item ID";
  if (/sku|part\s*number/.test(h)) return "SKU";
  if (/qty|quantity/.test(h)) return "Quantity";
  if (/colour|color/.test(h)) return "Color";
  return IGNORE;
}

export default function TitleUpload() {
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [templates, setTemplates] = useState<Record<string, unknown>[]>([]);
  const [templateId, setTemplateId] = useState<string>("");

  useEffect(() => {
    apiGet<{ templates: Record<string, unknown>[] }>("/api/title/templates")
      .then((d) => {
        setTemplates(d.templates);
        const def = d.templates.find((t) => Number(t.is_default) === 1);
        if (def) setTemplateId(String(def.id));
      }).catch(() => { /* templates are optional */ });
  }, []);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/title/upload", {
        method: "POST",
        headers: { "X-Filename": file.name, "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) throw new Error(await res.text());
      const data: UploadResult = await res.json();
      setResult(data);
      setFields(data.preview.headers.map(guessField));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const process = async () => {
    if (!result) return;
    setBusy(true); setErr(null);
    try {
      const columns = result.preview.headers.map((h, i) => ({
        column: h, index: i, field: fields[i] ?? IGNORE }));
      let res = await fetch(`/api/title/projects/${result.projectId}/mapping`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping: { headerRow: 1, columns } }) });
      if (!res.ok) throw new Error(await res.text());
      res = await fetch(`/api/title/projects/${result.projectId}/process`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: templateId ? Number(templateId) : null }) });
      if (!res.ok) throw new Error(await res.text());
      nav(`/title/projects/${result.projectId}/review`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const titleMapped = fields.includes("Title");

  return (
    <div>
      <div className="crumbs">Title Optimizer / Upload file</div>
      <h2>Upload a file for title optimization</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        CSV and XLSX are supported, including embedded line breaks and Unicode.
        Only the column you map as <strong>Title</strong> can be changed. Supporting
        columns are read to construct and validate the title; their stored values are
        never rewritten.
      </p>

      <div className="card" style={{ maxWidth: 900 }}>
        <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx" />
        <div className="btn-row">
          <button className="btn" onClick={upload} disabled={busy}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>

      {err ? <ErrorBox error={err} /> : null}

      {result ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>{result.filename}</h3>
          <p style={{ color: "var(--muted)" }}>
            {result.preview.rowCount.toLocaleString()} rows &middot;{" "}
            {result.preview.columnCount} columns &middot; limit{" "}
            {result.maxCharacters} characters
          </p>

          <label style={{ display: "block", margin: "12px 0" }}>
            Title template{" "}
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">(rule-based optimization only)</option>
              {templates.map((t) => (
                <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>
              ))}
            </select>
          </label>

          <table className="table">
            <thead>
              <tr><th>Source column</th><th>Sample value</th><th>Mapped field</th></tr>
            </thead>
            <tbody>
              {result.preview.headers.map((h, i) => (
                <tr key={h + i}>
                  <td><strong>{h}</strong></td>
                  <td style={{ color: "var(--muted)", maxWidth: 380, overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {result.preview.rows[0]?.[i] ?? ""}
                  </td>
                  <td>
                    <select value={fields[i] ?? IGNORE}
                      onChange={(e) => {
                        const next = [...fields];
                        next[i] = e.target.value;
                        setFields(next);
                      }}>
                      <option value={IGNORE}>{IGNORE}</option>
                      {TITLE_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!titleMapped ? (
            <p style={{ color: "var(--danger, #b00)" }}>
              Map exactly one column as <strong>Title</strong> to continue.
            </p>
          ) : null}

          <div className="btn-row">
            <button className="btn" onClick={process} disabled={busy || !titleMapped}>
              {busy ? "Optimizing…" : "Optimize titles"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
