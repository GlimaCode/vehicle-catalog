import React, { useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { apiGet, qs } from "./api";
import Dashboard from "./pages/Dashboard";
import Makes from "./pages/Makes";
import MakeDetail from "./pages/MakeDetail";
import Models from "./pages/Models";
import ModelDetail from "./pages/ModelDetail";
import Years from "./pages/Years";
import Submodels from "./pages/Submodels";
import Aliases from "./pages/Aliases";
import Review from "./pages/Review";
import Sources from "./pages/Sources";
import Admin from "./pages/Admin";
import SelectorPage from "./pages/SelectorPage";
import StdProjects from "./pages/std/StdProjects";
import StdUpload from "./pages/std/StdUpload";
import StdMap from "./pages/std/StdMap";
import StdProcess from "./pages/std/StdProcess";
import StdReview from "./pages/std/StdReview";
import StdExport from "./pages/std/StdExport";
import StdTemplates from "./pages/std/StdTemplates";
import StdHistory from "./pages/std/StdHistory";
import TitleProjects from "./pages/title/TitleProjects";
import TitleUpload from "./pages/title/TitleUpload";
import TitleReview from "./pages/title/TitleReview";
import TitleTemplates from "./pages/title/TitleTemplates";
import TitleRules from "./pages/title/TitleRules";

interface SearchResult {
  kind: string; exact: boolean; reason: string;
  id?: number; make_id?: number; standard_make?: string; standard_model?: string;
  raw_or_alias_make?: string; raw_or_alias_model?: string;
  canonical_make?: string; canonical_model?: string; canonical_model_id?: number;
  raw_grouped_model_value?: string; standard_submodel?: string; model_id?: number;
}

function GlobalSearch() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number>();
  const location = useLocation();
  useEffect(() => { setOpen(false); setQ(""); }, [location]);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) { setResults(null); return; }
    timer.current = window.setTimeout(async () => {
      const r = await apiGet<{ results: SearchResult[] }>(`/api/search${qs({ q })}`);
      setResults(r.results); setOpen(true);
    }, 250);
  }, [q]);
  const link = (r: SearchResult): string => {
    if (r.kind === "make") return `/makes/${r.id}`;
    if (r.kind === "model") return `/models/${r.id}`;
    if (r.kind === "alias" && r.canonical_model_id) return `/models/${r.canonical_model_id}`;
    if (r.kind === "submodel" && r.model_id) return `/models/${r.model_id}`;
    if (r.kind === "alias") return `/aliases${qs({ q })}`;
    return `/aliases${qs({ q })}`;
  };
  const label = (r: SearchResult): string => {
    if (r.kind === "make") return `${r.standard_make} (Make)`;
    if (r.kind === "model") return `${r.standard_make} ${r.standard_model} (Model)`;
    if (r.kind === "alias") {
      return `"${r.raw_or_alias_make} ${r.raw_or_alias_model}" → ${r.canonical_make ?? "?"} ${r.canonical_model ?? "(multiple)"}`;
    }
    if (r.kind === "grouped") return `"${r.raw_grouped_model_value}" → ${r.canonical_make} ${r.canonical_model}`;
    if (r.kind === "submodel") return `${r.standard_make} ${r.standard_model} · ${r.standard_submodel} (variant)`;
    return JSON.stringify(r);
  };
  return (
    <div className="search-wrap">
      <input
        placeholder="Global search: make, model, alias, raw value (e.g. F150, Mercedes Benz, X Type)…"
        value={q}
        aria-label="Global search"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results && setOpen(true)}
      />
      {open && results && (
        <div className="search-results" role="listbox">
          {results.length === 0 && <div className="item">No matches.</div>}
          {results.map((r, i) => (
            <Link className="item" to={link(r)} key={i}>
              <div>{r.exact ? <strong>{label(r)}</strong> : label(r)}</div>
              <div className="why">{r.reason}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>US Make/Model Catalog<small>1980 – 2026-07-15 · local reference</small></h1>
        <nav>
          <div className="section">Browse</div>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/makes">Makes</NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/submodels">Sub-models</NavLink>
          <NavLink to="/years">Year browser</NavLink>
          <NavLink to="/selector">Vehicle selector</NavLink>
          <div className="section">Reference</div>
          <NavLink to="/aliases">Alias lookup</NavLink>
          <NavLink to="/review">Validation review</NavLink>
          <NavLink to="/sources">Sources &amp; audit</NavLink>
          <div className="section">File standardization</div>
          <NavLink to="/std/projects">Projects</NavLink>
          <NavLink to="/std/upload">Upload file</NavLink>
          <NavLink to="/std/templates">Mapping templates</NavLink>
          <div className="section">Title optimizer</div>
          <NavLink to="/title/projects">Title projects</NavLink>
          <NavLink to="/title/upload">Optimize titles</NavLink>
          <NavLink to="/title/templates">Title templates</NavLink>
          <NavLink to="/title/rules">Rules &amp; abbreviations</NavLink>
          <div className="section">Manage</div>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
      </aside>
      <main className="main">
        <div className="topbar">
          <GlobalSearch />
        </div>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/makes" element={<Makes />} />
          <Route path="/makes/:id" element={<MakeDetail />} />
          <Route path="/models" element={<Models />} />
          <Route path="/models/:id" element={<ModelDetail />} />
          <Route path="/submodels" element={<Submodels />} />
          <Route path="/years" element={<Years />} />
          <Route path="/years/:year" element={<Years />} />
          <Route path="/selector" element={<SelectorPage />} />
          <Route path="/aliases" element={<Aliases />} />
          <Route path="/review" element={<Review />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/std/projects" element={<StdProjects />} />
          <Route path="/std/upload" element={<StdUpload />} />
          <Route path="/std/templates" element={<StdTemplates />} />
          <Route path="/std/projects/:id" element={<StdHistory />} />
          <Route path="/std/projects/:id/map" element={<StdMap />} />
          <Route path="/std/projects/:id/process" element={<StdProcess />} />
          <Route path="/std/projects/:id/review" element={<StdReview />} />
          <Route path="/title/projects" element={<TitleProjects />} />
          <Route path="/title/upload" element={<TitleUpload />} />
          <Route path="/title/templates" element={<TitleTemplates />} />
          <Route path="/title/rules" element={<TitleRules />} />
          <Route path="/title/projects/:id/review" element={<TitleReview />} />
          <Route path="/std/projects/:id/export" element={<StdExport />} />
        </Routes>
      </main>
    </div>
  );
}
