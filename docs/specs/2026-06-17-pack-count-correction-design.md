# Design: Pack-count correction (both ends)

**Date:** 2026-06-17
**Status:** Approved (design), pending implementation
**Scope:** Phase 1 (Amazon pack), Phase 2 (1688 set size), Phase 3 (calc.mjs),
report template. Profitlee engine unchanged.

## Problem

Amazon listings are usually multipacks (e.g. a 4-pack at one price), but the
1688 image match is priced per single unit (verified live: a matched offer was
`1件起批`, ¥6.16/piece). The calc charged 1× per-unit FOB against an N-pack
retail price, inflating every margin. Recomputing the "portable fly fan" run with
the correct basis roughly halved net margins and flipped one product
(B0DWMX9WCY) from 30.5% to 0.7% — it would have been wrongly greenlit.

## Cost model

Landed COGS basis per Amazon listing:

```
fobPerUnitUsd = (1688 median price ÷ cnPack) ÷ 7.2
landedCogsBasisFob = fobPerUnitUsd × amazonPackCount
```

- **amazonPackCount** — units per Amazon listing (Phase 1).
- **cnPack** — units the matched 1688 offer's price covers (Phase 2); usually 1.

## Phase 1 — Amazon pack count

When writing products.json, parse the title and add:
- `packCount` (int, default `1`)
- `packSource` (`"title"` when a pattern matched, else `"default"`)

Patterns (case-insensitive): `N Pack`, `N-Pack`, `Npack`, `Pack of N`,
`Set of N`, `N pcs|pc|pieces|count`. No match → `packCount:1,
packSource:"default"` (a true single, or a missed pack — visible via packSource).

## Phase 2 — 1688 set size, card-level extraction

The §2.3 extraction becomes **card-level**: within each group root, iterate the
matched product cards (each has a `detail.1688.com/offer` link, a title, a
`priceMain`). Per card capture `{ title, price, offerUrl }`.

**cnPack detector** on the card title — Chinese set patterns:
`(\d+)\s*(个|只|支|件|台|条|包|盒|套|组)\s*装`, `(\d+)\s*件套`,
`(\d+)\s*(个|只|支|件)\s*[/／]\s*(套|包|盒|组)`, and Latin `(\d+)\s*(pcs?|pack)`.
Take the first number; default `1`. (`套装` / `套装` with no number → 1.)

**Normalize then median:** for each card, `perUnit = price / cnPack`; keep
`perUnit` in ¥2–80; the group's **per-single-unit FOB** = median of `perUnit`.
The chosen offer (first card / first detail link) supplies `sellerUrl`,
`matchedTitle`, and its `cnPack`.

fob.json gains `cnPack` and `matchedTitle`; `fobRmb` / `fobUsd` are now
explicitly **per single unit** (`fobUsd = fobRmb / 7.2`).

Extraction sketch (replaces the current price-only loop):

```js
function cnPackOf(title){
  const t = title || '';
  let m = t.match(/(\d+)\s*(?:个|只|支|件|台|条|包|盒|套|组)\s*装/)
       || t.match(/(\d+)\s*件套/)
       || t.match(/(\d+)\s*(?:个|只|支|件)\s*[\/／]\s*(?:套|包|盒|组)/)
       || t.match(/(\d+)\s*(?:pcs?|pack)/i);
  const n = m ? parseInt(m[1], 10) : 1;
  return (n >= 1 && n <= 50) ? n : 1;
}
// per group: collect cards -> {title, price, offerUrl};
// perUnit = price / cnPackOf(title); filter 2..80; median; first card -> seller/cnPack/title
```

## Phase 3 — calc.mjs

- `buildPayload`: `packCount = product.packCount || 1`;
  `fob = fobEntry.fobUsd * packCount`; `duty = fob * 0.075` (scales);
  `headShip` stays `0.5 × shipWeight` (listing ship weight, already per-pack).
- `mapOutputs`: keep `fobUsd` (per unit) and `fobRmb` (per unit); add
  `packCount`, `cnPack` (from `fobEntry.cnPack || 1`), and
  `fobUsdPerListing = +(fobEntry.fobUsd * packCount).toFixed(2)`.
- New unit test: a product with `packCount:4` sends `fob = fobUsd × 4`; default
  (no `packCount`) still sends `fob = fobUsd × 1` (existing tests keep passing).

## Report template

- **Pack tag** per card: `📦 {packCount}-pack` next to the brand tag (omit or show
  `single` when `packCount === 1`).
- **FOB chip made explicit.** When `cnPack > 1` or `packCount > 1`, render the
  basis, e.g.:
  `FOB ¥20 ÷ 4pcs = ¥5/unit ($0.69) × 4-pack = $2.76/listing`.
  When both are 1, keep the simple `FOB ¥5 ($0.69)`. This makes the chip agree
  with the cost-stack "Landed COGS" row (which already shows the per-listing
  number).

## Limits (accepted)

`cnPack` detection depends on the card title declaring the set; a set with a
vague title defaults to 1. `matchedTitle` + `cnPack` + the offer link are
surfaced in the report so the rare miss is catchable by eye. Auto-opening each
offer page for authoritative SKU parsing stays out of scope (it would undo the
batch speed win).

## Verification

- Unit tests pass (incl. the new pack-multiply test).
- Re-run the existing `portable-fly-fan` data through the corrected calc:
  margins drop to the corrected figures (e.g. B0BX56YNLQ ~34%, B0DWMX9WCY ~0.7%),
  survivor/badge set updates, report shows pack tags and the explicit FOB basis.
- A 1688 title like "4个装" normalizes to per-unit before the median.

## Files

- **Edit:** `SKILL.md` Phase 1 (products.json packCount) + Phase 2 (card-level
  extraction, cnPack, fob.json fields).
- **Edit:** `calc.mjs` (buildPayload multiply, mapOutputs fields) + `calc.test.mjs`.
- **Edit:** `report-template.html` (pack tag, FOB-basis chip).
- Skill dir is not a git repo; no commit step.
