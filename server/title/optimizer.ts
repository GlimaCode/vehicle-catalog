/**
 * The Title Optimizer.
 *
 * Reduces a listing title to a configurable maximum length (default 80 Unicode
 * characters) by applying deterministic, documented rules in stages. Every
 * character removed is attributable to a named rule.
 *
 * Two things this module never does:
 *   - hard truncation of any kind (no slicing, no ellipsis, no partial words);
 *   - modifying anything other than the title. Supporting fields are read to
 *     construct and validate the title, never rewritten.
 */
import { DEFAULT_PRIORITY } from "./seed.js";
import {
  compareKey, extractYears, FORBIDDEN_LEATHER_FORMS, mentionsGenuineLeather,
  mentionsLeather, normalizeYears, phraseKey, removePhraseOnce, replaceWord,
  tidy, titleLength, toSpans,
} from "./text.js";

/**
 * Year information is preserved when the candidate covers exactly the same set
 * of model years as the original, however it is written. "2006 2007 2008" and
 * "2006-2008" are equal; "2006, 2008" and "2006-2008" are not.
 */
function preservesYears(original: string, candidate: string): boolean {
  const expand = (text: string): Set<number> => {
    const out = new Set<number>();
    for (const span of toSpans(extractYears(normalizeYears(text).value))) {
      for (let y = span.start; y <= span.end; y++) out.add(y);
    }
    return out;
  };
  const a = expand(original);
  if (a.size === 0) return true;
  const b = expand(candidate);
  if (a.size !== b.size) return false;
  for (const y of a) if (!b.has(y)) return false;
  return true;
}

export type TitleStatus = "Already Within Limit" | "Optimized"
  | "Optimized with Warning" | "Manual Review Required" | "Unable to Reach Limit"
  | "Excluded";

export interface Abbreviation {
  full: string; abbreviated: string; applicableField: string;
  minimumCharactersSaved: number; ambiguityRisk: "Low" | "Medium" | "High";
  approvalStatus: "Approved" | "Pending" | "Rejected";
}

export interface CanonicalLookup {
  /** Canonical Make for a raw value, with the confidence of the match. */
  resolveMake(raw: string): { value: string; confidence: string } | null;
  /** Canonical Model for a raw value within a Make. */
  resolveModel(make: string, raw: string): { value: string; confidence: string } | null;
  /** True when the Make/Model pair is a known canonical relationship. */
  isKnownPair(make: string, model: string): boolean;
  /** True when the hierarchy value (Trim/Sub-model) is approved for the pair. */
  isApprovedHierarchy(make: string, model: string, value: string): boolean;
  /** Model years recorded for the pair, used to validate a year range. */
  modelYears(make: string, model: string): number[];
}

export interface TitleFields {
  Title?: string; Year?: string; "Year Range"?: string; Make?: string;
  Model?: string; "Sub-model"?: string; Trim?: string; Material?: string;
  Color?: string; Variation?: string; "Product Type"?: string; Position?: string;
  Side?: string; Row?: string; Quantity?: string; Fitment?: string;
  "Item ID"?: string; SKU?: string; Other?: string;
  [key: string]: string | undefined;
}

export interface OptimizerOptions {
  maxCharacters?: number;
  abbreviations?: Abbreviation[];
  enabledRules?: Set<string>;
  canonical?: CanonicalLookup;
  template?: { pattern: string; required: string[]; optional: string[];
    priority: string[] } | null;
  /** Values the user explicitly approved for this project. */
  approvedValues?: Set<string>;
}

export interface AppliedRule {
  stage: number; ruleId: string; ruleName: string;
  before: string; after: string; charactersSaved: number; removedPhrase?: string;
}

export interface OptimizeResult {
  originalTitle: string;
  originalLength: number;
  proposedTitle: string;
  proposedLength: number;
  charactersRemoved: number;
  status: TitleStatus;
  appliedRules: AppliedRule[];
  removedInformation: string[];
  preservedInformation: string[];
  validationWarnings: string[];
  blocked: boolean;
}

const MARKETING = [
  "brand new", "high quality", "premium quality", "top quality", "best quality",
  "custom fit", "perfect fit", "hot sale", "free shipping", "fast shipping",
  "100% new", "great deal", "new arrival", "factory style", "oem style",
];

