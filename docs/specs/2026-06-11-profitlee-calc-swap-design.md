# Design: Swap inline FBA math for the Profitlee calc API

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation
**Scope:** Surgical — Phase 3 only. Phases 1, 2, 4 unchanged.

## Problem

Phase 3 of the skill currently computes FBA profitability with an ~80-line
`node -e` script pasted inline into each run. That script reimplements the FBA
fee table, size-tier rules, fuel surcharge, storage, and return-loss math by
hand. It has drifted from the authoritative engine and is bug-prone — the most
recent run shipped margins as decimals into a template that expects whole
percentages, rendering 0.3% instead of 26%.

Meanwhile the Profitlee app (`ecom-calculator`) exposes the same math as a
tested, maintained engine behind a stateless endpoint:
`POST https://profitlee.com/api/calculate`. It is strictly more accurate than
the inline script: it correctly zeroes optimized inbound, applies the 3.5% US
fuel surcharge, models unsellable returns, and resolves effective referral
rates. Verified live this session (HTTP 200, full `CalcOutputs`).

## Goal

Replace the inline Phase 3 math with calls to the Profitlee API, so margins
come from one tested source. Improve structure by moving the per-run logic into
a committed helper script instead of a pasted blob.

## In scope

- New `calc.mjs` helper in the skill directory.
- Rewrite SKILL.md Phase 3 to invoke it.
- Delete the hand-rolled fee table / size-tier / storage math from SKILL.md.
- Bearer-token auth wiring + one-time token setup in `~/.claude/settings.json`.

## Out of scope (noted future work)

- **Referral-category accuracy.** The API accepts a `referralCategory` slug and
  resolves the effective Amazon rate from category + price. We keep the flat
  `referralPct: 0.15` for now. Upgrading would add a per-run category input;
  deferred.
- Any change to Phases 1, 2, 4 (Amazon scrape, 1688 image search, report
  template). The browser automation is the real time cost but the user scoped
  this pass to the calc only.

## Endpoint

`POST https://profitlee.com/api/calculate` (deployed production).
Chosen over localhost so the skill works with zero local setup, independent of
whether the `ecom-calculator` dev server is running. Math is pinned to whatever
is last deployed to production.

## Authentication

Token stored once in `~/.claude/settings.json`:

```json
{ "env": { "PROFITLEE_API_TOKEN": "<token>" } }
```

The harness injects this into every Bash-spawned process. `calc.mjs` reads
`process.env.PROFITLEE_API_TOKEN` and sends `Authorization: Bearer <token>` on
each POST.

**Handling rules:**
- Token value is never printed to transcript/logs. Presence is verified only
  via a non-revealing probe:
  `node -e "console.log(process.env.PROFITLEE_API_TOKEN ? 'PRESENT' : 'MISSING')"`.
- Never committed (lives outside any repo).
- **Missing-token behavior:** `calc.mjs` hard-stops before any network call with
  a clear message pointing to SKILL.md → Setup.
- **Activation timing:** settings.json env is injected at session start; a
  freshly-added token may need the next turn or a session restart to appear.
  Confirm with the presence-probe before the first real run.
- **Forward-compat:** the endpoint is currently open, so the bearer header is
  ignored until auth is enabled on `/api/calculate`; the skill then
  authenticates with no further change.

## calc.mjs design

**Invocation:** `node calc.mjs <run-dir> "<keyword>"`

**Reads:** `<run-dir>/products.json`, `<run-dir>/fob.json`.

**Per-product request payload** (one POST each, all fired in parallel via
`Promise.all`):

| Payload field | Source |
|---|---|
| `mode` | `"fba"` |
| `region` | `"us"` |
| `L, W, H` | `products.json` `dim` |
| `weight` | `products.json` `weight` |
| `fob` | `fob.json` `fobUsd` |
| `headShip` | `0.5 × shipWeight` — small local geometry calc retained only to derive this placeholder |
| `duty` | `fobUsd × 0.075` |
| `price` | `products.json` |
| `monthlyVolume` | `products.json` |
| `ppcAcos` | `0.20` |
| `returnRate` | `0.05` |
| `referralPct` | `0.15` |
| `isApparel` | `false` |
| `inboundOption` | `"optimized"` |
| `storageMonths` | `1` |
| `storageSeason` | `"janSep"` |

