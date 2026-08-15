# Title template guide

A template defines the preferred field order for a title, which fields must
survive, and which may be dropped when the title is too long. Templates are
project configuration and never modify the canonical catalog.

Manage them at **Title optimizer → Title templates**.

## Anatomy

| Property | Meaning |
|---|---|
| Name | Unique label. |
| Pattern | Field placeholders in the preferred order, e.g. `{Year Range} {Make} {Model}`. |
| Required fields | Never removed by stage 5, whatever the priority order says. |
| Optional fields | May be removed, lowest priority first, when the title is over the limit. |
| Field priority | The order information is given up in — last entry goes first. |
| Default | Applied to new projects unless another template is chosen. |

## Bundled templates

**Standard Fitment** (default)
```
{Year Range} {Make} {Model} {Position} {Material} {Product Type} {Color}
```
Required: Year Range, Make, Model.
General-purpose, fitment-first.

**Variation Focus**
```
{Year Range} {Make} {Model} {Variation} {Material} {Color}
```
Required: Year Range, Make, Model, Variation.
For catalogs where the variation identifies the product.

**Quantity First**
```
{Quantity} {Position} {Material} {Product Type} {Year Range} {Make} {Model} {Color}
```
Required: Quantity, Product Type, Year Range, Make, Model.
For multi-piece kits where quantity changes the product meaning.

## Default field priority

Used when a template does not define its own. Stage 5 removes from the bottom up:

1. Year Range
2. Make
3. Model
4. Product Type
5. Position
6. Side
7. Row
8. Material
9. Color
10. Variation
11. Quantity
12. Trim
13. Sub-model
14. Other

Regardless of this order, **Year, Year Range, Make, Model, Product Type,
Material, Color and Variation are never removed automatically**. Marking a field
required adds protection; it never removes protection.

## What you can do

- **Create** a template with your own pattern, required fields and priority.
- **Duplicate** an existing one — the original is untouched, the copy is named
  `<name> (copy)` and records where it came from.
- **Choose a default** — exactly one template is the default at a time.
- **Preview** the result before saving; the editor shows a worked example with a
  live character count.
- **Apply to one project** — a template is selected when you process a project,
  and a single row can be regenerated against a different template from the
  review workspace.

## How a template affects optimization

A template does **not** rebuild the title from its fields. The optimizer never
invents text, so it cannot assemble a title from data that was not there. What a
template changes is:

1. which fields stage 5 is allowed to remove (`optional`, and not `required`);
2. the order in which they are given up (`priority`).

This is deliberate: constructing a title from mapped fields would mean adding
information the original listing did not carry, which the safety rules forbid.

## Regenerating a row

In the review workspace, **Regenerate…** re-runs the optimizer for one row with a
different template. The new proposal replaces the previous one and is revalidated
against the same safety rules. The original title is never lost — it stays in
`original_title` and in the audit export.
