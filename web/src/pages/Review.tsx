import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet, apiSend, qs } from "../api";
import { Badge, DataTable, ErrorBox, Loading, Pagination } from "../ui";

const STATUSES = ["Pending", "Approved", "Rejected", "Needs More Evidence", "Corrected"];

export default function Review() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{
    rows: Record<string, unknown>[]; total: number; page: number; pageSize: number;
    issueTypes: { k: string; n: number }[];
  } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const get = (k: string) => params.get(k) ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  useEffect(() => {
    apiGet<typeof data>(`/api/reviews?${params.toString()}`).then(setData).catch(setErr);
  }, [params, refresh]);
  const update = async (id: unknown, review_status: string) => {
    const reason = window.prompt(
      `Set status to "${review_status}". Reason (recorded in the audit log):`);
    if (reason === null) return;
    await apiSend(`/api/reviews/${id}`, "PATCH", { review_status, reason });
    setRefresh((x) => x + 1);
  };
  if (err) return <ErrorBox error={err} />;
  return (
    <div>
      <h2>Validation review {data ? `(${data.total.toLocaleString()} candidates)` : ""}</h2>
      <p style={{ color: "var(--muted)", maxWidth: 880 }}>
        Unresolved candidates and conflicts, kept separate from the canonical catalog. Approving an
        item here records the decision and reason but does <strong>not</strong> move it into the
        canonical catalog — promotion requires supporting evidence and a validated catalog
        re-import.
      </p>
      <div className="filters">
        <select value={get("issue")} onChange={(e) => set("issue", e.target.value)} aria-label="Issue type">
          <option value="">All issue types</option>
          {(data?.issueTypes ?? []).map((t) => <option key={t.k} value={t.k}>{t.k} ({t.n})</option>)}
        </select>
        <select value={get("status")} onChange={(e) => set("status", e.target.value)} aria-label="Review status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <input placeholder="Filter make/model…" value={get("q")} onChange={(e) => set("q", e.target.value)}
          aria-label="Filter candidates" />
        <input placeholder="Make (exact)…" value={get("make")} onChange={(e) => set("make", e.target.value)}
          aria-label="Filter make exact" />
        <a className="btn secondary" href="/api/export/csv/reviews">Export CSV</a>
      </div>
      {!data ? <Loading /> : (
        <>
          <DataTable columns={[
            { key: "candidate_make", label: "Make", sortable: false },
            { key: "candidate_model", label: "Candidate model", sortable: false,
              render: (r) => <strong>{String(r.candidate_model)}</strong> },
            { key: "candidate_model_years", label: "Years", sortable: false },
            { key: "issue_type", label: "Issue", sortable: false,
              render: (r) => <Badge value={String(r.issue_type)} /> },
            { key: "reason_not_approved", label: "Reason not approved", sortable: false,
              render: (r) => <span className="notes">{String(r.reason_not_approved)}</span> },
            { key: "recommended_next_action", label: "Recommended next action", sortable: false,
              render: (r) => <span className="notes">{String(r.recommended_next_action)}</span> },
            { key: "review_status", label: "Status", sortable: false,
              render: (r) => <Badge value={String(r.review_status)} /> },
            { key: "actions", label: "Set status (admin)", sortable: false,
              render: (r) => (
                <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {STATUSES.filter((s) => s !== r.review_status).map((s) => (
                    <button key={s} className="secondary" style={{ padding: "2px 7px", fontSize: 11 }}
                      onClick={() => update(r.id, s)}>{s}</button>
                  ))}
                </span>
              ) },
          ]} rows={data.rows} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total}
            onPage={(p) => set("page", String(p))} />
        </>
      )}
    </div>
  );
}
