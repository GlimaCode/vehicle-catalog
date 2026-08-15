import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiSend } from "../../api";
import { Badge, ErrorBox, Loading } from "../../ui";

interface Progress { status: string; processed: number; total: number; running: boolean }

export default function StdProcess() {
  const { id } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const timer = useRef<number>();

  const refresh = () => {
    apiGet<{ project: Record<string, unknown>; stats: Record<string, unknown>;
      outcome: string }>(`/api/std/projects/${id}`)
      .then((d) => { setProject({ ...d.project, outcome: d.outcome }); setStats(d.stats); })
      .catch(setErr);
    apiGet<Progress>(`/api/std/projects/${id}/progress`).then(setProgress).catch(setErr);
  };
  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, 1200);
    return () => window.clearInterval(timer.current);
  }, [id]);

  const start = async (resume: boolean) => {
    setErr(null);
    try { await apiSend(`/api/std/projects/${id}/process`, "POST", { resume }); }
    catch (e) { setErr(e); }
  };
  const cancel = () => apiSend(`/api/std/projects/${id}/cancel`, "POST");
  const setAutoHigh = (v: boolean) =>
    apiSend(`/api/std/projects/${id}`, "PATCH", { autoApplyHigh: v }).then(refresh);

  if (err) return <ErrorBox error={err} />;
  if (!project || !progress) return <Loading />;
  const pct = progress.total ? Math.min(100, (progress.processed / progress.total) * 100) : 0;

  return (
    <div>
      <div className="crumbs">
        <Link to="/std/projects">Standardization</Link> /{" "}
        <Link to={`/std/projects/${id}`}>{String(project.project_name)}</Link> / Process
      </div>
      <h2>Process file <Badge value={String(project.status)} /></h2>
      <div className="panel">
        <h3>Normalization settings</h3>
        <p style={{ color: "var(--muted)", maxWidth: 900 }}>
          Exact canonical matches, approved alias matches and deterministic normalizations
          are applied automatically. Suggested matches always require your approval unless
          you enable the option below (disabled by default).
        </p>
        <label>
          <input type="checkbox"
            checked={Number(project.auto_apply_high_confidence) === 1}
            onChange={(e) => setAutoHigh(e.target.checked)} />{" "}
          Auto-apply <strong>High Confidence Suggested Match</strong> (off by default)
        </label>
        <div className="btn-row">
          <button disabled={progress.running} onClick={() => start(false)}>
            {progress.running ? "Processing…" : "Run standardization"}
          </button>
          <button className="secondary" disabled={!progress.running} onClick={cancel}>
            Cancel
          </button>
          <button className="secondary" disabled={progress.running}
            onClick={() => start(true)}>Resume from row {Number(project.processed_rows) + 1}</button>
        </div>
      </div>
      <div className="panel">
        <h3>Progress</h3>
        <div style={{ background: "#eef0f3", borderRadius: 6, height: 18, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, background: "var(--accent)", height: "100%" }} />
        </div>
        <p>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()} rows
          {" "}({pct.toFixed(1)}%) · status <Badge value={progress.status} /></p>
      </div>
      {stats && (
        <div className="panel">
          <h3>Result summary</h3>
          <dl className="kv">
            <dt>Rows processed</dt><dd>{String(stats.inputRows)}</dd>
            <dt>Rows requiring review</dt><dd>{String(stats.reviewRows)}</dd>
            <dt>Changed fields</dt><dd>{String(stats.changedFields)}</dd>
            <dt>Unmatched Makes / Models / hierarchy</dt>
            <dd>{String(stats.unmatchedMake)} / {String(stats.unmatchedModel)} / {String(stats.unmatchedHierarchy)}</dd>
            <dt>Year problems</dt><dd>{String(stats.invalidYear)}</dd>
            <dt>Standardization outcome</dt><dd><Badge value={String(project.outcome)} /></dd>
          </dl>
          <div className="btn-row">
            <button onClick={() => nav(`/std/projects/${id}/review`)}>Review matches →</button>
            <button className="secondary" onClick={() => nav(`/std/projects/${id}/export`)}>
              Export results
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
