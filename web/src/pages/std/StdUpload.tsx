import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ErrorBox } from "../../ui";

interface UploadResult {
  projectId: number; filename: string; fileSize: number; hash: string;
  worksheets: { name: string; rowCount: number; columnCount: number }[];
  preview: { format: string; encoding: string; headers: string[]; rows: string[][];
    rowCount: number; columnCount: number; worksheetName?: string };
}

export default function StdUpload() {
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [projectName, setProjectName] = useState("");

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/std/upload", {
        method: "POST",
        headers: {
          "X-Filename": file.name,
          ...(projectName ? { "X-Project-Name": encodeURIComponent(projectName) } : {}),
          "Content-Type": "application/octet-stream",
        },
        body: file,     // streamed by the browser; never loaded into app memory
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const chooseSheet = async (name: string) => {
    if (!result) return;
    await fetch(`/api/std/projects/${result.projectId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worksheetName: name }) });
    const r = await fetch(`/api/std/projects/${result.projectId}/preview?worksheet=${encodeURIComponent(name)}`);
    const data = await r.json();
    setResult({ ...result, preview: data.preview });
  };

  return (
    <div>
      <div className="crumbs">Standardization / Upload file</div>
      <h2>Upload a file</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        CSV (RFC-4180, UTF-8, UTF-8 with BOM, or safely-detectable Windows-1252) and XLSX
        workbooks are supported, including quoted commas and embedded line breaks. The
        uploaded file is stored unchanged in an isolated import workspace.
      </p>
      {err ? <ErrorBox error={err} /> : null}
      <div className="panel">
        <div className="filters">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,text/csv" aria-label="Choose file" />
          <input placeholder="Project name (optional)" value={projectName}
            onChange={(e) => setProjectName(e.target.value)} aria-label="Project name" />
          <button disabled={busy} onClick={upload}>{busy ? "Uploading…" : "Upload"}</button>
        </div>
      </div>

      {result && (
        <>
          <div className="panel">
            <h3>File details</h3>
            <dl className="kv">
              <dt>Filename</dt><dd>{result.filename}</dd>
              <dt>File size</dt><dd>{(result.fileSize / 1024).toFixed(1)} KB</dd>
              <dt>Format</dt><dd>{result.preview.format.toUpperCase()}</dd>
              <dt>Detected encoding</dt><dd>{result.preview.encoding}</dd>
              <dt>Worksheet</dt><dd>{String(result.preview.worksheetName ?? "(CSV — not applicable)")}</dd>
              <dt>Row count</dt><dd>{result.preview.rowCount.toLocaleString()}</dd>
              <dt>Column count</dt><dd>{result.preview.columnCount}</dd>
              <dt>SHA-256</dt><dd><code style={{ fontSize: 11 }}>{result.hash}</code></dd>
            </dl>
            {result.worksheets.length > 1 && (
              <div className="filters">
                <label>Worksheet:{" "}
                  <select defaultValue={result.preview.worksheetName}
                    onChange={(e) => chooseSheet(e.target.value)} aria-label="Select worksheet">
                    {result.worksheets.map((w) => (
                      <option key={w.name} value={w.name}>
                        {w.name} ({w.rowCount} rows × {w.columnCount} cols)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
          <div className="panel">
            <h3>Header preview and first {result.preview.rows.length} data rows</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>{result.preview.headers.map((h) => <th key={h} className="nosort">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {result.preview.rows.map((r, i) => (
                    <tr key={i}>{result.preview.headers.map((_, j) =>
                      <td key={j}>{r[j] ?? ""}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="btn-row">
              <button onClick={() => nav(`/std/projects/${result.projectId}/map`)}>
                Continue to column mapping →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
