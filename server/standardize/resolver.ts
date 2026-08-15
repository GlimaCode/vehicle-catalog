/**
 * Canonical resolution against the frozen Version 4 catalog.
 *
 * The resolver only ever READS canonical tables. Resolution is contextual:
 * Models are resolved inside the resolved Make, and hierarchy values inside
 * the resolved Make + Model. Configuration values (engine, drivetrain, body
 * style, package, commercial configuration) are recognised so they can be
 * reported as such instead of being mistaken for Trims or Models.
 */
import type Database from "better-sqlite3";
import { norm } from "../db.js";

export type Confidence =
  | "Exact Canonical Match"
  | "Approved Alias Match"
  | "Deterministic Normalization"
  | "High Confidence Suggested Match"
  | "Low Confidence Suggested Match"
  | "No Match"
  | "Conflict";

export const AUTO_APPLY: Confidence[] = ["Exact Canonical Match",
  "Approved Alias Match", "Deterministic Normalization"];

export interface Resolution {
  raw: string;
  value: string | null;
  confidence: Confidence;
  classification?: string;
  evidence?: string;
  alternatives?: { value: string; note?: string }[];
  conflict?: string;
  autoApplied?: boolean;
}

const HIER_TYPES = ["Sub-model", "Trim", "Series", "Edition", "Generation", "Chassis"];

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyConfidence(a: string, b: string): Confidence | null {
  const d = levenshtein(a, b);
  if (d === 0) return "Deterministic Normalization";
  const len = Math.max(a.length, b.length);
  if (len >= 4 && d === 1) return "High Confidence Suggested Match";
  if (len >= 7 && d === 2) return "High Confidence Suggested Match";
  if (len >= 6 && d <= 3) return "Low Confidence Suggested Match";
  return null;
}

interface MakeRec { id: number; name: string }
interface ModelRec { id: number; makeId: number; makeName: string; name: string;
  years: Set<number>; yearsText: string }
interface ValueRec { value: string; type: string; years: Set<number>;
  yearsText: string; group: "hierarchy" | "configuration" }

export class CanonicalResolver {
  private makes = new Map<string, MakeRec>();               // norm -> make
  private makeAliases = new Map<string, { make: MakeRec; note: string }>();
  private modelsByMake = new Map<number, Map<string, ModelRec>>();
  private modelAliases = new Map<string, { model: ModelRec; note: string }>();  // makeId|norm
  private modelsByNormAnyMake = new Map<string, ModelRec[]>();
  private valuesByModel = new Map<number, ValueRec[]>();
  private groupedByMake = new Map<string, ModelRec[]>();    // makeId|norm -> models

  constructor(private db: Database.Database) { this.load(); }

