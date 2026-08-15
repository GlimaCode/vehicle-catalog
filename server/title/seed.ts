/**
 * Default catalogs for the Title Optimizer.
 *
 * These are *title-only* rules. Nothing here touches the canonical vehicle
 * catalog: abbreviating "Driver" to "Drv" in a listing title never rewrites a
 * Make, Model, hierarchy, configuration, alias or model-year record, and never
 * changes the value stored in a source column.
 */
import type Database from "better-sqlite3";

export interface RuleSeed {
  ruleId: string; ruleName: string; stage: number; description: string;
  enabled?: boolean; destructive?: boolean;
}

/** Deterministic rules, grouped by optimization stage. */
export const DEFAULT_RULES: RuleSeed[] = [
  // Stage 1 - clean without removing information
  { ruleId: "S1_TRIM", ruleName: "Trim surrounding whitespace", stage: 1,
    description: "Removes leading and trailing whitespace." },
  { ruleId: "S1_COLLAPSE_SPACES", ruleName: "Collapse repeated spaces", stage: 1,
    description: "Replaces runs of whitespace with a single space." },
  { ruleId: "S1_PUNCT_SPACING", ruleName: "Normalize punctuation spacing", stage: 1,
    description: "Removes spaces before , . ; : and collapses duplicated punctuation." },
  { ruleId: "S1_REPEATED_PHRASE", ruleName: "Remove exact repeated phrases", stage: 1,
    description: "Removes a later exact repetition of a multi-word phrase." },
  { ruleId: "S1_YEAR_RANGE", ruleName: "Normalize year formatting", stage: 1,
    description: "Compresses consecutive years into a range; gaps are preserved." },
  { ruleId: "S1_CANONICAL_MAKE", ruleName: "Apply canonical Make spelling", stage: 1,
    description: "Rewrites the Make to its canonical spelling on an exact, alias or "
      + "deterministic match only." },
  { ruleId: "S1_CANONICAL_MODEL", ruleName: "Apply canonical Model spelling", stage: 1,
    description: "Rewrites the Model to its canonical spelling on an exact, alias or "
      + "deterministic match only." },
  { ruleId: "S1_DEDUPE_MAKE_MODEL", ruleName: "Remove duplicated Make/Model", stage: 1,
    description: "Removes a second occurrence of the same Make or Model." },
  { ruleId: "S1_DEDUPE_MATERIAL", ruleName: "Remove duplicated material", stage: 1,
    description: "Removes a repeated material word such as Leather Leather." },
  { ruleId: "S1_DEDUPE_COLOR", ruleName: "Remove duplicated color", stage: 1,
    description: "Removes a repeated color word." },

  // Stage 2 - remove redundant wording
  { ruleId: "S2_DROP_FOR", ruleName: "Remove unnecessary 'For'", stage: 2,
    description: "Drops a leading or mid-title 'For' that adds no information." },
  { ruleId: "S2_DROP_FITS", ruleName: "Remove unnecessary 'Fits'", stage: 2,
    description: "Drops 'Fits' where the fitment is already stated." },
  { ruleId: "S2_DEDUPE_REPLACEMENT", ruleName: "Remove duplicated 'Replacement'", stage: 2,
    description: "Keeps a single 'Replacement'; never removes the last one." },
  { ruleId: "S2_DROP_MARKETING", ruleName: "Remove generic marketing wording", stage: 2,
    description: "Removes non-identifying filler such as Brand New, High Quality, "
      + "Premium Quality, Custom Fit, Perfect Fit, Hot Sale, Top Quality." },
  { ruleId: "S2_DEDUPE_PRODUCT_TYPE", ruleName: "Remove repeated product type", stage: 2,
    description: "Collapses a repeated Seat Cover / Upholstery / Cover phrase." },

  // Stage 3 - compact separators
  { ruleId: "S3_PAIR_SLASH", ruleName: "Compact paired positions with /", stage: 3,
    description: "Driver & Passenger becomes Driver/Passenger; also Top/Bottom, "
      + "Left/Right, Front/Rear." },
  { ruleId: "S3_AMPERSAND", ruleName: "Use & where shorter and clear", stage: 3,
    description: "Replaces the word 'and' with '&' between two noun phrases." },
  { ruleId: "S3_HYPHENS", ruleName: "Normalize hyphens", stage: 3,
    description: "Normalizes spaced hyphens and en dashes in ranges." },
  { ruleId: "S3_COMMAS", ruleName: "Remove unnecessary commas", stage: 3,
    description: "Removes commas that separate already-delimited attributes." },
  { ruleId: "S3_DECORATIVE", ruleName: "Remove decorative punctuation", stage: 3,
    description: "Removes *, !, ~, |, and repeated dashes used as decoration." },

  // Stage 4 - approved abbreviations
  { ruleId: "S4_ABBREVIATE", ruleName: "Apply approved abbreviations", stage: 4,
    description: "Applies the lowest-risk approved abbreviations, fewest first, only "
      + "while the title exceeds the limit. Never abbreviates Leather." },

  // Stage 5 - controlled optional-field removal
  { ruleId: "S5_DROP_OPTIONAL", ruleName: "Remove lower-priority optional wording", stage: 5,
    description: "Removes the lowest-priority optional field or trailing descriptive "
      + "phrase, one at a time, recording every removal.", destructive: true },
];

