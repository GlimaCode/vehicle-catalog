import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../api";
import { ErrorBox, Loading } from "../../ui";

interface Template {
  id: number; name: string; pattern: string; required_fields: string;
  optional_fields: string; field_priority: string; is_default: number;
  notes: string | null;
}

const FIELDS = ["Year Range", "Make", "Model", "Product Type", "Position", "Side",
  "Row", "Material", "Color", "Variation", "Quantity", "Trim", "Sub-model", "Other"];

export default function TitleTemplates() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState(
    "{Year Range} {Make} {Model} {Position} {Material} {Product Type} {Color}");
  const [required, setRequired] = useState<string[]>(["Year Range", "Make", "Model"]);

  const load = () => {
    apiGet<{ templates: Template[] }>("/api/title/templates")
      .then((d) => setTemplates(d.templates)).catch(setErr);
  };
  useEffect(load, []);

  const post = async (url: string, body: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(await res.text());
      load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!templates) return <Loading />;

  const preview = pattern.replace(/\{Year Range\}/g, "2006-2008")
    .replace(/\{Make\}/g, "Ford").replace(/\{Model\}/g, "F-150")
    .replace(/\{Position\}/g, "Bottom").replace(/\{Material\}/g, "Leather")
    .replace(/\{Product Type\}/g, "Seat Cover").replace(/\{Color\}/g, "Black")
    .replace(/\{[^}]+\}/g, "").replace(/\s+/g, " ").trim();

  return (
    <div>
      <div className="crumbs">
        <Link to="/title/projects">Title Optimizer</Link> / Templates
      </div>
      <h2>Title templates</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        A template defines the preferred field order, which fields are required, and which
        may be dropped when a title is too long. Templates are project-level configuration
        and never modify the canonical catalog.
      </p>

      <table className="table">
        <thead>
          <tr><th>Name</th><th>Pattern</th><th>Required</th><th>Default</th>
            <th>Actions</th></tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id}>
              <td><strong>{t.name}</strong>
                {t.notes ? <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  {t.notes}</div> : null}</td>
              <td style={{ maxWidth: 420, fontFamily: "monospace", fontSize: 12 }}>
                {t.pattern}</td>
              <td style={{ fontSize: 12 }}>
                {(JSON.parse(t.required_fields || "[]") as string[]).join(", ")}</td>
              <td>{Number(t.is_default) === 1 ? "Yes" : ""}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="btn small secondary" disabled={busy}
                  onClick={() => post(`/api/title/templates/${t.id}/duplicate`, {})}>
                  Duplicate</button>{" "}
                <button className="btn small secondary" disabled={busy}
                  onClick={() => post(`/api/title/templates/${t.id}/default`, {})}>
                  Make default</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Create a template</h3>
      <div className="card" style={{ maxWidth: 900 }}>
        <label style={{ display: "block", marginBottom: 8 }}>
          Name<br />
          <input value={name} onChange={(e) => setName(e.target.value)}
            style={{ width: "100%" }} />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          Pattern<br />
          <input value={pattern} onChange={(e) => setPattern(e.target.value)}
            style={{ width: "100%", fontFamily: "monospace" }} />
        </label>
        <div style={{ marginBottom: 8 }}>
          Required fields:{" "}
          {FIELDS.map((f) => (
            <label key={f} style={{ marginRight: 10, fontSize: 13 }}>
              <input type="checkbox" checked={required.includes(f)}
                onChange={(e) => setRequired(e.target.checked
                  ? [...required, f] : required.filter((x) => x !== f))} /> {f}
            </label>
          ))}
        </div>
        <p style={{ color: "var(--muted)" }}>
          Preview: <strong>{preview}</strong> ({Array.from(preview).length} characters)
        </p>
        <button className="btn" disabled={busy || !name}
          onClick={() => post("/api/title/templates", { name, pattern, required,
            optional: FIELDS.filter((f) => !required.includes(f)), priority: FIELDS })}>
          Create template
        </button>
      </div>
    </div>
  );
}