  private load(): void {
    for (const r of this.db.prepare("SELECT id, standard_make FROM makes").all() as
      { id: number; standard_make: string }[]) {
      this.makes.set(norm(r.standard_make), { id: r.id, name: r.standard_make });
    }
    for (const r of this.db.prepare(`
      SELECT m.id, m.make_id, m.standard_model, m.confirmed_model_years, k.standard_make
      FROM models m JOIN makes k ON k.id = m.make_id`).all() as
      { id: number; make_id: number; standard_model: string;
        confirmed_model_years: string; standard_make: string }[]) {
      const rec: ModelRec = { id: r.id, makeId: r.make_id, makeName: r.standard_make,
        name: r.standard_model, years: new Set(), yearsText: r.confirmed_model_years };
      for (const y of expandYearText(r.confirmed_model_years)) rec.years.add(y);
      if (!this.modelsByMake.has(r.make_id)) this.modelsByMake.set(r.make_id, new Map());
      this.modelsByMake.get(r.make_id)!.set(norm(r.standard_model), rec);
      const key = norm(r.standard_model);
      this.modelsByNormAnyMake.set(key, [...(this.modelsByNormAnyMake.get(key) ?? []), rec]);
    }
    for (const r of this.db.prepare(`
      SELECT a.raw_or_alias_make, a.raw_or_alias_model, a.alias_type, a.notes,
             a.canonical_make_id, a.canonical_model_id
      FROM aliases a`).all() as {
        raw_or_alias_make: string; raw_or_alias_model: string; alias_type: string;
        notes: string; canonical_make_id: number | null; canonical_model_id: number | null }[]) {
      if (r.canonical_make_id) {
        const mk = [...this.makes.values()].find((m) => m.id === r.canonical_make_id);
        if (mk && norm(r.raw_or_alias_make) !== norm(mk.name)) {
          this.makeAliases.set(norm(r.raw_or_alias_make),
            { make: mk, note: `${r.alias_type}: ${r.notes ?? ""}`.trim() });
        }
        if (mk && r.canonical_model_id) {
          const model = [...(this.modelsByMake.get(mk.id)?.values() ?? [])]
            .find((m) => m.id === r.canonical_model_id);
          if (model) {
            this.modelAliases.set(`${mk.id}|${norm(r.raw_or_alias_model)}`,
              { model, note: `${r.alias_type}: ${r.notes ?? ""}`.trim() });
          }
        }
      }
    }
    for (const r of this.db.prepare(`
      SELECT g.raw_make, g.raw_grouped_model_value, g.canonical_make_id, g.canonical_model_id
      FROM grouped_model_relationships g WHERE g.canonical_model_id IS NOT NULL`).all() as
      { raw_make: string; raw_grouped_model_value: string; canonical_make_id: number;
        canonical_model_id: number }[]) {
      const key = `${r.canonical_make_id}|${norm(r.raw_grouped_model_value)}`;
      const model = [...(this.modelsByMake.get(r.canonical_make_id)?.values() ?? [])]
        .find((m) => m.id === r.canonical_model_id);
      if (model) this.groupedByMake.set(key, [...(this.groupedByMake.get(key) ?? []), model]);
    }
    const loadValues = (table: string, group: "hierarchy" | "configuration") => {
      for (const r of this.db.prepare(`
        SELECT model_id, value, classification_type, confirmed_model_years
        FROM ${table}`).all() as { model_id: number; value: string;
          classification_type: string; confirmed_model_years: string }[]) {
        const years = new Set(expandYearText(r.confirmed_model_years));
        const list = this.valuesByModel.get(r.model_id) ?? [];
        list.push({ value: r.value, type: r.classification_type, years,
          yearsText: r.confirmed_model_years, group });
        this.valuesByModel.set(r.model_id, list);
      }
    };
    loadValues("vehicle_hierarchy_values", "hierarchy");
    loadValues("vehicle_configuration_values", "configuration");
  }

  stats() {
    return { makes: this.makes.size,
      models: [...this.modelsByMake.values()].reduce((a, m) => a + m.size, 0),
      makeAliases: this.makeAliases.size, modelAliases: this.modelAliases.size };
  }

  resolveMake(raw: string): Resolution {
    const value = (raw ?? "").trim();
    if (!value) return { raw, value: null, confidence: "No Match", evidence: "Empty value" };
    const n = norm(value);
    const exact = this.makes.get(n);
    if (exact) {
      return { raw, value: exact.name,
        confidence: value === exact.name ? "Exact Canonical Match"
          : "Deterministic Normalization",
        evidence: value === exact.name ? "Matches the canonical Make exactly"
          : `Case/punctuation normalization to canonical Make "${exact.name}"` };
    }
    const alias = this.makeAliases.get(n);
    if (alias) {
      return { raw, value: alias.make.name, confidence: "Approved Alias Match",
        evidence: `Approved catalog alias -> ${alias.make.name}. ${alias.note}` };
    }
    const candidates: { value: string; conf: Confidence }[] = [];
    for (const [mn, m] of this.makes) {
      const c = fuzzyConfidence(n, mn);
      if (c && c !== "Deterministic Normalization") candidates.push({ value: m.name, conf: c });
    }
    if (candidates.length === 1) {
      return { raw, value: candidates[0].value, confidence: candidates[0].conf,
        evidence: "Suggested by near-match against the canonical Make list; "
          + "requires approval" };
    }
    if (candidates.length > 1) {
      return { raw, value: null, confidence: "Conflict",
        conflict: "Multiple canonical Makes are similar to this value",
        alternatives: candidates.map((c) => ({ value: c.value })),
        evidence: "Ambiguous near-match" };
    }
    return { raw, value: null, confidence: "No Match",
      evidence: "No canonical Make, alias or near-match found" };
  }