export interface AbbreviationSeed {
  full: string; abbreviated: string; field?: string; minSaved?: number;
  risk?: "Low" | "Medium" | "High"; status?: "Approved" | "Pending" | "Rejected";
  notes?: string;
}

/**
 * Approved title-only abbreviations. Ordered by ambiguity risk so the optimizer
 * can always reach for the safest one that saves enough characters.
 */
export const DEFAULT_ABBREVIATIONS: AbbreviationSeed[] = [
  { full: "Without", abbreviated: "w/o", field: "Any", minSaved: 4, risk: "Low",
    notes: "Standard listing shorthand." },
  { full: "With", abbreviated: "w/", field: "Any", minSaved: 2, risk: "Low",
    notes: "Standard listing shorthand." },
  { full: "Passenger", abbreviated: "Pass", field: "Side", minSaved: 5, risk: "Low",
    notes: "Side designation is preserved, only shortened." },
  { full: "Driver", abbreviated: "Drv", field: "Side", minSaved: 3, risk: "Low",
    notes: "Side designation is preserved, only shortened." },
  { full: "Front", abbreviated: "Frt", field: "Position", minSaved: 2, risk: "Low" },
  { full: "Rear", abbreviated: "Rr", field: "Position", minSaved: 2, risk: "Low" },
  { full: "Medium", abbreviated: "Med", field: "Color", minSaved: 3, risk: "Low" },
  { full: "Light", abbreviated: "Lt", field: "Color", minSaved: 3, risk: "Low" },
  { full: "Dark", abbreviated: "Dk", field: "Color", minSaved: 2, risk: "Low" },
  { full: "Black", abbreviated: "Blk", field: "Color", minSaved: 2, risk: "Low" },
  { full: "Left", abbreviated: "LH", field: "Side", minSaved: 2, risk: "Medium",
    notes: "LH is unambiguous in automotive listings but reads as an abbreviation." },
  { full: "Right", abbreviated: "RH", field: "Side", minSaved: 3, risk: "Medium",
    notes: "RH is unambiguous in automotive listings but reads as an abbreviation." },
];

/**
 * Colors that may be normalized in the title. Manufacturer-specific colors are
 * deliberately absent: abbreviating them could change which product is being
 * sold, so they are preserved in full unless a project adds an approved mapping.
 */