const RULE_NAMES: Record<string, string> = {
  S1_TRIM: "Trim surrounding whitespace",
  S1_COLLAPSE_SPACES: "Collapse repeated spaces",
  S1_PUNCT_SPACING: "Normalize punctuation spacing",
  S1_REPEATED_PHRASE: "Remove exact repeated phrases",
  S1_YEAR_RANGE: "Normalize year formatting",
  S1_CANONICAL_MAKE: "Apply canonical Make spelling",
  S1_CANONICAL_MODEL: "Apply canonical Model spelling",
  S1_DEDUPE_MAKE_MODEL: "Remove duplicated Make/Model",
  S1_DEDUPE_MATERIAL: "Remove duplicated material",
  S1_DEDUPE_COLOR: "Remove duplicated color",
  S2_DROP_FOR: "Remove unnecessary 'For'",
  S2_DROP_FITS: "Remove unnecessary 'Fits'",
  S2_DEDUPE_REPLACEMENT: "Remove duplicated 'Replacement'",
  S2_DROP_MARKETING: "Remove generic marketing wording",
  S2_DEDUPE_PRODUCT_TYPE: "Remove repeated product type",
  S3_PAIR_SLASH: "Compact paired positions with /",
  S3_AMPERSAND: "Use & where shorter and clear",
  S3_HYPHENS: "Normalize hyphens",
  S3_COMMAS: "Remove unnecessary commas",
  S3_DECORATIVE: "Remove decorative punctuation",
  S4_ABBREVIATE: "Apply approved abbreviations",
  S5_DROP_OPTIONAL: "Remove lower-priority optional wording",
};

/**
 * Phrases that must survive optimization.
 *
 * A mapped field only becomes a critical phrase when it is actually present in
 * the original title. The optimizer never *adds* information, so demanding a
 * value the title never carried would reject every candidate for no reason -
 * and inventing it would breach the "do not add unconfirmed data" rule.
 *
 * Years are excluded here and checked separately, because normalizing
 * "2006 2007 2008" to "2006-2008" preserves the information while changing the
 * text completely.
 */
export function criticalPhrases(fields: TitleFields, title: string): string[] {
  const out: string[] = [];
  const inTitle = (v: string) => compareKey(title).includes(compareKey(v));
  const add = (v?: string) => {
    if (v && v.trim() && inTitle(v.trim())) out.push(v.trim());
  };
  add(fields.Make); add(fields.Model); add(fields.Material); add(fields.Color);
  add(fields.Variation);
  const designations = [
    /\bdriver\b/i, /\bpassenger\b/i, /\bfront\b/i, /\brear\b/i,
    /\b1st\s+row\b/i, /\b2nd\s+row\b/i, /\b3rd\s+row\b/i,
    /\bbottom\b/i, /\btop\b/i, /\blean\s*back\b/i, /\bbackrest\b/i,
    /\bcushion\b/i, /\barmrest\b/i, /\bheadrest\b/i,
  ];
  for (const re of designations) {
    const m = title.match(re);
    if (m) out.push(m[0]);
  }
  if (mentionsGenuineLeather(title) || mentionsGenuineLeather(fields.Material ?? "")) {
    out.push("Genuine Leather");
  } else if (mentionsLeather(title) || mentionsLeather(fields.Material ?? "")) {
    out.push("Leather");
  }
  return [...new Set(out)];
}

/**
 * True when every critical phrase is still present in the candidate title.
 *
 * Comparison ignores separators so canonical respelling (F150 -> F-150) and
 * approved abbreviation (Passenger -> Pass) are not mistaken for information
 * loss. `abbreviated` carries the approved short forms actually applied.
 */
function preservesCritical(candidate: string, critical: string[],
  abbreviated: Map<string, string> = new Map()): boolean {
  const key = compareKey(candidate);
  return critical.every((c) => {
    const ck = compareKey(c);
    if (!ck) return true;
    if (key.includes(ck)) return true;
    const short = abbreviated.get(compareKey(c));
    return short ? key.includes(compareKey(short)) : false;
  });
}

