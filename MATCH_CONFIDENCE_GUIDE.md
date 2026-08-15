# Match confidence guide

Every normalized field carries one confidence level.

| Confidence | Meaning | Applied automatically? |
|---|---|---|
| `Exact Canonical Match` | The raw value is character-for-character the canonical value. | **Yes** |
| `Approved Alias Match` | Resolved through an approved catalog alias or grouped-model relationship (e.g. `Excrision` → `Excursion`). | **Yes** |
| `Deterministic Normalization` | Differs only by case, spacing, punctuation or hyphenation (`ford` → `Ford`, `F150` → `F-150`, `Mercedes Benz` → `Mercedes-Benz`). | **Yes** |
| `High Confidence Suggested Match` | A close near-match (small edit distance) against the canonical list. | No — opt-in toggle per project, **off by default** |
| `Low Confidence Suggested Match` | A weaker near-match, or several similar candidates. | No |
| `No Match` | Nothing in the canonical catalog corresponds to this value. | No |
| `Conflict` | The value contradicts the catalog: cross-brand (`Chevrolet` + `Escalade`), wrong classification (a Drivetrain in a Trim column), or ambiguous across Makes. | No |

## How matching works

- Comparison is case-, space-, punctuation- and hyphen-insensitive, but `+` is significant
  (`RX 450h` and `RX 450h+` are different vehicles).
- Near-matches use edit distance with length-aware thresholds; a 1-character difference on a
  reasonably long value is *High*, a looser match is *Low*.
- Model resolution happens inside the resolved Make. Without a Make, a model name is only
  accepted when it is unique across the entire catalog; otherwise it becomes a `Conflict`.
- Hierarchy resolution happens inside the resolved Make **and** Model. If the value is
  actually an approved configuration attribute, the result is a `Conflict` that names the
  real classification instead of a wrong Trim.

## Year statuses

`Valid`, `Partially Valid`, `Outside Confirmed Range`, `Invalid Format`, `Missing`,
`Manual Review Required`.

Years are validated against the resolved Make–Model, and against the resolved hierarchy
value when one was applied (a trim available 2017–2019 does not validate a 2010 row).
Invalid years are never silently removed.