export const DEFAULT_COLOR_ABBREVIATIONS: AbbreviationSeed[] = [
  { full: "Grey", abbreviated: "Gray", field: "Color", minSaved: 0, risk: "Low",
    notes: "Spelling normalization, not an abbreviation." },
  { full: "Dark Gray", abbreviated: "Dk Gray", field: "Color", minSaved: 2, risk: "Low" },
  { full: "Light Gray", abbreviated: "Lt Gray", field: "Color", minSaved: 3, risk: "Low" },
  { full: "Medium Gray", abbreviated: "Med Gray", field: "Color", minSaved: 3, risk: "Low" },
  { full: "Black", abbreviated: "Blk", field: "Color", minSaved: 2, risk: "Low" },
];

export interface TemplateSeed {
  name: string; pattern: string; required: string[]; optional: string[];
  priority: string[]; isDefault?: boolean; notes?: string;
}

/** Field priority used when a template does not define its own. */
export const DEFAULT_PRIORITY = [
  "Year Range", "Make", "Model", "Product Type", "Position", "Side", "Row",
  "Material", "Color", "Variation", "Quantity", "Trim", "Sub-model", "Other",
];

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    name: "Standard Fitment",
    pattern: "{Year Range} {Make} {Model} {Position} {Material} {Product Type} {Color}",
    required: ["Year Range", "Make", "Model"],
    optional: ["Position", "Material", "Product Type", "Color"],
    priority: DEFAULT_PRIORITY,
    isDefault: true,
    notes: "General-purpose fitment-first title.",
  },
  {
    name: "Variation Focus",
    pattern: "{Year Range} {Make} {Model} {Variation} {Material} {Color}",
    required: ["Year Range", "Make", "Model", "Variation"],
    optional: ["Material", "Color"],
    priority: DEFAULT_PRIORITY,
    notes: "For catalogs where the variation identifies the product.",
  },
  {
    name: "Quantity First",
    pattern: "{Quantity} {Position} {Material} {Product Type} {Year Range} {Make} "
      + "{Model} {Color}",
    required: ["Quantity", "Product Type", "Year Range", "Make", "Model"],
    optional: ["Position", "Material", "Color"],
    priority: DEFAULT_PRIORITY,
    notes: "For multi-piece kits where quantity changes the product meaning.",
  },
];

/** Inserts the default catalogs if they are not already present. */
export function seedTitleCatalogs(db: Database.Database): Record<string, number> {
  const rule = db.prepare(`INSERT OR IGNORE INTO title_rules
    (rule_id, rule_name, stage, description, enabled, destructive)
    VALUES (?,?,?,?,?,?)`);
  let rules = 0;
  for (const r of DEFAULT_RULES) {
    rules += rule.run(r.ruleId, r.ruleName, r.stage, r.description,
      r.enabled === false ? 0 : 1, r.destructive ? 1 : 0).changes;
  }

  const abbr = db.prepare(`INSERT OR IGNORE INTO title_abbreviation_mappings
    (full_value, abbreviated_value, applicable_field, minimum_characters_saved,
     ambiguity_risk, approval_status, project_id, notes)
    VALUES (?,?,?,?,?,?,NULL,?)`);
  let abbreviations = 0;
  for (const a of [...DEFAULT_ABBREVIATIONS, ...DEFAULT_COLOR_ABBREVIATIONS]) {
    abbreviations += abbr.run(a.full, a.abbreviated, a.field ?? "Any",
      a.minSaved ?? 1, a.risk ?? "Low", a.status ?? "Approved",
      a.notes ?? null).changes;
  }

  const tpl = db.prepare(`INSERT OR IGNORE INTO title_templates
    (name, pattern, required_fields, optional_fields, field_priority, is_default,
     project_id, notes) VALUES (?,?,?,?,?,?,NULL,?)`);
  let templates = 0;
  for (const t of DEFAULT_TEMPLATES) {
    templates += tpl.run(t.name, t.pattern, JSON.stringify(t.required),
      JSON.stringify(t.optional), JSON.stringify(t.priority),
      t.isDefault ? 1 : 0, t.notes ?? null).changes;
  }
  return { rules, abbreviations, templates };
}
