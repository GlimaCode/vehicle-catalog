import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../../api";
import { ErrorBox, Loading } from "../../ui";

interface Rule {
  id: number; rule_id: string; rule_name: string; stage: number;
  description: string; enabled: number; destructive: number;
}
interface Abbrev {
  full: string; abbreviated: string; applicableField: string;
  minimumCharactersSaved: number; ambiguityRisk: string; approvalStatus: string;
}

export default function TitleRules() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [abbrs, setAbbrs] = useState<Abbrev[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    apiGet<{ rules: Rule[] }>("/api/title/rules").then((d) => setRules(d.rules))
      .catch(setErr);
    apiGet<{ abbreviations: Abbrev[] }>("/api/title/abbreviations")
      .then((d) => setAbbrs(d.abbreviations)).catch(setErr);
  };
  useEffect(load, []);

  const toggle = async (rule: Rule) => {
    setBusy(true);
    try {
      await fetch(`/api/title/rules/${rule.rule_id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: Number(rule.enabled) === 0 }) });
      load();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  if (err) return <ErrorBox error={err} />;
  if (!rules || !abbrs) return <Loading />;

  const stages = [...new Set(rules.map((r) => r.stage))].sort();

  return (
    <div>
      <div className="crumbs">
        <Link to="/title/projects">Title Optimizer</Link> / Rules &amp; abbreviations
      </div>
      <h2>Title rules</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Rules run in stages. Stage 1 cleans without removing information; stage 5 is the
        only stage that removes a mapped field, and it records every removal. Nothing here
        modifies the canonical vehicle catalog.
      </p>

      {stages.map((s) => (
        <div key={s}>
          <h3>Stage {s}</h3>
          <table className="table">
            <thead>
              <tr><th>Rule</th><th>Description</th><th>Type</th><th>Enabled</th></tr>
            </thead>
            <tbody>
              {rules.filter((r) => r.stage === s).map((r) => (
                <tr key={r.rule_id}>
                  <td><strong>{r.rule_name}</strong>
                    <div style={{ fontSize: 12, color: "var(--muted)" }}>{r.rule_id}</div></td>
                  <td style={{ maxWidth: 520 }}>{r.description}</td>
                  <td>{Number(r.destructive) === 1 ? "Removes information" : "Safe"}</td>
                  <td>
                    <button className="btn small secondary" disabled={busy}
                      onClick={() => toggle(r)}>
                      {Number(r.enabled) === 1 ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <h2>Approved title abbreviations</h2>
      <p style={{ color: "var(--muted)", maxWidth: 900 }}>
        Abbreviations apply only when the title is over the limit, lowest ambiguity risk
        first, and only as many as needed. <strong>Leather and Genuine Leather are never
        abbreviated</strong> &mdash; the API rejects any attempt to add such a mapping.
        These are title-only forms; the Color and Material source columns keep their full
        values.
      </p>
      <table className="table">
        <thead>
          <tr><th>Full value</th><th>Abbreviated</th><th>Field</th>
            <th>Min. characters saved</th><th>Ambiguity risk</th><th>Approval</th></tr>
        </thead>
        <tbody>
          {abbrs.map((a) => (
            <tr key={`${a.full}|${a.applicableField}`}>
              <td>{a.full}</td><td><strong>{a.abbreviated}</strong></td>
              <td>{a.applicableField}</td><td>{a.minimumCharactersSaved}</td>
              <td>{a.ambiguityRisk}</td><td>{a.approvalStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
