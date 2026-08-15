import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet, qs } from "../api";
import { Badge, DataTable, ErrorBox, Loading } from "../ui";

export default function Aliases() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [data, setData] = useState<{ rows: Record<string, unknown>[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    const t = setTimeout(() =>
      apiGet<typeof data>(`/api/aliases${qs({ q })}`).then(setData).catch(setErr), 200);
    return () => clearTimeout(t);
  }, [q]);
  if (err) return <ErrorBox error={err} />;
  return (
    <div>
      <h2>Alias lookup</h2>
      <p style={{ color: "var(--muted)", maxWidth: 860 }}>
        Search raw or alternative values — <em>Mercedes Benz</em>, <em>ford</em>, <em>F150</em>,{" "}
        <em>X Type</em>, misspellings, model+trim combinations, multi-model compatibility groups —
        and get the canonical mapping. Matching is case-, space-, punctuation- and
        hyphen-insensitive. Use this page when standardizing future uploaded files.
      </p>
      <div className="filters">
        <input style={{ minWidth: 320 }} placeholder="Raw value, e.g. F150, Excrision, Ram PromasterCity…"
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="Alias search" autoFocus />
        <a className="btn secondary" href="/api/export/csv/aliases">Export all aliases (CSV)</a>
      </div>
      {!data ? <Loading /> : (
        <DataTable columns={[
          { key: "raw_or_alias_make", label: "Raw / alias make", sortable: false },
          { key: "raw_or_alias_model", label: "Raw / alias model", sortable: false,
            render: (r) => <strong>{String(r.raw_or_alias_model)}</strong> },
          { key: "canonical_make", label: "Canonical make", sortable: false },
          { key: "canonical_model", label: "Canonical model", sortable: false,
            render: (r) => r.canonical_model_id
              ? <Link to={`/models/${r.canonical_model_id}`}>{String(r.canonical_model ?? "")}</Link>
              : <span className="tooltip"
                  title="This alias maps to multiple canonical models or is unresolved; see notes.">
                  {String(r.canonical_model ?? "(multiple / unresolved)")}</span> },
          { key: "alias_type", label: "Alias type", sortable: false,
            render: (r) => <Badge value={String(r.alias_type)} /> },
          { key: "confidence", label: "Confidence", sortable: false },
          { key: "notes", label: "Notes", sortable: false,
            render: (r) => <span className="notes">{String(r.notes ?? "")}</span> },
        ]} rows={data.rows} />
      )}
    </div>
  );
}