export function optimizeTitle(fields: TitleFields, opts: OptimizerOptions = {})
  : OptimizeResult {
  const max = opts.maxCharacters ?? 80;
  const enabled = opts.enabledRules ?? null;
  const isOn = (id: string) => (enabled ? enabled.has(id) : true);
  const abbreviations = (opts.abbreviations ?? [])
    .filter((a) => a.approvalStatus === "Approved");

  const originalTitle = String(fields.Title ?? "");
  const originalLength = titleLength(originalTitle);
  const applied: AppliedRule[] = [];
  const removedInformation: string[] = [];
  const warnings: string[] = [];
  let blocked = false;

  const genuine = mentionsGenuineLeather(originalTitle)
    || mentionsGenuineLeather(fields.Material ?? "");
  // Critical phrases start from the source values; canonical resolution below
  // replaces the Make/Model entries with their canonical spelling so that
  // applying that spelling is not mistaken for losing information.
  let critical = criticalPhrases(fields, originalTitle);
  /** Approved short forms actually applied, so the check accepts them. */
  const abbreviatedForms = new Map<string, string>();

  let current = originalTitle;
  const step = (stage: number, ruleId: string, next: string, removedPhrase?: string) => {
    const cleaned = next;
    if (cleaned === current) return false;
    const saved = titleLength(current) - titleLength(cleaned);
    applied.push({ stage, ruleId, ruleName: RULE_NAMES[ruleId] ?? ruleId,
      before: current, after: cleaned, charactersSaved: saved, removedPhrase });
    current = cleaned;
    return true;
  };

  // ---------------------------------------------------------------- Stage 1
  // Clean without removing information.
  if (isOn("S1_TRIM") || isOn("S1_COLLAPSE_SPACES")) {
    step(1, "S1_COLLAPSE_SPACES", tidy(current));
  }
  if (isOn("S1_PUNCT_SPACING")) {
    step(1, "S1_PUNCT_SPACING",
      tidy(current.replace(/\s+([,;:.!?])/g, "$1").replace(/([,;:.])\1+/g, "$1")));
  }
  if (isOn("S1_YEAR_RANGE")) {
    const y = normalizeYears(current);
    if (y.changed) step(1, "S1_YEAR_RANGE", tidy(y.value));
  }

  // Canonical Make/Model spelling. Only exact, alias or deterministic matches are
  // applied; a conflict blocks automatic optimization entirely.
  const canonical = opts.canonical;
  const AUTO = new Set(["Exact Canonical Match", "Approved Alias Match",
    "Deterministic Normalization", "Exact Canonical", "Approved Alias"]);
  let canonicalMake = (fields.Make ?? "").trim();
  let canonicalModel = (fields.Model ?? "").trim();
  if (canonical) {
    if (canonicalMake && isOn("S1_CANONICAL_MAKE")) {
      const r = canonical.resolveMake(canonicalMake);
      if (r && (AUTO.has(r.confidence) || opts.approvedValues?.has(`Make:${r.value}`))) {
        if (r.value !== canonicalMake) {
          step(1, "S1_CANONICAL_MAKE", tidy(replaceWord(current, canonicalMake, r.value)));
        }
        critical = critical.map((c) => (compareKey(c) === compareKey(canonicalMake)
          ? r.value : c));
        canonicalMake = r.value;
      } else if (r) {
        warnings.push(`Make "${canonicalMake}" matched with confidence `
          + `"${r.confidence}"; canonical spelling was not applied automatically.`);
      } else {
        warnings.push(`Make "${canonicalMake}" is not a canonical Make.`);
      }
    }
    if (canonicalModel && isOn("S1_CANONICAL_MODEL")) {
      const r = canonical.resolveModel(canonicalMake, canonicalModel);
      if (r && (AUTO.has(r.confidence) || opts.approvedValues?.has(`Model:${r.value}`))) {
        if (r.value !== canonicalModel) {
          step(1, "S1_CANONICAL_MODEL",
            tidy(replaceWord(current, canonicalModel, r.value)));
        }
        critical = critical.map((c) => (compareKey(c) === compareKey(canonicalModel)
          ? r.value : c));
        canonicalModel = r.value;
      } else if (r) {
        warnings.push(`Model "${canonicalModel}" matched with confidence `
          + `"${r.confidence}"; canonical spelling was not applied automatically.`);
      } else {
        warnings.push(`Model "${canonicalModel}" is not a canonical Model for `
          + `"${canonicalMake}".`);
      }
    }
    // A Make-Model conflict blocks automatic optimization.
    if (canonicalMake && canonicalModel && !canonical.isKnownPair(canonicalMake, canonicalModel)) {
      blocked = true;
      warnings.push(`Make-Model conflict: "${canonicalMake} ${canonicalModel}" is not a `
        + "canonical relationship. Automatic title optimization is blocked.");
    }
    // Year range validated against the canonical relationship when available.
    const yearsInTitle = (current.match(/\b(19[5-9]\d|20[0-4]\d)\b/g) ?? []).map(Number);
    if (!blocked && canonicalMake && canonicalModel && yearsInTitle.length) {
      const known = canonical.modelYears(canonicalMake, canonicalModel);
      if (known.length) {
        const outside = yearsInTitle.filter((y) => !known.includes(y));
        if (outside.length) {
          warnings.push(`Year(s) ${[...new Set(outside)].join(", ")} are not recorded `
            + `for ${canonicalMake} ${canonicalModel}; the years were left unchanged.`);
        }
      }
    }
    // An unapproved Trim/Sub-model is never inserted, and is flagged if present.
    for (const key of ["Trim", "Sub-model"] as const) {
      const v = (fields[key] ?? "").trim();
      if (!v) continue;
      const approved = canonical.isApprovedHierarchy(canonicalMake, canonicalModel, v)
        || opts.approvedValues?.has(`${key}:${v}`);
      if (!approved && new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
        .test(originalTitle)) {
        warnings.push(`${key} "${v}" is not an approved canonical hierarchy value; `
          + "it was left as written and never inserted.");
      }
    }
  }

  if (isOn("S1_REPEATED_PHRASE")) step(1, "S1_REPEATED_PHRASE", dedupePhrases(current));
  if (isOn("S1_DEDUPE_MAKE_MODEL")) {
    let next = current;
    for (const v of [canonicalMake, canonicalModel]) {
      if (v) next = dedupeWord(next, v);
    }
    step(1, "S1_DEDUPE_MAKE_MODEL", tidy(next));
  }
  if (isOn("S1_DEDUPE_MATERIAL")) {
    let next = current;
    for (const m of ["Genuine Leather", "Leather", "Vinyl", "Cloth", "Fabric",
      "Velour", "Suede", "Mesh"]) {
      next = dedupeWord(next, m);
    }
    step(1, "S1_DEDUPE_MATERIAL", tidy(next));
  }
  if (isOn("S1_DEDUPE_COLOR") && fields.Color) {
    step(1, "S1_DEDUPE_COLOR", tidy(dedupeWord(current, fields.Color.trim())));
  }

  const withinAfterStage1 = () => titleLength(current) <= max;

  // ---------------------------------------------------------------- Stage 2
  if (!withinAfterStage1()) {
    if (isOn("S2_DROP_FITS")) {
      step(2, "S2_DROP_FITS", tidy(current.replace(/\bfits\s+(?=\d{4}|\w)/i, "")),
        "Fits");
    }
    if (isOn("S2_DROP_FOR")) {
      step(2, "S2_DROP_FOR", tidy(current.replace(/\bfor\s+(?=\d{4}|[A-Z])/i, "")), "For");
    }
    if (isOn("S2_DEDUPE_REPLACEMENT")) {
      step(2, "S2_DEDUPE_REPLACEMENT", tidy(dedupeWord(current, "Replacement")));
    }
    if (isOn("S2_DROP_MARKETING")) {
      let next = current;
      const dropped: string[] = [];
      for (const m of MARKETING) {
        const before = next;
        next = removePhraseOnce(next, m);
        if (next !== before) dropped.push(m);
      }
      if (dropped.length) {
        step(2, "S2_DROP_MARKETING", tidy(next), dropped.join("; "));
        removedInformation.push(...dropped.map((d) => `Marketing wording: ${d}`));
      }
    }
    if (isOn("S2_DEDUPE_PRODUCT_TYPE")) {
      let next = current;
      for (const p of ["Seat Cover", "Seat Covers", "Upholstery", "Cover", "Covers",
        "Seat"]) {
        next = dedupeWord(next, p);
      }
      step(2, "S2_DEDUPE_PRODUCT_TYPE", tidy(next));
    }
  }

  // ---------------------------------------------------------------- Stage 3
  if (titleLength(current) > max) {
    if (isOn("S3_PAIR_SLASH")) {
      let next = current;
      const pairs: [RegExp, string][] = [
        [/\bdriver\s*(?:&|and|\+)\s*passenger\b/gi, "Driver/Passenger"],
        [/\bpassenger\s*(?:&|and|\+)\s*driver\b/gi, "Passenger/Driver"],
        [/\btop\s*(?:&|and|\+)\s*bottom\b/gi, "Top/Bottom"],
        [/\bbottom\s*(?:&|and|\+)\s*top\b/gi, "Bottom/Top"],
        [/\bleft\s*(?:&|and|\+)\s*right\b/gi, "Left/Right"],
        [/\bright\s*(?:&|and|\+)\s*left\b/gi, "Right/Left"],
        [/\bfront\s*(?:&|and|\+)\s*rear\b/gi, "Front/Rear"],
        [/\brear\s*(?:&|and|\+)\s*front\b/gi, "Rear/Front"],
      ];
      for (const [re, to] of pairs) next = next.replace(re, to);
      step(3, "S3_PAIR_SLASH", tidy(next));
    }
    if (isOn("S3_DECORATIVE")) {
      step(3, "S3_DECORATIVE",
        tidy(current.replace(/[*!~|]+/g, " ").replace(/\s-{2,}\s/g, " ")));
    }
    if (isOn("S3_COMMAS")) {
      // A comma between two years marks a gap in the fitment ("2006, 2008").
      // Removing it would make a non-contiguous list read as a range.
      step(3, "S3_COMMAS", tidy(current.replace(/(?<!\d{4}),(?=\s(?!\d{4}))/g, "")));
    }
    if (isOn("S3_AMPERSAND")) {
      step(3, "S3_AMPERSAND", tidy(current.replace(/\s+and\s+/gi, " & ")));
    }
    if (isOn("S3_HYPHENS")) {
      step(3, "S3_HYPHENS", tidy(current.replace(/\s+[-–—]\s+/g, "-")));
    }
  }

  // ---------------------------------------------------------------- Stage 4
  // Approved abbreviations, lowest risk first, only while over the limit and
  // only as many as needed. Leather is never abbreviated.
  if (titleLength(current) > max && isOn("S4_ABBREVIATE") && abbreviations.length) {
    const order = { Low: 0, Medium: 1, High: 2 } as const;
    const candidates = [...abbreviations]
      .filter((a) => !/leather/i.test(a.full))
      .sort((a, b) => (order[a.ambiguityRisk] - order[b.ambiguityRisk])
        || (b.full.length - a.full.length));
    for (const a of candidates) {
      if (titleLength(current) <= max) break;
      const next = tidy(replaceWord(current, a.full, a.abbreviated));
      if (next === current) continue;
      const saved = titleLength(current) - titleLength(next);
      if (saved < a.minimumCharactersSaved) continue;
      // provisionally register the short form so the check accepts it
      const probe = new Map(abbreviatedForms);
      probe.set(compareKey(a.full), a.abbreviated);
      if (!preservesCritical(next, critical, probe)) continue;
      if (!preservesYears(originalTitle, next)) continue;
      abbreviatedForms.set(compareKey(a.full), a.abbreviated);
      step(4, "S4_ABBREVIATE", next, `${a.full} -> ${a.abbreviated}`);
    }
  }

  // ---------------------------------------------------------------- Stage 5
  // Controlled optional-field removal, lowest priority first. Never touches a
  // higher-priority field to save a lower-priority phrase.
  if (titleLength(current) > max && isOn("S5_DROP_OPTIONAL")) {
    const priority = opts.template?.priority?.length ? opts.template.priority
      : DEFAULT_PRIORITY;
    const required = new Set(opts.template?.required ?? []);
    // walk the priority list from the bottom up
    for (let i = priority.length - 1; i >= 0 && titleLength(current) > max; i--) {
      const field = priority[i];
      if (required.has(field)) continue;
      // Never dropped automatically: these carry fitment or product identity.
      // Product Type is priority 4 - removing it would leave a title that no
      // longer says what is being sold, which is exactly the kind of loss the
      // preservation rules forbid.
      if (["Year Range", "Year", "Make", "Model", "Product Type", "Material",
        "Color", "Variation"].includes(field)) continue;
      const value = (fields[field] ?? "").trim();
      if (!value) continue;
      const next = tidy(removePhraseOnce(current, value));
      if (next === current) continue;
      if (!preservesCritical(next, critical, abbreviatedForms)) continue;
      if (!preservesYears(originalTitle, next)) continue;
      step(5, "S5_DROP_OPTIONAL", next, value);
      removedInformation.push(`${field}: ${value}`);
    }
  }

  // ---------------------------------------------------------------- Stage 6
  // Manual review. No truncation is attempted here or anywhere else.
  const proposedTitle = tidy(current);
  const proposedLength = titleLength(proposedTitle);

  // Safety assertions: these must hold no matter which rules ran.
  if (genuine && !mentionsGenuineLeather(proposedTitle)) {
    warnings.push("Genuine Leather was confirmed by the source but is not present in "
      + "the proposed title; the original was kept.");
  }
  for (const bad of FORBIDDEN_LEATHER_FORMS) {
    if (bad.test(proposedTitle)) {
      warnings.push("A forbidden leather abbreviation was produced; the proposed title "
        + "was rejected.");
    }
  }
  const lostCritical = !preservesCritical(proposedTitle, critical, abbreviatedForms);
  if (lostCritical) {
    warnings.push("Critical information would be lost; the proposed title was rejected.");
  }
  const lostYears = !preservesYears(originalTitle, proposedTitle);
  if (lostYears) {
    warnings.push("The proposed title no longer covers the same model years; it was "
      + "rejected.");
  }

  const rejected = lostCritical || lostYears
    || (genuine && !mentionsGenuineLeather(proposedTitle))
    || FORBIDDEN_LEATHER_FORMS.some((re) => re.test(proposedTitle));

  const safeTitle = rejected || blocked ? originalTitle : proposedTitle;
  const safeLength = titleLength(safeTitle);

  let status: TitleStatus;
  if (blocked) {
    status = "Manual Review Required";
  } else if (rejected) {
    status = safeLength > max ? "Unable to Reach Limit" : "Manual Review Required";
  } else if (originalLength <= max && applied.length === 0) {
    status = "Already Within Limit";
  } else if (safeLength > max) {
    status = "Unable to Reach Limit";
  } else if (warnings.length) {
    status = "Optimized with Warning";
  } else if (originalLength <= max) {
    status = "Already Within Limit";
  } else {
    status = "Optimized";
  }

  return {
    originalTitle,
    originalLength,
    proposedTitle: safeTitle,
    proposedLength: safeLength,
    charactersRemoved: Math.max(0, originalLength - safeLength),
    status,
    appliedRules: rejected || blocked ? [] : applied,
    removedInformation: rejected || blocked ? [] : removedInformation,
    preservedInformation: critical,
    validationWarnings: warnings,
    blocked,
  };
}

