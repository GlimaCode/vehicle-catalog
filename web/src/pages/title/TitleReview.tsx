import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../../api";
import { Badge, ErrorBox, Loading } from "../../ui";

/** Unicode-code-point length, matching the server's counting rule exactly. */
const len = (s: string) => Array.from(s ?? "").length;

interface Row {
  id: number; row_number: number; original_title: string; original_length: number;
  proposed_title: string; proposed_length: number; final_title: string | null;
  final_length: number | null; characters_removed: number; applied_rules: string;
  removed_information: string; preserved_information: string;
  validation_warnings: string; title_status: string; user_decision: string | null;
  notes: string | null; excluded: number; source_json: string;
}

const STATUSES = ["Already Within Limit", "Optimized", "Optimized with Warning",
  "Manual Review Required", "Unable to Reach Limit", "Excluded"];

/** Live counter with an explicit state, including "exactly at limit". */
function Counter({ value, max }: { value: string; max: number }) {
  const n = len(value);
  const remaining = max - n;
  const state = n > max ? "Over limit" : n === max ? "Exactly at limit" : "Within limit";
  const color = n > max ? "#b00020" : n === max ? "#8a6d00" : "#1b7f3b";
  return (
    <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
      {n} / {max} &middot; {remaining >= 0 ? `${remaining} remaining`
        : `${-remaining} over`} &middot; {state}
    </span>
  );
}

