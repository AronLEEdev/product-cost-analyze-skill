# Design: Cost inputs (single inbound, flat head-ship, zero duty) + report cost-stack split

**Date:** 2026-06-17
**Status:** Approved (design), pending implementation
**Scope:** `calc.mjs` (inputs it sends + fields it passes through) and
`report-template.html`. No Profitlee API change — the skill owns FOB / head-ship
/ duty as inputs; the API computes results from them.

## Changes to cost inputs (calc.mjs)

The skill sends these to `POST /api/calculate`; the API returns the cost stack.

| Input | Old | New |
|---|---|---|
| `fob` | `fobUsd × packCount` | unchanged |
| `headShip` | `0.5 × shipWeight` | **`0.30 × packCount`** ($0.30 per single unit) |
| `duty` | `fob × 0.075` | **`0`** (default) |
| `inboundOption` | `"optimized"` | **`"single"`** |

`CONSTANTS` gains `headShipPerUnit: 0.30`, sets `inboundOption: "single"`, and
duty becomes a flat `0` (drop the `dutyRate` multiply; keep `dutyRate: 0` in the
assumptions object for display). Rationale: `single` inbound (~$0.37/unit) is the
honest fee for a single-FC seller (optimized assumes multi-FC spread → $0); the
$0.30/unit head-ship and $0 duty are sensible planning defaults the user set.

## Fields passed through to results.js (calc.mjs mapOutputs)

Add the two missing COGS components so the report can show them separately
(FOB is already `fobUsdPerListing`):
- `headShip` (= `0.30 × packCount`)
- `duty` (= `0`)

Existing API-sourced fields stay: `landedCogs`, `inboundFee`, `fulfillmentFee`,
`referralFee`, `storageFee`, `totalCost`. Keep `fobUsdPerListing` as the FOB row.

**Consistency check:** `fobUsdPerListing + headShip + duty` must equal the API's
`landedCogs` (within rounding); calc.mjs logs a warning if they diverge (guards
against the inputs and the API drifting apart).

## Report cost stack (report-template.html)

Replace the single `Landed COGS (FOB + Ship + Duty)` row with separate per-listing
rows, in order:

1. FOB (`fobUsdPerListing`)
2. Head-shipping (`headShip`)
3. Duty (`duty`)
4. FBA Inbound (single) (`inboundFee`)
5. FBA Fulfillment (`fulfillmentFee`)
6. Referral (`referralFee`)
7. Storage (`storageFee`)
8. **Total Cost** (`totalCost`)

The "FBA Inbound" row label changes from "(Optimized)" to "(single)".

## Net-margin label

The metric currently labeled "Net Margin (post-PPC)" maps from the API's
`netMarginAfterPPC`, which the engine computes as
`grossProfit − ppcCost − returnLoss` — i.e. it already nets out returns. Relabel
it **"Net after PPC + returns"** for accuracy. Value/logic unchanged.

## Assumptions footer

Update the footer text to reflect the new defaults:
`FOB rate ¥7.2/$1 · Duty 0% · Head-ship $0.30/unit · Inbound: single · Jan–Sep
storage · ACoS 20% · Return 5% · Referral 15% · FBA 2026 + 3.5% fuel surcharge.`
(Drop the stale "Head-haul $0.50/shipWeight-lb" and "Inbound 'optimized' ($0.27)"
and "Duty 7.5%".) The calc.mjs `assumptions` object gains `headShipPerUnit: 0.30`
and `inboundOption: "single"`, and `dutyRate: 0`.

## Behavior change to expect

Margins drop slightly vs the prior run: `single` inbound adds ~$0.37/unit, the
flat $0.30/unit head-ship usually exceeds the old `0.5×shipWeight` for light
items, and duty goes to 0 (a small offset). Net effect is product-specific but
generally a few points lower. Re-running portable-fly-fan should show the cost
stack with separate FOB/head-ship/duty rows and the relabeled net margin.

## Tests (calc.test.mjs)

- Update the existing buildPayload pack test: `duty` is now `0`; `headShip` is
  `0.30 × packCount` (not `0.5 × shipWeight`).
- New assertions: `buildPayload` sends `inboundOption: "single"`,
  `headShip === 0.30 × packCount`, `duty === 0`.
- `mapOutputs` carries `headShip` and `duty`.

## Files

- **Edit:** `calc.mjs` (CONSTANTS, buildPayload, mapOutputs, assumptions, consistency check)
- **Edit:** `calc.test.mjs`
- **Edit:** `report-template.html` (cost-stack rows, inbound label, net-margin label, assumptions footer)
- Skill dir is not a git repo; no commit step.
