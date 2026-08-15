# Review workflow guide

The **Review matches** page lists every row whose values could not be applied
automatically, with the original value, the suggested canonical value, the confidence, the
conflict reason, alternative candidates and the supporting evidence.

## Decisions

| Decision | Effect |
|---|---|
| `Accept Suggestion` | Apply the suggested canonical value to this row. |
| `Keep Original` | Keep the source value unchanged; the row stops asking for review. |
| `Select Different Match` | Type/choose a different canonical value. |
| `Mark as Unknown` | Clear the value; the field exports blank in the standardized column. |
| `Exclude From Export` | Keep the row in the project but leave it out of the exported file. |
| `Apply to All Identical Values` | Apply the decision to every row with the same raw value. |

Every decision is written to `standardization_changes` with the original value, the new
value, the change source, the confidence and a timestamp, and appears in the project
audit log and the change report.

## Apply to All Identical Values

Before anything is applied you are shown **how many rows will be affected** and must
confirm. Matching is case-, space- and punctuation-insensitive, so `ford`, `Ford` and
`FORD` are treated as the same raw value.

The decision is stored in `project_value_mappings` — a **project-scoped** table. It is
reused automatically the next time the project is reprocessed, and it never touches the
canonical catalog.

## Rows and outcomes

A row leaves the review queue when every one of its flagged fields has a decision. The
project outcome is recalculated continuously:

- `Review Required` — at least one row still needs a decision.
- `Partially Standardized` — no pending reviews, but unmatched Makes/Models/hierarchy values remain.
- `Standardized with Warnings` — everything matched, but some year relationships are outside the confirmed ranges.
- `Standardized` — everything resolved with no warnings.

Exporting is always allowed, but the outcome badge and the change report state the real
status. A file with unresolved conflicts is never described as `Standardized`.
