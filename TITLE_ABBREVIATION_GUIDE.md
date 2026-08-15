# Title abbreviation guide

Abbreviations are **title-only**. Shortening `Driver` to `Drv` in a title never
changes the value stored in your Side, Position, Color or Material column, and
never touches the canonical catalog.

## When abbreviations are applied

- Only when the title is **over the limit** after stages 1–3.
- **Lowest ambiguity risk first**, then longest full value.
- **As few as necessary** — the moment the title fits, no further abbreviation is
  applied.
- Never when it would drop a critical phrase.
- Never below the mapping's minimum-characters-saved threshold.

Full words are always preferred while the title is within the limit. A title of
70 characters keeps `Driver`, `Passenger` and `Front` in full.

## Catalog fields

Every mapping records:

| Field | Meaning |
|---|---|
| Full value | The word or phrase as written. |
| Abbreviated value | The short form to emit. |
| Applicable field | `Any`, `Side`, `Position`, `Color`, … |
| Minimum characters saved | The abbreviation is skipped if it saves fewer. |
| Ambiguity risk | `Low`, `Medium`, `High` — drives the order of application. |
| Approval status | `Approved`, `Pending`, `Rejected`. Only `Approved` is used. |
| Notes | Why it is safe, or what to watch for. |

## Approved by default

| Full value | Abbreviated | Field | Min. saved | Risk |
|---|---|---|---|---|
| Without | `w/o` | Any | 4 | Low |
| With | `w/` | Any | 2 | Low |
| Passenger | `Pass` | Side | 5 | Low |
| Driver | `Drv` | Side | 3 | Low |
| Front | `Frt` | Position | 2 | Low |
| Rear | `Rr` | Position | 2 | Low |
| Medium | `Med` | Color | 3 | Low |
| Light | `Lt` | Color | 3 | Low |
| Dark | `Dk` | Color | 2 | Low |
| Black | `Blk` | Color | 2 | Low |
| Left | `LH` | Side | 2 | Medium |
| Right | `RH` | Side | 3 | Medium |

## Color handling

Safe title-only color forms:

| Color | Title form |
|---|---|
| Black | `Blk` |
| Grey | `Gray` (spelling normalization, not an abbreviation) |
| Dark Gray | `Dk Gray` |
| Light Gray | `Lt Gray` |
| Medium Gray | `Med Gray` |
| Gray, Tan, Beige, Brown, Red, Blue, White | unchanged |

**Complex and manufacturer-specific colors are never abbreviated automatically.**
These require an approved project mapping before they can be shortened:

Parchment Tan · Medium Parchment · Cashmere · Shale · Titanium Gray · Graphite ·
Neutral Shale · Camel · Saddle · Adobe · Cocoa · Ebony

If abbreviating a color could make two products indistinguishable, the full color
is preserved and the title is flagged instead.

## Forbidden abbreviations

**Leather is never abbreviated.** These outputs are forbidden and the optimizer
rejects any candidate title containing them:

`Lthr` · `Lthr.` · `G. Leather` · `Gen. Leather` · `Leath`

`POST /api/title/abbreviations` refuses any mapping whose full value contains
"leather", so the rule cannot be configured away.

Also never abbreviated:

- **Make and Model names**, unless the short form *is* the official canonical
  name. `Chevrolet` is not shortened to `Chevy`; `Mercedes-Benz` is not shortened
  to `MB`.
- Anything that would change fitment: Driver never becomes Passenger, Front never
  becomes Rear, Left never becomes Right, and a row position is never changed.

## Project-specific mappings

A project can add its own mapping without touching the global catalog. Project
entries override global ones of the same full value and field for that project
only. This is how you approve `Parchment Tan` → `Parch Tan` for one catalog
without applying it everywhere.

Project mappings are never promoted to canonical rules automatically.