export default function TitleReview() {
  const { id } = useParams();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [project, setProject] = useState<Record<string, any> | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<{ status?: string; overLimit?: boolean;
    manualReview?: boolean; make?: string; model?: string }>({});
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Record<string, unknown>[]>([]);

  const max = Number(project?.max_characters ?? 80);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ page: String(page), pageSize: "25" });
    if (filter.status) q.set("status", filter.status);
    if (filter.overLimit) q.set("overLimit", "true");
    if (filter.manualReview) q.set("manualReview", "true");
    if (filter.make) q.set("make", filter.make);
    if (filter.model) q.set("model", filter.model);
    try {
      const [d, p] = await Promise.all([
        apiGet<{ rows: Row[]; total: number }>(`/api/title/projects/${id}/rows?${q}`),
        apiGet<{ project: Record<string, any>; stats: Record<string, number> }>(
          `/api/title/projects/${id}`),
      ]);
      setRows(d.rows);
      setTotal(d.total);
      setProject(p.project);
      setStats(p.stats);
    } catch (e) { setErr(e); }
  }, [id, page, filter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiGet<{ templates: Record<string, unknown>[] }>("/api/title/templates")
      .then((d) => setTemplates(d.templates)).catch(() => { /* optional */ });
  }, []);

  const decide = async (rowNumber: number, decision: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/title/projects/${id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber, decision, ...extra }) });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const bulk = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/title/projects/${id}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!rows || !project) return <Loading />;

  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <div>
      <div className="crumbs">
        <Link to="/title/projects">Title Optimizer</Link> / {String(project.project_name)}
      </div>
      <h2>Title review</h2>

      {stats ? (
        <div className="cards">
          <div className="card"><h4>Rows</h4><div className="big">{stats.inputRows}</div></div>
          <div className="card"><h4>Within limit</h4>
            <div className="big">{stats.withinLimit}</div></div>
          <div className="card"><h4>Optimized</h4>
            <div className="big">{stats.optimized}</div></div>
          <div className="card"><h4>Manual review</h4>
            <div className="big">{stats.manualReview}</div></div>
          <div className="card"><h4>Unable to reach limit</h4>
            <div className="big">{stats.unableToReach}</div></div>
          <div className="card"><h4>Characters removed</h4>
            <div className="big">{stats.totalCharactersRemoved}</div></div>
        </div>
      ) : null}

      <div className="btn-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn" disabled={busy}
          onClick={() => bulk("approve-within-limit")}>Approve all within limit</button>
        <button className="btn secondary"
          onClick={() => { setFilter({ overLimit: true }); setPage(1); }}>
          Only over limit</button>
        <button className="btn secondary"
          onClick={() => { setFilter({ manualReview: true }); setPage(1); }}>
          Only manual review</button>
        <button className="btn secondary"
          onClick={() => { setFilter({}); setPage(1); }}>Clear filters</button>
        <select value={filter.status ?? ""}
          onChange={(e) => { setFilter({ status: e.target.value || undefined }); setPage(1); }}>
          <option value="">Filter by status…</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input placeholder="Filter by Make" defaultValue={filter.make ?? ""}
          onBlur={(e) => { setFilter({ ...filter, make: e.target.value || undefined }); setPage(1); }} />
        <input placeholder="Filter by Model" defaultValue={filter.model ?? ""}
          onBlur={(e) => { setFilter({ ...filter, model: e.target.value || undefined }); setPage(1); }} />
      </div>

      <div className="btn-row">
        <a className="btn secondary" href={`/api/title/projects/${id}/export.csv?mode=audit`}>
          Export audit CSV</a>
        <a className="btn secondary" href={`/api/title/projects/${id}/export.xlsx?mode=audit`}>
          Export audit XLSX</a>
        <a className="btn secondary"
          href={`/api/title/projects/${id}/export.csv?mode=replacement`}>
          Export replacement CSV</a>
        <a className="btn secondary" href={`/api/title/projects/${id}/report.xlsx`}>
          Title optimization report</a>
      </div>

      <p style={{ color: "var(--muted)" }}>
        Showing {rows.length} of {total.toLocaleString()} rows &middot; page {page} of {pages}
      </p>

      <table className="table">
        <thead>
          <tr>
            <th>Row</th><th>Title</th><th>Counts</th><th>Rules &amp; information</th>
            <th>Status</th><th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const current = edits[r.row_number] ?? String(r.final_title ?? r.proposed_title);
            const warnings = JSON.parse(r.validation_warnings || "[]") as string[];
            const removed = JSON.parse(r.removed_information || "[]") as string[];
            const preserved = JSON.parse(r.preserved_information || "[]") as string[];
            const applied = JSON.parse(r.applied_rules || "[]") as string[];
            return (
              <tr key={r.id}>
                <td>{r.row_number}</td>
                <td style={{ maxWidth: 460 }}>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>Original</div>
                  <div style={{ marginBottom: 6 }}>{r.original_title}</div>
                  <div style={{ color: "var(--muted)", fontSize: 12 }}>Proposed</div>
                  <textarea value={current} rows={3} style={{ width: "100%" }}
                    onChange={(e) => setEdits({ ...edits, [r.row_number]: e.target.value })} />
                  <Counter value={current} max={max} />
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <div>Original: {r.original_length}</div>
                  <div>Proposed: {r.final_length ?? r.proposed_length}</div>
                  <div>Removed: {r.characters_removed}</div>
                </td>
                <td style={{ maxWidth: 300, fontSize: 12 }}>
                  {applied.length ? <div>Rules: {applied.join(", ")}</div> : null}
                  {removed.length ? <div>Removed: {removed.join("; ")}</div> : null}
                  {preserved.length ? <div>Preserved: {preserved.join("; ")}</div> : null}
                  {warnings.map((w, i) => (
                    <div key={i} style={{ color: "#b00020" }}>{w}</div>
                  ))}
                </td>
                <td><Badge value={r.title_status} />
                  {r.user_decision ? <div style={{ fontSize: 12,
                    color: "var(--muted)" }}>{r.user_decision}</div> : null}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn small" disabled={busy}
                    onClick={() => decide(r.row_number, "Accept Proposed Title")}>
                    Accept</button>{" "}
                  <button className="btn small secondary" disabled={busy}
                    onClick={() => decide(r.row_number, "Keep Original Title")}>
                    Keep original</button>{" "}
                  <button className="btn small secondary" disabled={busy}
                    onClick={() => decide(r.row_number, "Edit Proposed Title",
                      { editedTitle: current })}>
                    Save edit</button>{" "}
                  <button className="btn small secondary" disabled={busy}
                    onClick={() => decide(r.row_number, "Exclude From Export")}>
                    Exclude</button>{" "}
                  <button className="btn small secondary" disabled={busy}
                    onClick={() => bulk("apply-to-similar", { rowNumber: r.row_number })}>
                    Apply to similar</button>
                  {templates.length ? (
                    <select defaultValue="" disabled={busy}
                      onChange={(e) => e.target.value && decide(r.row_number,
                        "Regenerate Using Different Template",
                        { templateId: Number(e.target.value) })}>
                      <option value="">Regenerate…</option>
                      {templates.map((t) => (
                        <option key={String(t.id)} value={String(t.id)}>
                          {String(t.name)}</option>
                      ))}
                    </select>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="btn-row">
        <button className="btn secondary" disabled={page <= 1}
          onClick={() => setPage(page - 1)}>Previous</button>
        <button className="btn secondary" disabled={page >= pages}
          onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
