/**
 * Primitives for title text: Unicode-correct length, year handling and the
 * phrase helpers the optimizer stages share.
 *
 * Length is measured in Unicode code points, never UTF-8 bytes and never pixel
 * width, so an accented or CJK character counts exactly once.
 */

/** Character count in Unicode code points. */
export function titleLength(value: string): number {
  // Array.from iterates code points, so surrogate pairs count as one character
  return Array.from(value ?? "").length;
}

/** Splits into code points so slicing never severs a surrogate pair. */
export function codePoints(value: string): string[] {
  return Array.from(value ?? "");
}

/** Collapses whitespace (including embedded line breaks) and trims. */
export function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/[\s ]+/g, " ").trim();
}

/** Case- and space-insensitive comparison key for phrase matching. */
export function phraseKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9/+&-]+/g, " ").trim();
}

/**
 * Key for "is this information still present?" checks.
 *
 * Separators are stripped entirely so a value survives legitimate canonical
 * respelling: F150 and F-150 compare equal, as do "Mercedes Benz" and
 * "Mercedes-Benz". Without this, applying canonical spelling would look like
 * information loss and would block every optimization.
 */
export function compareKey(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface YearSpan { start: number; end: number }

const YEAR = "(19[5-9]\\d|20[0-4]\\d)";
/**
 * Matches a run of years however it is written: "2006 2007 2008",
 * "2006, 2007, 2008", "2006 to 2008", "2006-2008", "2006/2008".
 * A bare space counts as a separator, but only between two years - the year
 * must follow immediately, so "2006 Ford" is never treated as a run.
 */
const YEAR_SEP = "(?:\\s*(?:,|;|/|&|-|–|—|to|thru|through|and)\\s*|\\s+)";
const YEAR_RUN = new RegExp(`${YEAR}(?:${YEAR_SEP}${YEAR})*`, "gi");

/** Every year mentioned in a fragment, in order of appearance. */
export function extractYears(fragment: string): number[] {
  const out: number[] = [];
  for (const m of String(fragment ?? "").matchAll(new RegExp(YEAR, "g"))) {
    out.push(Number(m[0]));
  }
  return out;
}

/**
 * Groups years into contiguous spans. Non-contiguous years stay separate:
 * 2006, 2008 yields two spans, never 2006-2008.
 */
export function toSpans(years: number[]): YearSpan[] {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const spans: YearSpan[] = [];
  for (const y of sorted) {
    const last = spans[spans.length - 1];
    if (last && y === last.end + 1) last.end = y;
    else spans.push({ start: y, end: y });
  }
  return spans;
}

/** Renders spans as 2006-2008, 2010 - gaps preserved, ranges compressed. */
export function formatSpans(spans: YearSpan[]): string {
  return spans.map((s) => (s.start === s.end ? `${s.start}`
    : `${s.start}-${s.end}`)).join(", ");
}

/**
 * Rewrites every year run in a title into normalized range form.
 *
 * "2006 2007 2008" and "2006, 2007, 2008" and "2006 to 2008" all become
 * "2006-2008". "2006, 2008" stays "2006, 2008". A run that already reads as an
 * explicit range ("2006-2008") is expanded to its endpoints and re-rendered, so
 * "2006-2008; 2010" keeps its gap.
 */
export function normalizeYears(title: string): { value: string; changed: boolean } {
  let changed = false;
  const value = String(title ?? "").replace(YEAR_RUN, (match) => {
    const years = extractYears(match);
    if (years.length === 0) return match;
    // An explicit range written with a dash covers every year between its ends.
    // Splitting on list separators keeps "2006-2008, 2010" as two parts so the
    // gap survives; a bare space is a list separator too ("2006 2008").
    const expanded: number[] = [];
    // Split on list separators, and on a bare space only when it sits directly
    // between two years. "2006 to 2008" therefore stays one part (a range),
    // while "2006 2008" becomes two parts (a gap).
    const parts = match.split(/\s*(?:,|;|&|and)\s*|(?<=\d{4})\s+(?=\d{4})/i)
      .filter(Boolean);
    for (const part of parts) {
      const ys = extractYears(part);
      const isRange = /-|–|—|\bto\b|\bthru\b|\bthrough\b|\//i.test(part) && ys.length >= 2;
      if (isRange) {
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        for (let y = lo; y <= hi; y++) expanded.push(y);
      } else {
        expanded.push(...ys);
      }
    }
    const rendered = formatSpans(toSpans(expanded));
    if (rendered !== match.trim()) changed = true;
    return rendered;
  });
  return { value, changed };
}

/** True when the fragment mentions leather in any form. */
export function mentionsLeather(value: string): boolean {
  return /\bleather\b/i.test(String(value ?? ""));
}

/** True when the source explicitly confirms genuine leather. */
export function mentionsGenuineLeather(value: string): boolean {
  return /\bgenuine\s+leather\b/i.test(String(value ?? ""));
}

/** Forbidden leather abbreviations - used to assert we never emit them. */
export const FORBIDDEN_LEATHER_FORMS = [
  /\blthr\b\.?/i, /\bg\.\s*leather\b/i, /\bgen\.\s*leather\b/i, /\bleath\b\.?/i,
];

/** Removes a phrase once, tolerating case and surrounding whitespace. */
export function removePhraseOnce(title: string, phrase: string): string {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return title.replace(new RegExp(`\\s*\\b${escaped}\\b`, "i"), " ");
}

/** Word-boundary-safe global replace that preserves the rest of the string. */
export function replaceWord(title: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return title.replace(new RegExp(`\\b${escaped}\\b`, "gi"), to);
}

/** Tidies spacing and punctuation without dropping information. */
export function tidy(title: string): string {
  return String(title ?? "")
    .replace(/[\s ]+/g, " ")
    .replace(/\s+([,;:.])/g, "$1")
    .replace(/([,;:])\s*(?=[,;:])/g, "")
    .replace(/\s*-\s*(?=\d)/g, "-")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/^[\s,;:.-]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}