  resolveModel(raw: string, makeName: string | null): Resolution {
    const value = (raw ?? "").trim();
    if (!value) return { raw, value: null, confidence: "No Match", evidence: "Empty value" };
    const n = norm(value);
    const mk = makeName ? this.makes.get(norm(makeName)) : undefined;

    if (mk) {
      const models = this.modelsByMake.get(mk.id) ?? new Map();
      const exact = models.get(n);
      if (exact) {
        return { raw, value: exact.name,
          confidence: value === exact.name ? "Exact Canonical Match"
            : "Deterministic Normalization",
          evidence: value === exact.name
            ? `Matches canonical ${mk.name} model exactly`
            : `Case/punctuation/hyphen normalization to "${exact.name}" under ${mk.name}` };
      }
      const alias = this.modelAliases.get(`${mk.id}|${n}`);
      if (alias) {
        return { raw, value: alias.model.name, confidence: "Approved Alias Match",
          evidence: `Approved catalog alias under ${mk.name} -> ${alias.model.name}. ${alias.note}` };
      }
      const grouped = this.groupedByMake.get(`${mk.id}|${n}`);
      if (grouped?.length) {
        return { raw, value: grouped.length === 1 ? grouped[0].name : null,
          confidence: grouped.length === 1 ? "Approved Alias Match" : "Conflict",
          conflict: grouped.length > 1
            ? "Grouped compatibility value covering several canonical models" : undefined,
          alternatives: grouped.map((g) => ({ value: g.name,
            note: "member of the grouped source value" })),
          evidence: "Approved grouped-model relationship in the catalog" };
      }
      // is the value actually a hierarchy or configuration value of this make?
      const asValue = this.findValueUnderMake(mk.id, n);
      if (asValue) {
        return { raw, value: null, confidence: "Conflict",
          conflict: `"${value}" is a ${asValue.type} of ${mk.name} ${asValue.modelName}`
            + ", not a Model",
          alternatives: [{ value: asValue.modelName, note: "parent model" }],
          classification: asValue.type,
          evidence: "Matched an approved hierarchy/configuration value, not a Model" };
      }
      const near: { value: string; conf: Confidence }[] = [];
      for (const [mn, m] of models) {
        const c = fuzzyConfidence(n, mn);
        if (c && c !== "Deterministic Normalization") near.push({ value: m.name, conf: c });
      }
      near.sort((a, b) => (a.conf === "High Confidence Suggested Match" ? -1 : 1));
      if (near.length === 1) {
        return { raw, value: near[0].value, confidence: near[0].conf,
          evidence: `Near-match against canonical ${mk.name} models; requires approval` };
      }
      if (near.length > 1) {
        return { raw, value: near[0].value, confidence: "Low Confidence Suggested Match",
          alternatives: near.slice(0, 5).map((x) => ({ value: x.value })),
          evidence: `Several similar ${mk.name} models; requires approval` };
      }
      // cross-brand check: does this model exist under a different make?
      const other = this.modelsByNormAnyMake.get(n) ?? [];
      if (other.length) {
        return { raw, value: null, confidence: "Conflict",
          conflict: `"${value}" is a ${other.map((o) => o.makeName).join("/")} model, `
            + `not a ${mk.name} model (cross-brand conflict)`,
          alternatives: other.map((o) => ({ value: `${o.makeName} ${o.name}` })),
          evidence: "Cross-brand conflict detected against the canonical catalog" };
      }
      return { raw, value: null, confidence: "No Match",
        evidence: `No canonical ${mk.name} model, alias or near-match found` };
    }

    // no Make context: only accept an unambiguous global match
    const global = this.modelsByNormAnyMake.get(n) ?? [];
    if (global.length === 1) {
      return { raw, value: global[0].name,
        confidence: value === global[0].name ? "Exact Canonical Match"
          : "Deterministic Normalization",
        evidence: `Unique canonical model across the catalog (${global[0].makeName})` };
    }
    if (global.length > 1) {
      return { raw, value: null, confidence: "Conflict",
        conflict: "Model name exists under multiple Makes; Make context is required",
        alternatives: global.map((g) => ({ value: `${g.makeName} ${g.name}` })),
        evidence: "Ambiguous without Make context" };
    }
    return { raw, value: null, confidence: "No Match",
      evidence: "No canonical model found (no Make context available)" };
  }

  private findValueUnderMake(makeId: number, n: string):
    { type: string; modelName: string; group: string } | null {
    for (const [, model] of this.modelsByMake.get(makeId) ?? []) {
      for (const v of this.valuesByModel.get(model.id) ?? []) {
        if (norm(v.value) === n) {
          return { type: v.type, modelName: model.name, group: v.group };
        }
      }
    }
    return null;
  }

