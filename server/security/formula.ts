/**
 * Spreadsheet formula-injection protection.
 *
 * Uploaded text that begins with =, +, -, @, tab or carriage return is
 * evaluated as a formula by Excel/Sheets/LibreOffice when it lands in an
 * exported file. We keep the *displayed text* intact but make it inert:
 *
 *   - XLSX: the cell is written as an explicit string cell with the "@" (text)
 *     number format. A string cell has no <f> element, so Excel, Sheets and
 *     LibreOffice display the text literally and never evaluate it. The
 *     displayed text is therefore byte-identical to what the user uploaded.
 *   - CSV: there is no cell type to rely on, so the value is prefixed with an
 *     apostrophe, which spreadsheet importers treat as a literal-text marker.
 *
 * `neutralize()` below implements the CSV form. The XLSX form is applied by the
 * exporters (see standardize/exports.ts), which use `needsNeutralizing()` to
 * decide which cells to force to text.
 *
 * Legitimate values are never touched:
 *   - real numbers, including negatives (-5, -12.5, 1e6),
 *   - trusted numeric year cells written by the application,
 *   - application-generated hyperlinks in known source-URL fields.
 */
import { loadConfig } from "../config.js";

const RISKY_START = /^[=+\-@\t\r]/;
/** Numbers (incl. negative/decimal/exponent/currency/thousands) stay untouched. */
const NUMERIC = /^[-+]?[$£€]?\s?\d{1,3}(,\d{3})*(\.\d+)?([eE][-+]?\d+)?%?$/;
const DATEISH = /^[-+]?\d{1,4}[-/]\d{1,2}([-/]\d{1,4})?$/;

export interface NeutralizeResult { value: string; neutralized: boolean }

export function needsNeutralizing(value: unknown, opts: { trusted?: boolean } = {}): boolean {
  const cfg = loadConfig();
  if (!cfg.exportSecurity.formulaInjectionProtection) return false;
  if (opts.trusted) return false;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return false;
  const s = String(value);
  if (!s) return false;
  if (!RISKY_START.test(s)) return false;
  if (NUMERIC.test(s.trim())) return false;      // -12.5 is a number, not a formula
  if (DATEISH.test(s.trim())) return false;      // -2020/01 style values
  return true;
}

/** Neutralize a single value for export. */
export function neutralize(value: unknown, opts: { trusted?: boolean } = {}): NeutralizeResult {
  if (!needsNeutralizing(value, opts)) {
    return { value: value == null ? "" : String(value), neutralized: false };
  }
  return { value: `'${String(value)}`, neutralized: true };
}

/** True when a column holds application-generated, trusted hyperlinks. */
export function isTrustedHyperlinkField(header: string): boolean {
  const cfg = loadConfig();
  return cfg.exportSecurity.trustedHyperlinkFields
    .some((f) => f.toLowerCase() === header.toLowerCase());
}

/**
 * Neutralize a whole row of exported values.
 * Returns the safe values plus how many cells were neutralized, so exports can
 * report `Formula Injection Protection Applied`.
 */
export function neutralizeRow(headers: string[], values: unknown[],
  trustedHeaders: Set<string> = new Set()): { values: string[]; neutralizedCount: number;
    neutralizedColumns: string[] } {
  let count = 0;
  const columns: string[] = [];
  const out = values.map((v, i) => {
    const header = headers[i] ?? "";
    const trusted = trustedHeaders.has(header) || isTrustedHyperlinkField(header);
    const r = neutralize(v, { trusted });
    if (r.neutralized) { count++; columns.push(header); }
    return r.value;
  });
  return { values: out, neutralizedCount: count, neutralizedColumns: columns };
}