`headShip` still needs a numeric input the API can't infer, so `calc.mjs`
computes `dimWeight = max(L,2)·max(W,2)·max(H,2)/139`,
`shipWeight = max(weight, dimWeight)`, then `headShip = 0.5 × shipWeight`. This
is the only physics retained locally; the fee tables are gone.

**Response → results.js field mapping** (from `outputs`):

| results.js field | API output | Transform |
|---|---|---|
| `landedCogs` | `landedCogs` | — |
| `inboundFee` | `inboundFee` | — |
| `fulfillmentFee` | `fulfillmentFee` | — |
| `referralFee` | `referralFee` | — |
| `storageFee` | `storageFee` | — |
| `totalCost` | `totalCost` | — |
| `grossProfit` | `grossProfit` | — |
| `grossMargin` | `grossMargin` | **×100** (template renders whole %) |
| `ppcCost` | `ppcCostPerUnit` | rename |
| `returnLoss` | `returnLossPerUnit` | rename |
| `netProfitAfterPPC` | `netProfitAfterPPC` | — |
| `netMarginAfterPPC` | `netMarginAfterPPC` | **×100** (template renders whole %) |
| `monthlyNetAfterPPC` | `monthlyNetAfterPPC` | — |
| `shipWeight` | `shipWeight` | — |
| `tier` | `sizeTier` | rename |

Passthrough from inputs: `asin, title, amazonUrl, imageUrl, price,
monthlyVolume, volumeSource, fobRmb, fobUsd, fobSource, sellerUrl, dim`.

**The margin gotcha:** the API returns margins as decimals (`0.2907`);
`report-template.html` renders with `.toFixed(1)+'%'`, expecting whole numbers.
`calc.mjs` multiplies the two margin fields by 100 so the template stays
untouched (it is Phase 4, out of scope). This perpetuates a results.js contract
of whole-number percents — noted as a wart, not fixed here.

**Selection logic (unchanged):**
1. Survivors = products with `netProfitAfterPPC > 0`.
2. Sort survivors by `netMarginAfterPPC` desc, then `monthlyNetAfterPPC` desc.
3. Badge top 3 with `netMarginAfterPPC ≥ 15` (whole-percent units) as
   Recommended (`badge: 1|2|3`).
4. Eliminated = the rest.

**Output:** writes `<run-dir>/results.js` with the existing
`window.__FBA_DATA__ = { keyword, date, assumptions, survivors, eliminated,
retried, initialSurvivors, retrySurvivors, marketInsight }` shape.

**Error handling:** margins are the whole point, so a failed call must not
silently drop a product. `calc.mjs` collects per-product failures (network
error, non-200, validation rejection) and **hard-stops** with the list,
writing no partial results.js — consistent with the skill's no-fallback
philosophy.

## SKILL.md changes

- Phase 3 (§3.1–§3.6) collapses to: build/confirm `products.json` + `fob.json`
  exist, then `node calc.mjs <run-dir> "<keyword>"`.
- Delete the US fulfillment fee table, size-tier rules, and storage/fuel math
  (now owned by Profitlee).
- Add a one-time **Setup** section: how to put `PROFITLEE_API_TOKEN` into
  `~/.claude/settings.json` and the presence-probe to verify.

## Behavior change to expect

Reported numbers shift slightly vs the old inline math — upward in the
storage-basket case (top pick ~29.1% net vs the buggy 26.0%) because the API
zeroes optimized inbound and models unsellable returns correctly. This is the
intended accuracy improvement.

## Verification

- Presence-probe shows `PRESENT` for the token.
- Re-run `calc.mjs` against the existing `storage-basket` run dir; confirm
  `results.js` populates, margins render as sane whole-percent values in the
  report, survivor count and ordering are reasonable, and a deliberately broken
  token / unreachable host produces the hard-stop message rather than a partial
  file.

## Files

- **New:** `<skill-dir>/calc.mjs`
- **Edit:** `<skill-dir>/SKILL.md` (Phase 3 + Setup)
- **Edit (one-time, user data):** `~/.claude/settings.json` (token)
- Skill dir is not a git repo; no commit step.
