/**
 * Read-only adapter from the frozen canonical catalog to the Title Optimizer.
 *
 * Every statement here is a SELECT. The optimizer can consult the catalog to
 * spell a Make correctly or reject an unapproved Trim, but it has no path to
 * modify canonical data - the read-only triggers installed by migration 006
 * would abort any write regardless.
 */
import type Database from "better-sqlite3";
import { norm } from "../db.js";
import type { CanonicalLookup } from "./optimizer.js";

export function createCanonicalLookup(db: Database.Database): CanonicalLookup {
  const makeByNorm = db.prepare(
    "SELECT standard_make FROM makes WHERE norm_make = ?").pluck();
  const modelByNorm = db.prepare(`SELECT m.standard_model FROM models m
    JOIN makes k ON k.id = m.make_id
    WHERE k.norm_make = ? AND m.norm_model = ?`).pluck();
  const aliasStmt = db.prepare(`SELECT norm_make, norm_model, alias_type
    FROM aliases WHERE norm_make = ? AND (norm_model = ? OR ? = '')`);
  const pairStmt = db.prepare(`SELECT 1 FROM models m JOIN makes k ON k.id = m.make_id
    WHERE k.norm_make = ? AND m.norm_model = ?`).pluck();
  const yearsStmt = db.prepare(`SELECT y.model_year FROM model_years y
    JOIN models m ON m.id = y.model_id JOIN makes k ON k.id = m.make_id
    WHERE k.norm_make = ? AND m.norm_model = ? ORDER BY y.model_year`).pluck();
  // Only verified hierarchy values count as approved. Unresolved candidates are
  // never treated as usable Trim or Sub-model values.
  const hierStmt = db.prepare(`SELECT 1 FROM vehicle_hierarchy_values h
    JOIN models m ON m.id = h.model_id JOIN makes k ON k.id = m.make_id
    WHERE k.norm_make = ? AND m.norm_model = ? AND h.norm_value = ?
      AND h.validation_status IN ('Fully Verified','Government Verified',
                                  'Manufacturer Verified')`).pluck();

  // Deterministic normalizations are the same punctuation-level transforms the
  // standardization workspace uses: they change spelling, never identity.
  const deterministic = (raw: string): string[] => {
    const t = raw.trim();
    const out = new Set<string>([t]);
    out.add(t.replace(/\s+/g, "-"));                 // "X Type"  -> "X-Type"
    out.add(t.replace(/-/g, " "));
    out.add(t.replace(/([A-Za-z])(\d)/g, "$1-$2"));  // "F150"    -> "F-150"
    out.add(t.replace(/([A-Za-z])-(\d)/g, "$1$2"));
    out.add(t.replace(/\s+/g, ""));
    return [...out];
  };

  const cacheMake = new Map<string, { value: string; confidence: string } | null>();

  const resolveMake = (raw: string) => {
    const key = norm(raw ?? "");
    if (!key) return null;
    if (cacheMake.has(key)) return cacheMake.get(key)!;
    let result: { value: string; confidence: string } | null = null;
    const exact = makeByNorm.get(key) as string | undefined;
    if (exact) {
      result = { value: exact,
        confidence: exact === raw.trim() ? "Exact Canonical Match"
          : "Deterministic Normalization" };
    } else {
      for (const candidate of deterministic(raw)) {
        const hit = makeByNorm.get(norm(candidate)) as string | undefined;
        if (hit) { result = { value: hit, confidence: "Deterministic Normalization" }; break; }
      }
      if (!result) {
        const alias = aliasStmt.all(key, "", "") as { norm_make: string;
          alias_type: string }[];
        if (alias.length) {
          const hit = makeByNorm.get(alias[0].norm_make) as string | undefined;
          if (hit) result = { value: hit, confidence: "Approved Alias Match" };
        }
      }
    }
    cacheMake.set(key, result);
    return result;
  };

  const resolveModel = (make: string, raw: string) => {
    const mk = norm(make ?? "");
    const key = norm(raw ?? "");
    if (!mk || !key) return null;
    const exact = modelByNorm.get(mk, key) as string | undefined;
    if (exact) {
      return { value: exact,
        confidence: exact === raw.trim() ? "Exact Canonical Match"
          : "Deterministic Normalization" };
    }
    for (const candidate of deterministic(raw)) {
      const hit = modelByNorm.get(mk, norm(candidate)) as string | undefined;
      if (hit) return { value: hit, confidence: "Deterministic Normalization" };
    }
    const alias = aliasStmt.all(mk, key, key) as { norm_model: string }[];
    for (const a of alias) {
      const hit = modelByNorm.get(mk, a.norm_model) as string | undefined;
      if (hit) return { value: hit, confidence: "Approved Alias Match" };
    }
    return null;
  };

  return {
    resolveMake,
    resolveModel,
    isKnownPair: (make, model) => {
      const mk = norm(make ?? "");
      const md = norm(model ?? "");
      if (!mk || !md) return true;         // nothing to contradict
      return pairStmt.get(mk, md) === 1;
    },
    isApprovedHierarchy: (make, model, value) => {
      const mk = norm(make ?? "");
      const md = norm(model ?? "");
      if (!mk || !md || !value) return false;
      return hierStmt.get(mk, md, norm(value)) === 1;
    },
    modelYears: (make, model) => {
      const mk = norm(make ?? "");
      const md = norm(model ?? "");
      if (!mk || !md) return [];
      return yearsStmt.all(mk, md) as number[];
    },
  };
}
