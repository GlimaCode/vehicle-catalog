/** Quick behavioural check of the optimizer against representative titles. */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optimizeTitle } from "../server/title/optimizer.ts";
import { createCanonicalLookup } from "../server/title/canonical.ts";
import { titleLength } from "../server/title/text.ts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new Database(path.join(APP, "data", "catalog-v6.db"), { readonly: true });
const canonical = createCanonicalLookup(db);
const abbreviations = db.prepare(`SELECT full_value "full", abbreviated_value abbreviated,
  applicable_field applicableField, minimum_characters_saved minimumCharactersSaved,
  ambiguity_risk ambiguityRisk, approval_status approvalStatus
  FROM title_abbreviation_mappings WHERE project_id IS NULL`).all();

const CASES = [
  { label: "long marketing title", fields: {
    Title: "Brand New High Quality Replacement Seat Cover Seat Cover For Fits 2006 2007 2008 ford F150 XLT Driver & Passenger Bottom Genuine Leather Black Custom Fit",
    Make: "ford", Model: "F150", Material: "Genuine Leather", Color: "Black",
    "Product Type": "Seat Cover", Position: "Bottom" } },
  { label: "same title, Trim mapped (stage 5 may drop it)", fields: {
    Title: "Brand New High Quality Replacement Seat Cover Seat Cover For Fits 2006 2007 2008 ford F150 XLT Driver & Passenger Bottom Genuine Leather Black Custom Fit",
    Make: "ford", Model: "F150", Trim: "XLT", Material: "Genuine Leather",
    Color: "Black", "Product Type": "Seat Cover", Position: "Bottom" } },
  { label: "already within limit", fields: {
    Title: "2006-2008 Ford F-150 Driver Bottom Leather Seat Cover Black",
    Make: "Ford", Model: "F-150", Material: "Leather", Color: "Black" } },
  { label: "non-contiguous years", fields: {
    Title: "Fits 2006, 2008 Chevrolet Silverado 1500 Driver Bottom Vinyl Seat Cover Gray",
    Make: "Chevrolet", Model: "Silverado 1500", Material: "Vinyl", Color: "Gray" } },
  { label: "make-model conflict", fields: {
    Title: "2012 Ford Escalade Driver Bottom Leather Seat Cover Black",
    Make: "Ford", Model: "Escalade", Material: "Leather", Color: "Black" } },
  { label: "genuine leather cannot shrink", fields: {
    Title: "Replacement 2015-2020 Mercedes Benz Sprinter 2500 Passenger Bottom Genuine Leather Seat Cover Medium Parchment Tan With Armrest",
    Make: "Mercedes Benz", Model: "Sprinter 2500", Material: "Genuine Leather",
    Color: "Medium Parchment Tan" } },
];

for (const c of CASES) {
  const r = optimizeTitle(c.fields, { maxCharacters: 80, abbreviations, canonical });
  console.log(`\n--- ${c.label}`);
  console.log(`  before (${r.originalLength}): ${r.originalTitle}`);
  console.log(`  after  (${r.proposedLength}): ${r.proposedTitle}`);
  console.log(`  status : ${r.status}  removed=${r.charactersRemoved}`);
  console.log(`  rules  : ${r.appliedRules.map((a) => a.ruleId).join(", ") || "none"}`);
  if (r.validationWarnings.length) {
    console.log(`  warn   : ${r.validationWarnings.join(" | ")}`);
  }
  if (titleLength(r.proposedTitle) > 80 && r.status !== "Unable to Reach Limit"
      && r.status !== "Manual Review Required") {
    console.log("  *** INVARIANT VIOLATION: over limit but not flagged");
  }
}
db.close();
