import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet, qs } from "../api";
import { Badge, Col, DataTable, ErrorBox, Loading } from "../ui";

interface MakeRow extends Record<string, unknown> {
  id: number; standard_make: string; official_display_name: string;
  us_market_start_year: number; us_market_end_year: number | null;
  lifecycle_status: string; model_count: number; active_model_count: number;
  validation_status: string; present_in_original_source: string; catalog_origin: string;
}

export default function Makes() {
  const [rows, setRows] = useState<MakeRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"table" | "cards">("table");
  const [sort, setSort] = useState("standard_make");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  useEffect(() => {
    const t = setTimeout(() =>
      apiGet<{ rows: MakeRow[] }>(`/api/makes${qs({ q })}`).then((r) => setRows(r.rows)).catch(setErr), 200);
    return () => clearTimeout(t);
  }, [q]);
  const sorted = useMemo(() => {
    if (!rows) return null;
    const s = [...rows].sort((a, b) => {
      const av = a[sort], bv = b[sort];
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      return dir === "asc" ? cmp : -cmp;
    });
    return s;
  }, [rows, sort, dir]);
  if (err) return <ErrorBox error={err} />;
  if (!sorted) return <Loading />;
  const columns: Col<MakeRow>[] = [
    { key: "standard_make", label: "Make",
      render: (r) => <Link to={`/makes/${r.id}`}><strong>{r.standard_make}</strong></Link> },
    { key: "us_market_start_year", label: "Start" },
    { key: "us_market_end_year", label: "End", render: (r) => r.us_market_end_year ?? "—" },
    { key: "lifecycle_status", label: "Lifecycle", render: (r) => <Badge value={r.lifecycle_status} /> },
    { key: "model_count", label: "Models" },
    { key: "active_model_count", label: "Active models" },
    { key: "validation_status", label: "Validation", render: (r) => <Badge value={r.validation_status} /> },
    { key: "present_in_original_source", label: "In source",
      render: (r) => <Badge value={r.present_in_original_source} /> },
    { key: "catalog_origin", label: "Origin", render: (r) => <Badge value={r.catalog_origin} /> },
  ];
  const groups = new Map<string, MakeRow[]>();
  for (const r of sorted) {
    const letter = r.standard_make[0].toUpperCase();
    groups.set(letter, [...(groups.get(letter) ?? []), r]);
  }
  return (
    <div>
      <h2>Makes ({sorted.length})</h2>
      <div className="filters">
        <input placeholder="Search makes…" value={q} onChange={(e) => setQ(e.target.value)}
          aria-label="Search makes" />
        <button className="secondary" onClick={() => setView(view === "table" ? "cards" : "table")}>
          {view === "table" ? "Card view" : "Table view"}
        </button>
        <a className="btn secondary" href="/api/export/csv/makes">Export CSV</a>
      </div>
      {view === "table" ? (
        <DataTable columns={columns} rows={sorted} sort={sort} dir={dir}
          onSort={(k) => { sort === k ? setDir(dir === "asc" ? "desc" : "asc") : (setSort(k), setDir("asc")); }} />
      ) : (
        [...groups.entries()].map(([letter, ms]) => (
          <div key={letter} className="panel">
            <h3>{letter}</h3>
            <div className="cards">
              {ms.map((r) => (
                <div className="card" key={r.id}>
                  <Link to={`/makes/${r.id}`}><strong>{r.standard_make}</strong></Link>
                  <div className="label">{r.us_market_start_year}–{r.us_market_end_year ?? "present"} ·{" "}
                    {r.model_count} models</div>
                  <div style={{ marginTop: 4 }}><Badge value={r.lifecycle_status} /></div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
