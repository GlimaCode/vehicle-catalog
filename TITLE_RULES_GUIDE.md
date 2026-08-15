# Title rules guide

Rules run in deterministic stages. A stage only runs if the title is still over
the limit after the previous one, so a title that is already short enough is
cleaned but never compressed.

Manage rules at **Title optimizer → Rules & abbreviations**. Disabling a rule
takes effect on the next processing run.

## Stage 1 — clean without removing information

Always runs. Nothing here can lose information.

| Rule ID | What it does |
|---|---|
| `S1_TRIM` | Removes leading and trailing whitespace. |
| `S1_COLLAPSE_SPACES` | Collapses runs of whitespace (including embedded line breaks) to one space. |
| `S1_PUNCT_SPACING` | Removes spaces before `,` `.` `;` `:` and collapses duplicated punctuation. |
| `S1_REPEATED_PHRASE` | Removes a later exact repetition of a multi-word phrase. |
| `S1_YEAR_RANGE` | Compresses consecutive years into a range; gaps are preserved. |
| `S1_CANONICAL_MAKE` | Applies canonical Make spelling on an exact, alias or deterministic match only. |
| `S1_CANONICAL_MODEL` | Applies canonical Model spelling on the same basis. |
| `S1_DEDUPE_MAKE_MODEL` | Removes a second occurrence of the same Make or Model. |
| `S1_DEDUPE_MATERIAL` | Removes a repeated material word (`Leather Leather` → `Leather`). |
| `S1_DEDUPE_COLOR` | Removes a repeated color word. |

## Stage 2 — remove redundant wording

Runs only when the title is over the limit.

| Rule ID | What it does |
|---|---|
| `S2_DROP_FITS` | Drops `Fits` where the fitment is already stated by the years. |
| `S2_DROP_FOR` | Drops a `For` that adds no information. |
| `S2_DEDUPE_REPLACEMENT` | Keeps a single `Replacement`. The **last** one is never removed. |
| `S2_DROP_MARKETING` | Removes non-identifying filler: Brand New, High Quality, Premium Quality, Top Quality, Best Quality, Custom Fit, Perfect Fit, Hot Sale, Free Shipping, Fast Shipping, 100% New, Great Deal, New Arrival, Factory Style, OEM Style. |
| `S2_DEDUPE_PRODUCT_TYPE` | Collapses a repeated `Seat Cover` / `Upholstery` / `Cover` / `Seat` phrase, keeping one. |

`Replacement` is never removed outright — it distinguishes a replacement
upholstery component from a complete seat or a universal cover.

## Stage 3 — compact separators

| Rule ID | What it does |
|---|---|
| `S3_PAIR_SLASH` | `Driver & Passenger` → `Driver/Passenger`; also Top/Bottom, Left/Right, Front/Rear (and their reverses). |
| `S3_DECORATIVE` | Removes decorative `*`, `!`, `~`, `\|` and runs of dashes. |
| `S3_COMMAS` | Removes commas that separate already-delimited attributes. **A comma between two years is kept** — it marks a fitment gap. |
| `S3_AMPERSAND` | Replaces the word `and` with `&` between two noun phrases. |
| `S3_HYPHENS` | Normalizes spaced hyphens and en/em dashes in ranges. |

## Stage 4 — approved abbreviations

`S4_ABBREVIATE` applies approved abbreviations, **lowest ambiguity risk first**,
and stops the moment the title fits. Full words are always preferred while the
title is within the limit. Leather is excluded from this stage entirely. See
`TITLE_ABBREVIATION_GUIDE.md`.

## Stage 5 — controlled optional-field removal

`S5_DROP_OPTIONAL` is the only rule that removes a mapped field, and it is marked
**destructive** in the rule catalog. It walks the field priority from the lowest
priority upward and removes one field at a time, stopping as soon as the title
fits.

These are **never** removed automatically, regardless of priority order:

Year · Year Range · Make · Model · Product Type · Material · Color · Variation

A field is also skipped if the template marks it required, or if removing it
would drop a critical phrase or change which model years are covered. Every
removal is recorded in `removed_information` and in the change report.

## Stage 6 — manual review

If the title is still over the limit, the row is marked `Unable to Reach Limit`
or `Manual Review Required`. Nothing is truncated, no word is cut, and no
critical field is sacrificed.

## Rule safety guarantees

After all stages run, the candidate title is checked. It is **rejected** and the
original kept if:

- a critical phrase is missing (Make, Model, Material, Color, Variation, or a
  Driver/Passenger/Front/Rear/Row/Bottom/Top/Backrest/Cushion/Armrest/Headrest
  designation that was in the original);
- the set of model years changed;
- confirmed `Genuine Leather` is missing;
- any forbidden leather abbreviation appears.

## Enabling and disabling

A rule can be disabled globally, or overridden for a single project. A project
override never changes the global catalog. Disabling `S2_DROP_MARKETING`, for
instance, keeps `Brand New` in every title of that project.