  /** Resolve a hierarchy value (Sub-model/Trim/Series/Edition/Generation/Chassis). */
  resolveHierarchy(raw: string, makeName: string | null, modelName: string | null): Resolution {
    const value = (raw ?? "").trim();
    if (!value) return { raw, value: null, confidence: "No Match", evidence: "Empty value" };
    const n = norm(value);
    const mk = makeName ? this.makes.get(norm(makeName)) : undefined;
    const model = mk && modelName
      ? this.modelsByMake.get(mk.id)?.get(norm(modelName)) : undefined;
    if (!model) {
      return { raw, value: null, confidence: "No Match",
        evidence: "Hierarchy values are only resolved inside a resolved Make and Model" };
    }
    const values = this.valuesByModel.get(model.id) ?? [];
    const exact = values.find((v) => norm(v.value) === n);
    if (exact) {
      if (exact.group === "configuration") {
        return { raw, value: exact.value, confidence: "Conflict",
          classification: exact.type,
          conflict: `"${value}" is a ${exact.type} (vehicle configuration), not a `
            + "hierarchy value",
          evidence: `Approved ${exact.type} of ${model.makeName} ${model.name} `
            + `(${exact.yearsText})` };
      }
      return { raw, value: exact.value, classification: exact.type,
        confidence: value === exact.value ? "Exact Canonical Match"
          : "Deterministic Normalization",
        evidence: `Approved ${exact.type} of ${model.makeName} ${model.name} `
          + `(${exact.yearsText})` };
    }
    const near = values.filter((v) => v.group === "hierarchy")
      .map((v) => ({ v, c: fuzzyConfidence(n, norm(v.value)) }))
      .filter((x) => x.c && x.c !== "Deterministic Normalization");
    if (near.length === 1) {
      return { raw, value: near[0].v.value, classification: near[0].v.type,
        confidence: near[0].c!, alternatives: [],
        evidence: `Near-match against approved ${model.makeName} ${model.name} `
          + "hierarchy values; requires approval" };
    }
    if (near.length > 1) {
      return { raw, value: near[0].v.value, classification: near[0].v.type,
        confidence: "Low Confidence Suggested Match",
        alternatives: near.slice(0, 5).map((x) => ({ value: x.v.value, note: x.v.type })),
        evidence: "Several similar approved hierarchy values; requires approval" };
    }
    return { raw, value: null, confidence: "No Match",
      evidence: `No approved hierarchy value "${value}" for ${model.makeName} ${model.name}. `
        + "Unresolved values stay in review and are never invented." };
  }

  /** Resolve a configuration value (engine/drivetrain/body style/package/etc.). */
  resolveConfiguration(raw: string, makeName: string | null, modelName: string | null,
    expected?: string): Resolution {
    const value = (raw ?? "").trim();
    if (!value) return { raw, value: null, confidence: "No Match", evidence: "Empty value" };
    const n = norm(value);
    const mk = makeName ? this.makes.get(norm(makeName)) : undefined;
    const model = mk && modelName
      ? this.modelsByMake.get(mk.id)?.get(norm(modelName)) : undefined;
    if (!model) {
      return { raw, value: null, confidence: "No Match",
        evidence: "Configuration values are resolved inside a resolved Make and Model" };
    }
    const hit = (this.valuesByModel.get(model.id) ?? []).find((v) => norm(v.value) === n);
    if (!hit) {
      return { raw, value: null, confidence: "No Match",
        evidence: `No approved configuration value "${value}" for ${model.makeName} `
          + model.name };
    }
    if (hit.group === "hierarchy") {
      return { raw, value: hit.value, classification: hit.type, confidence: "Conflict",
        conflict: `"${value}" is a ${hit.type} (vehicle hierarchy), not a configuration value`,
        evidence: `Approved ${hit.type} of ${model.makeName} ${model.name}` };
    }
    if (expected && hit.type !== expected) {
      return { raw, value: hit.value, classification: hit.type, confidence: "Conflict",
        conflict: `"${value}" is a ${hit.type}, not a ${expected}`,
        evidence: `Approved ${hit.type} of ${model.makeName} ${model.name} (${hit.yearsText})` };
    }
    return { raw, value: hit.value, classification: hit.type,
      confidence: value === hit.value ? "Exact Canonical Match" : "Deterministic Normalization",
      evidence: `Approved ${hit.type} of ${model.makeName} ${model.name} (${hit.yearsText})` };
  }

  modelYears(makeName: string | null, modelName: string | null): Set<number> | null {
    const mk = makeName ? this.makes.get(norm(makeName)) : undefined;
    const model = mk && modelName
      ? this.modelsByMake.get(mk.id)?.get(norm(modelName)) : undefined;
    return model ? model.years : null;
  }

