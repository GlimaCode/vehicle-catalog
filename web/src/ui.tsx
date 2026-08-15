import React, { useState } from "react";

const BADGE_CLASS: Record<string, string> = {
  "Fully Verified": "b-green",
  "Government Verified": "b-blue",
  "Manufacturer Verified": "b-purple",
  "Review Required": "b-amber",
  "Cross-Brand Conflict": "b-red",
  Active: "b-green",
  Discontinued: "b-gray",
  "Official Early/Future Model Year": "b-purple",
  Yes: "b-green",
  No: "b-gray",
  "Original Source": "b-green",
  "Existing Standardized Catalog": "b-blue",
  "Added - Missing Model": "b-purple",
  "Added - Missing Make and Model": "b-purple",
  Pending: "b-amber",
  Approved: "b-green",
  Rejected: "b-red",
  Corrected: "b-blue",
  "Needs More Evidence": "b-amber",
  Verified: "b-green",
  "Not Verified for US Market": "b-red",
};

export function Badge({ value, title }: { value?: string | null; title?: string }) {
  if (!value) return null;
  return (
    <span className={`badge ${BADGE_CLASS[value] ?? "b-gray"}`} title={title ?? value}>
      {value}
    </span>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}
export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error">Error: {String(error)}</div>;
}
export function Empty({ text = "No records match the current filters." }: { text?: string }) {
  return <div className="empty">{text}</div>;
}

export interface Col<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
}

export function DataTable<T extends Record<string, unknown>>({
  columns, rows, sort, dir, onSort, hideable = true,
}: {
  columns: Col<T>[]; rows: T[];
  sort?: string; dir?: "asc" | "desc";
  onSort?: (key: string) => void;
  hideable?: boolean;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = columns.filter((c) => !hidden.has(c.key));
  return (
    <div>
      {hideable && (
        <details style={{ margin: "6px 0", fontSize: 12.5 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)" }}>Columns</summary>
          {columns.map((c) => (
            <label key={c.key} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={!hidden.has(c.key)}
                onChange={() => {
                  const next = new Set(hidden);
                  next.has(c.key) ? next.delete(c.key) : next.add(c.key);
                  setHidden(next);
                }}
              />{" "}{c.label}
            </label>
          ))}
        </details>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {visible.map((c) => (
                <th
                  key={c.key}
                  className={c.sortable === false ? "nosort" : ""}
                  onClick={() => c.sortable !== false && onSort?.(c.key)}
                  aria-sort={sort === c.key ? (dir === "desc" ? "descending" : "ascending") : "none"}
                >
                  {c.label}{sort === c.key ? (dir === "desc" ? " ▼" : " ▲") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={(r.id as number) ?? i}>
                {visible.map((c) => (
                  <td key={c.key}>{c.render ? c.render(r) : String(r[c.key] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <Empty />}
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination">
      <button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</button>
      <span>Page {page} of {pages} · {total.toLocaleString()} records</span>
      <button className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  );
}

export function BarChart({ data }: { data: { k: string; n: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div>
      {data.map((d) => (
        <div className="bar-row" key={d.k}>
          <span className="lbl">{d.k}</span>
          <div className="bar" style={{ width: `${(d.n / max) * 320}px` }} />
          <span>{d.n.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export function YearChips({ years }: { years: { model_year: number; year_status: string }[] }) {
  return (
    <div className="year-chips">
      {years.map((y) => (
        <span key={y.model_year} className={y.year_status !== "Confirmed" ? "future" : ""}
          title={y.year_status}>
          {y.model_year}
        </span>
      ))}
    </div>
  );
}
