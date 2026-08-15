# Title Optimizer guide

The Title Optimizer shortens automotive listing titles to a maximum length
without losing fitment or product identity. It is a separate module: it reads the
canonical vehicle catalog but never modifies it, and it changes nothing in your
file except the column you map as **Title**.

## The one rule that matters most

**Only the mapped Title value is ever modified.** These are read to build and
validate the title, and are returned exactly as supplied:

Item ID · SKU · Make · Model · Sub-model · Trim · Year · Year Range · Material ·
Color · Variation · Quantity · Position · Side · Row · Product Type · every
custom source column.

If a column is not mapped as Title, its value in your exported file is
byte-for-byte what you uploaded.

## Character counting

The limit is **80 Unicode code points** by default, configurable per project
(`title.maxCharacters` in `config/app-config.json`).

- Counting uses **code points**, not UTF-8 bytes. `Sitzbezüge für Fahrer` is 21
  characters even though it occupies more bytes.
- An emoji or CJK character counts as **one** character. `AB🚗CD` is 5.
- Pixel width is **not** used. A title of narrow characters and a title of wide
  characters are measured identically.
- A title of **exactly 80 characters is valid** — the limit is inclusive.

Every row reports the original count, the optimized count, how many characters
were removed, and a validation status.

## Statuses

| Status | Meaning |
|---|---|
| `Already Within Limit` | The title was already inside the limit and needed no change. |
| `Optimized` | Shortened to within the limit with no warnings. |
| `Optimized with Warning` | Within the limit, but something needs your attention. |
| `Manual Review Required` | Automatic optimization was blocked or a check failed. A Make–Model conflict always lands here. |
| `Unable to Reach Limit` | Still over the limit. Reaching it would have required removing information the rules protect. |
| `Excluded` | You excluded the row; it is exported with its original title. |

A title is **never** described as optimized when it is still over the limit, when
critical information was removed, when a Make–Model conflict remains, when an
unresolved hierarchy value was inserted, or when it needs manual review.

## Information-preservation priority

When a title must be shortened, information is given up in this order — lowest
priority first — unless the project's template defines its own:

1. Year or Year Range
2. Make
3. Model
4. Product Type
5. Position, Side, or Row
6. Material
7. Color
8. Variation
9. Quantity
10. Trim or Sub-model (when needed for fitment)
11. Secondary descriptive wording

A higher-priority field is never removed to keep a lower-priority marketing
phrase. In practice **Year, Make, Model, Product Type, Material, Color and
Variation are never removed automatically at all** — only Trim, Sub-model,
Position, Side, Row, Quantity and trailing descriptive wording are candidates,
and every removal is recorded.

## Always preserved

When present in the original title or a mapped field:

valid year or year range · standard Make · standard Model · Material · Color ·
product Variation · Driver or Passenger · Front, Rear, 1st Row, 2nd Row, 3rd Row ·
Bottom, Top, Lean Back, Backrest, Cushion, Armrest, Headrest · Quantity where it
changes the product meaning · genuine material designation · meaningful Model
identifiers that are part of the canonical Model · anything needed to tell this
product apart from another.

If a candidate title would drop any of these, it is rejected and the original is
kept.

## Leather

`Leather` and `Genuine Leather` are **never abbreviated**. `Lthr`, `Lthr.`,
`G. Leather` and `Gen. Leather` are forbidden outputs, and the API refuses to
accept an abbreviation mapping whose full value contains "leather".

- `Genuine Leather` is preserved whenever the source confirms it.
- `Genuine` is never added unless the source says so.
- `Genuine Leather` is never downgraded to `Leather` to save characters.

If a title cannot reach the limit without weakening a confirmed material claim,
it is marked `Manual Review Required` or `Unable to Reach Limit` instead.

## Year normalization

Consecutive years are compressed; gaps are preserved.

| Input | Output |
|---|---|
| `2006 2007 2008` | `2006-2008` |
| `2006, 2007, 2008` | `2006-2008` |
| `2006 to 2008` | `2006-2008` |
| `2006 thru 2008` | `2006-2008` |
| `2006, 2008` | `2006, 2008` (unchanged — not contiguous) |
| `2006-2008; 2010` | `2006-2008, 2010` (gap kept) |
| `1999 2000 2001 2003` | `1999-2001, 2003` |

A candidate title that would change which model years are covered is rejected,
so a gap can never silently become a range. When Make and Model are available the
years are validated against the canonical relationship; years that are not
recorded produce a warning and are **left unchanged** rather than corrected.

## Make and Model

Canonical spelling is applied only on an **Exact Canonical Match**, **Approved
Alias Match**, **Deterministic Normalization**, or a value you explicitly
approved. Examples: `ford` → `Ford`, `Mercedes Benz` → `Mercedes-Benz`,
`F150` → `F-150`, `X Type` → `X-Type`.

A Make is never guessed. **A Make–Model conflict blocks automatic optimization
entirely** — the row keeps its original title, applies no rules, and is marked
`Manual Review Required`.

## Trim and hierarchy values

Only approved canonical hierarchy values are recognised. Unresolved Trim
candidates are never inserted into a title. Engine, Drivetrain, Body Style,
Package, Chassis and Generation are configuration attributes and are never
treated as a Trim or Model.

A Trim or Sub-model appears in an optimized title only when it was already in the
original title or a mapped field, is confirmed or approved, and is relevant to
fitment or identity.

## No hard truncation, ever

The optimizer never slices a string to 80 characters, never adds an ellipsis,
never deletes a partial word, and never removes text based on position. Every
character removed is attributable to a named rule, visible in the review
workspace and in the change report. When the rules run out, the row is flagged —
it is not cut.

## Audit versus Replacement mode

**Audit mode is the default.** It leaves your Title column exactly as it was and
appends: `Original Title`, `Optimized Title`, `Original Character Count`,
`Optimized Character Count`, `Characters Removed`, `Title Optimization Status`,
`Applied Title Rules`, `Title Optimization Notes`.

**Replacement mode** writes the approved title into the mapped Title column and
changes nothing else. Excluded rows keep their original title in both modes.

Both modes apply the Version 5.1 formula-injection protection: a title beginning
with `=`, `+`, `-`, `@`, tab or carriage return is neutralised so a spreadsheet
cannot execute it. In CSV that adds a leading apostrophe (a transport marker that
spreadsheets strip on import, and which does not count towards the character
limit); in XLSX the cell is written as explicit text.

## How title rules stay separate from canonical data

Title rules, templates and abbreviations live in their own tables
(`title_rules`, `title_templates`, `title_abbreviation_mappings`, …). They are
project configuration. Abbreviating `Driver` to `Drv` in a title never rewrites a
Make, Model, hierarchy value, alias or model year, and never changes the value
stored in your Color or Material column. The canonical tables remain protected by
27 read-only database triggers, and nothing in this module can unlock them.

## Related guides

- `TITLE_TEMPLATE_GUIDE.md` — templates and field priority
- `TITLE_RULES_GUIDE.md` — every rule, by stage
- `TITLE_ABBREVIATION_GUIDE.md` — allowed and forbidden abbreviations
- `TITLE_REVIEW_GUIDE.md` — the review workspace