/** Removes later exact repetitions of any 2+ word phrase. */
function dedupePhrases(title: string): string {
  const words = title.split(/\s+/);
  for (let len = Math.floor(words.length / 2); len >= 2; len--) {
    for (let i = 0; i + len * 2 <= words.length; i++) {
      const a = words.slice(i, i + len).join(" ");
      const b = words.slice(i + len, i + len * 2).join(" ");
      if (phraseKey(a) && phraseKey(a) === phraseKey(b)) {
        return tidy([...words.slice(0, i + len), ...words.slice(i + len * 2)].join(" "));
      }
    }
  }
  return title;
}

/** Keeps the first occurrence of a word/phrase and drops later duplicates. */
function dedupeWord(title: string, word: string): string {
  if (!word) return title;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(`\\b${escaped}\\b`, "gi");
  let seen = false;
  return title.replace(re, (m) => {
    if (seen) return "";
    seen = true;
    return m;
  });
}

/** Revalidates a manually edited title against the same safety rules. */
export function revalidateTitle(edited: string, fields: TitleFields,
  opts: OptimizerOptions = {}): { status: TitleStatus; length: number;
    warnings: string[] } {
  const max = opts.maxCharacters ?? 80;
  const warnings: string[] = [];
  const length = titleLength(edited);
  const critical = criticalPhrases(fields, String(fields.Title ?? ""));
  const genuine = mentionsGenuineLeather(String(fields.Title ?? ""))
    || mentionsGenuineLeather(fields.Material ?? "");

  if (!preservesCritical(edited, critical)) {
    warnings.push("The edited title no longer contains all critical information.");
  }
  if (genuine && !mentionsGenuineLeather(edited)) {
    warnings.push("Genuine Leather was confirmed by the source but is missing from the "
      + "edited title.");
  }
  for (const bad of FORBIDDEN_LEATHER_FORMS) {
    if (bad.test(edited)) warnings.push("Leather must not be abbreviated.");
  }
  const status: TitleStatus = length > max ? "Unable to Reach Limit"
    : warnings.length ? "Manual Review Required"
    : "Optimized";
  return { status, length, warnings };
}
