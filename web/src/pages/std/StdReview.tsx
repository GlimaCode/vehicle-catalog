import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiSend, qs } from "../../api";
import { Badge, ErrorBox, Loading, Pagination } from "../../ui";

interface FieldState {
  raw: string; value: string | null; confidence: string; classification?: string;
  evidence?: string; conflict?: string; applied: boolean;
  alternatives?: { value: string; note?: string }[];
}
interface RowRec {
  row_number: number; review_required: number; excluded: number;
  conflict_reason: string | null;
  original: Record<string, string>;
  normalized: { fields: Record<string, FieldState>;
    year?: { raw: string; normalized: string; status: string; note: string };
    reviewReasons: string[] };
}

const DECISIONS = ["Accept Suggestion", "Keep Original", "Select Different Match",
  "Mark as Unknown", "Exclude From Export", "Apply to All Identical Values"];

export default function StdReview() {
  const { id } = useParams();
  const [data, setData] = useState<{ rows: RowRec[]; total: number; page: number;
    pageSize: number } | null>(null);
  const [page, setPage] = useState(1);
  const [onlyReview, setOnlyReview] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState("");

  const load = () => {
    apiGet<typeof data>(`/api/std/projects/${id}/rows${qs({ page,
      review: onlyReview ? "true" : "", pageSize: 25 })}`).then(setData).catch(setErr);
  };
  useEffect(load, [id, page, onlyReview]);

  const decide = async (row: RowRec, field: string, decision: string, f: FieldState) => {
    setBusy(`${row.row_number}-${field}`);
    try {
      if (decision === "Apply to All Identical Values") {
        const c = await apiGet<{ count: number }>(
          `/api/std/projects/${id}/identical-count${qs({ field, value: f.raw })}`);
        const target = f.value ?? window.prompt(
          `No suggestion available. Canonical value to apply to all "${f.raw}" values `
          + "(leave blank to mark unknown):") ?? null;
        if (!window.confirm(`Apply "${f.raw}" → "${target ?? "(unknown)"}" to ${c.count} row(s)?`)) {
          return;
        }
        await apiSend(`/api/std/projects/${id}/apply-all`, "POST", { field,
          rawValue: f.raw, canonicalValue: target, decision: "Apply to All Identical Values",
          make: row.normalized.fields.Make?.value ?? "",
          model: row.normalized.fields.Model?.value ?? "" });
      } else if (decision === "Select Different Match") {
        const choice = window.prompt("Canonical value to use:", f.value ?? "");
        if (choice == null) return;
        await apiSend(`/api/std/projects/${id}/decision`, "POST",
          { rowNumber: row.row_number, field, decision, value: choice });
      } else {
        await apiSend(`/api/std/projects/${id}/decision`, "POST",
          { rowNumber: row.row_number, field, decision });
      }
      load();
    } catch (e) { setErr(e); } finally { setBusy(""); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!data) return <Loading />;

  return (
    <div>
      <div className="crumbs">
        <Link to="/std/projects">Standardization</Link> /{" "}
        <Link to={`/std/projects/${id}`}>Project {id}</Link> / Review matches
      </div>
      <h2>Review matches ({data.total.toLocaleString()} rows)</h2>
      <p style={{ color: "var(--muted)", maxWidth: 920 }}>
        Every uncertain value is listed here with its evidence — nothing uncertain is ever
        applied silently. "Apply to All Identical Values" shows how many rows are affected
        before it runs, and stores the decision as a project mapping only.
      </p>
      <div className="filters">
        <label>
          <input type="checkbox" checked={onlyReview}
            onChange={(e) => { setOnlyReview(e.target.checked); setPage(1); }} />{" "}
          Show only rows requiring review
        </label>
        <a className="btn secondary" href={`/api/std/projects/${id}/review.xlsx`}>
          Download review workbook
        </a>
      </div>
      {data.rows.length === 0 && <div className="empty">Nothing left to review.</div>}
      {data.rows.map((row) => (
        <div className="panel" key={row.row_number}>
          <h3>Row {row.row_number}{" "}
            {row.excluded ? <Badge value="Excluded" /> :
              row.review_required ? <Badge value="Review Required" /> :
              <Badge value="Approved" />}</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="nosort">Field</th>
                  <th className="nosort">Original</th>
                  <th className="nosort">Suggested canonical</th>
                  <th className="nosort">Confidence</th>
                  <th className="nosort">Conflict / evidence</th>
                  <th className="nosort">Alternatives</th>
                  <th className="nosort">Decision</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(row.normalized.fields).map(([field, f]) => (
                  <tr key={field}>
                    <td><strong>{field}</strong>{f.classification ? ` (${f.classification})` : ""}</td>
                    <td>{f.raw}</td>
                    <td>{f.applied ? <strong>{f.value}</strong> : (f.value ?? "—")}</td>
                    <td><Badge value={f.confidence} /></td>
                    <td className="notes">{f.conflict ?? f.evidence ?? ""}</td>
                    <td className="notes">
                      {(f.alternatives ?? []).map((a) => a.value).join(" | ")}
                    </td>
                    <td>
                      {f.applied ? <span style={{ color: "var(--green)" }}>applied</span> : (
                        <select defaultValue="" disabled={busy === `${row.row_number}-${field}`}
                          onChange={(e) => { const d = e.target.value; e.target.value = "";
                            if (d) decide(row, field, d, f); }}
                          aria-label={`Decision for ${field} row ${row.row_number}`}>
                          <option value="">Choose…</option>
                          {DECISIONS.map((d) => <option key={d}>{d}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
                {row.normalized.year && (
                  <tr>
                    <td><strong>Model Year</strong></td>
                    <td>{row.normalized.year.raw}</td>
                    <td>{row.normalized.year.normalized}</td>
                    <td><Badge value={row.normalized.year.status} /></td>
                    <td className="notes" colSpan={3}>{row.normalized.year.note}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="btn-row">
            <button className="secondary"
              onClick={() => decide(row, "(row)", "Exclude From Export",
                { raw: "", value: null, confidence: "", applied: false })}>
              Exclude row from export
            </button>
          </div>
        </div>
      ))}
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total}
        onPage={setPage} />
    </div>
  );
}
