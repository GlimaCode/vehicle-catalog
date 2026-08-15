# Title review guide

The review workspace is where you decide what actually ships. Nothing is exported
as optimized until you accept it.

Open it from **Title optimizer → Title projects → *(project)***.

## What each row shows

| Column | Meaning |
|---|---|
| Row number | Position in the source file. Row order never changes. |
| Original Title | Exactly as uploaded. |
| Original Character Count | Unicode code points. |
| Proposed Title | Editable. |
| Proposed Character Count | Live, updates as you type. |
| Characters Removed | Original minus final. |
| Applied Rules | Every rule that fired, by ID. |
| Removed Information | Each phrase or field that was dropped, and why. |
| Preserved Information | The critical phrases that had to survive. |
| Validation Warnings | Conflicts, unrecorded years, unapproved hierarchy values. |
| Title Status | See below. |
| User Decision | What you chose. |
| Notes | Free text. |

## The character counter

Live, on every row, showing current characters, the maximum, characters
remaining, and how far over the limit you are. States:

- **Within limit** — under the maximum.
- **Exactly at limit** — precisely 80 characters. This is **valid**.
- **Over limit** — needs more work.

Rows also surface **critical information missing**, **conflict**, and **manual
review** through their status and warnings.

## Decisions

| Action | Effect |
|---|---|
| **Accept** | Approves the proposed title as final. |
| **Keep original** | Exports the original title unchanged. If a blocking warning (such as a Make–Model conflict) is still open, the row stays `Manual Review Required` rather than being marked clean. |
| **Save edit** | Saves your edited text. **Always revalidated** before it can be approved. |
| **Exclude** | Row is excluded; it exports with its original title and is counted separately. |
| **Regenerate…** | Re-runs the optimizer against a different template. |
| **Apply to similar** | Applies this row's final title to every row with an identical original title. |
| **Approve all within limit** | Batch-approves every row already inside the limit with no open warnings. |

## Manual edits are revalidated

An edited title is checked before it can be approved:

- over the limit → `Unable to Reach Limit`;
- missing a critical phrase → `Manual Review Required` with the reason;
- containing `Lthr`, `G. Leather` or any forbidden leather form → rejected with
  "Leather must not be abbreviated";
- confirmed `Genuine Leather` missing → flagged.

A clean edit becomes `Optimized`. The editor cannot be used to bypass a safety
rule.

## Filters

Only over limit · Only manual review · By status · By Make · By Model · Clear
filters. Filters combine, and paging keeps them.

Use **Only manual review** to work the exception queue: those are the rows where
a human decision genuinely changes the outcome.

## Exports

- **Export audit CSV / XLSX** — original Title untouched, optimization columns
  appended. This is the default and the safest choice.
- **Export replacement CSV** — the approved title replaces the mapped Title
  column. Nothing else changes.
- **Title optimization report** — an eleven-sheet workbook: Summary, Optimized
  Titles, Already Within Limit, Manual Review, Unable to Reach Limit, Excluded,
  Rule Usage, Abbreviation Usage, Template, Character Distribution, Validation
  Warnings.

## Audit trail

Every decision is written to `title_manual_decisions` with the original title,
the proposal, the final title, its length, the validation result, the template
used, your note and a timestamp. Every rule application is written to
`title_optimization_changes` with the before and after text and the characters
saved. You can always reconstruct why a title looks the way it does.

## What the workspace will not let you do

- Ship a title over the limit while calling it optimized.
- Approve an edit that drops critical information without being told.
- Abbreviate Leather.
- Change any column other than Title.
- Reorder or delete source rows.
- Modify the canonical vehicle catalog.