  hierarchyYears(makeName: string | null, modelName: string | null,
    value: string | null): Set<number> | null {
    if (!value) return null;
    const mk = makeName ? this.makes.get(norm(makeName)) : undefined;
    const model = mk && modelName
      ? this.modelsByMake.get(mk.id)?.get(norm(modelName)) : undefined;
    if (!model) return null;
    const hit = (this.valuesByModel.get(model.id) ?? [])
      .find((v) => norm(v.value) === norm(value) && v.group === "hierarchy");
    return hit ? hit.years : null;
  }

  hierarchyValuesFor(makeName: string, modelName: string): ValueRec[] {
    const mk = this.makes.get(norm(makeName));
    const model = mk ? this.modelsByMake.get(mk.id)?.get(norm(modelName)) : undefined;
    return model ? (this.valuesByModel.get(model.id) ?? [])
      .filter((v) => v.group === "hierarchy" && HIER_TYPES.includes(v.type)) : [];
  }
}

// ---------------------------------------------------------------------------
// Model-year parsing and validation
// ---------------------------------------------------------------------------
export type YearStatus = "Valid" | "Partially Valid" | "Outside Confirmed Range"
  | "Invalid Format" | "Missing" | "Manual Review Required";

export interface YearResult {
  raw: string;
  years: number[];
  normalized: string;
  status: YearStatus;
  invalidYears: number[];
  note: string;
}

export function expandYearText(text: string): number[] {
  const out: number[] = [];
  for (const seg of (text ?? "").split(";")) {
    const m = seg.trim().match(/^(\d{4})(?:\s*-\s*(\d{4}))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let y = a; y <= b; y++) out.push(y);
  }
  return out;
}

export function compressYears(years: number[]): string {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  if (!ys.length) return "";
  const parts: string[] = [];
  let start = ys[0], prev = ys[0];
  for (const y of ys.slice(1)) {
    if (y === prev + 1) { prev = y; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = y;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join("; ");
}

/** Parse free-form year text: single, ranges, lists, "Fits 2006 to 2008". */
export function parseYearValue(raw: string): { years: number[]; format: "ok" | "invalid" | "empty" } {
  const text = (raw ?? "").trim();
  if (!text) return { years: [], format: "empty" };
  const years = new Set<number>();
  const rangeRe = /(\d{4})\s*(?:-|–|—|to|through|thru|\.\.)\s*(\d{4})/gi;
  let m: RegExpExecArray | null;
  const consumed: [number, number][] = [];
  while ((m = rangeRe.exec(text)) !== null) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a >= 1900 && b <= 2100 && b >= a && b - a <= 60) {
      for (let y = a; y <= b; y++) years.add(y);
      consumed.push([m.index, m.index + m[0].length]);
    }
  }
  const singleRe = /\b(19\d{2}|20\d{2})\b/g;
  while ((m = singleRe.exec(text)) !== null) {
    const inRange = consumed.some(([s, e]) => m!.index >= s && m!.index < e);
    if (!inRange) years.add(Number(m[1]));
  }
  if (!years.size) return { years: [], format: "invalid" };
  return { years: [...years].sort((a, b) => a - b), format: "ok" };
}

export function validateYears(raw: string, confirmed: Set<number> | null,
  context: string): YearResult {
  const { years, format } = parseYearValue(raw);
  if (format === "empty") {
    return { raw, years: [], normalized: "", status: "Missing", invalidYears: [],
      note: "No year value provided" };
  }
  if (format === "invalid") {
    return { raw, years: [], normalized: "", status: "Invalid Format", invalidYears: [],
      note: `Could not read any model year from "${raw}"` };
  }
  const normalized = compressYears(years);
  if (!confirmed) {
    return { raw, years, normalized, status: "Manual Review Required", invalidYears: [],
      note: `Years parsed but cannot be validated: ${context}` };
  }
  const invalid = years.filter((y) => !confirmed.has(y));
  if (!invalid.length) {
    return { raw, years, normalized, status: "Valid", invalidYears: [],
      note: `All years fall inside the confirmed range (${context})` };
  }
  if (invalid.length === years.length) {
    return { raw, years, normalized, status: "Outside Confirmed Range",
      invalidYears: invalid,
      note: `No listed year is inside the confirmed range (${context}). `
        + "Years are kept for review, never deleted." };
  }
  return { raw, years, normalized, status: "Partially Valid", invalidYears: invalid,
    note: `Years outside the confirmed range: ${invalid.join(", ")} (${context}). `
      + "Kept for review, never deleted." };
}
