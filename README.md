# product-cost-analyze-for-fba

A Claude skill that turns a single product keyword into an Amazon-FBA
profitability report. Given a keyword, it drives the user's logged-in Chrome
(via the **Claude-in-Chrome MCP**) to:

1. **Phase 1 — Amazon:** capture the top ~10 listings in the $10–$50 band (ASIN,
   title, price, monthly volume from the "bought in past month" badge, image,
   pack count, dimensions).
2. **Phase 2 — 1688:** batch reverse-image-search all product images on 1688's
   image-sourcing tool to get a per-unit wholesale **FOB** reference + a seller
   link for each.
3. **Phase 3 — calc:** send each product to the **Profitlee** calc API and write
   `results.js` with the full FBA cost stack + margins.
4. **Phase 4 — report:** render a static HTML report from `results.js`.

The procedure lives in [`SKILL.md`](./SKILL.md). The calc helper is
[`calc.mjs`](./calc.mjs) (unit-tested in `calc.test.mjs`), and the report
renderer is [`report-template.html`](./report-template.html).

## Preconditions

See the table in [`SKILL.md`](./SKILL.md#preconditions--setup-read-once). In short:

| Requirement | Required? |
|---|---|
| Chrome + the Claude-in-Chrome MCP extension (connected) | ✅ |
| **1688.com** account, logged in | ✅ |
| **Profitlee** API token (see below) | ✅ |
| Node.js ≥ 18 · Python 3 (or any static server) | ✅ |
| Amazon — logged-in Chrome profile | recommended |
| Helium 10 extension | optional |

## Setup

```bash
# Node ≥ 18 and Python 3 must be on PATH (calc.mjs needs built-in fetch + node:test)
node --version && python3 --version

# Store the Profitlee API token once, in ~/.claude/settings.json:
#   { "env": { "PROFITLEE_API_TOKEN": "<your token>" } }
# Verify it's visible (never print the value):
node -e "console.log(process.env.PROFITLEE_API_TOKEN ? 'PRESENT' : 'MISSING')"

# Run the calc engine's tests:
node --test calc.test.mjs
```

---

## Profitlee Calc API

Phase 3 sends each product to Profitlee's stateless calculation endpoint and
uses the returned cost stack verbatim — the skill does **not** reimplement FBA
fee math. The engine is the single source of truth (US / DE / JP marketplaces).

> 📖 **Canonical API reference:** <https://profitlee.com/docs/api> — the summary
> below mirrors it; check the docs page for the authoritative, up-to-date schema.

### Endpoint

```
POST https://profitlee.com/api/calculate
Content-Type: application/json
Authorization: Bearer <PROFITLEE_API_TOKEN>
```

The endpoint is stateless (no rate limit, no cap). Send the bearer token on every
request; it is read from the `PROFITLEE_API_TOKEN` env var.

### Request body (Amazon FBA mode)

All money is USD, dimensions are US inches, weight is pounds. Rates are decimals
(`0.15` = 15%).

| Field | Type | Notes |
|---|---|---|
| `mode` | `"fba"` | (also supports `"fbm"`, and TikTok `"fbt"`/`"self_fulfilled"`) |
| `platform` | `"amazon"` \| `"tiktok_shop"` | optional, defaults to `"amazon"` |
| `region` | `"us"` \| `"de"` \| `"jp"` | marketplace |
| `L`, `W`, `H` | number > 0 | item dimensions (inches) |
| `weight` | number > 0 | item weight (lb) |
| `fob` | number ≥ 0 | landed unit cost ex-works, **per listing** (× pack count) |
| `headShip` | number ≥ 0 | head/freight shipping, per listing |
| `duty` | number ≥ 0 | import duty, per listing |
| `price` | number ≥ 0.01 | Amazon selling price |
| `monthlyVolume` | integer ≥ 0 | units/month (drives the monthly P&L) |
| `ppcAcos` | number 0–1 | advertising ACoS |
| `adSalesShare` | number 0–1 | optional, default `1` (share of sales that incur ACoS) |
| `returnRate` | number 0–1 | return rate |
| `unsellableReturnRate` | number 0–1 | optional, default `1` (share of returns written off) |
| `referralPct` | number 0–1 | manual referral rate (used when `referralCategory` is null) |
| `referralCategory` | string \| null | optional; when set, the effective rate is resolved from category + price and `referralPct` is ignored |
| `isApparel` | boolean | apparel fulfillment differences |
| `inboundOption` | `"optimized"` \| `"partial"` \| `"single"` | FBA inbound placement (`single` ≈ a real per-unit placement fee; `optimized` = $0) |
| `storageMonths` | number > 0 | months of storage to amortize |
| `storageSeason` | `"janSep"` \| `"octDec"` | storage-fee season |
| `moq`, `unitsPerCase` | integer > 0 \| null | optional; presentation-only, ignored by the math |

### Response

`200 OK` → `{ "outputs": CalcOutputs }`. Margins are decimals (`0.29` = 29%).

| Field | Meaning |
|---|---|
| `dimWeight`, `shipWeight` | dimensional weight, billable ship weight |
| `sizeTier` | Amazon size tier (e.g. `"Large Standard"`) |
| `cubicFeet` | volume for storage fee |
| `landedCogs` | `fob + headShip + duty` (the API does **not** break these out) |
| `inboundFee` | FBA inbound placement |
| `fulfillmentFee` | FBA fulfillment (US incl. 3.5% fuel surcharge) |
| `referralFee` | referral fee |
| `fixedClosingFee` | DE only (else 0) |
| `storageFee` | monthly storage × `storageMonths` |
| `totalCost` | sum of all per-unit costs |
| `grossProfit`, `grossMargin` | before PPC/returns |
| `ppcCostPerUnit`, `returnLossPerUnit` | advertising + return loss per unit |
| `netProfitAfterPPC`, `netMarginAfterPPC` | **net after PPC *and* returns** (this is the headline margin) |
| `monthlyRevenue`, `monthlyGross`, `monthlyNetAfterPPC` | monthly P&L (`× monthlyVolume`) |

### Errors

| Status | `reason` | Cause |
|---|---|---|
| 400 | `invalid_json` | body wasn't valid JSON |
| 400 | `invalid_input` | failed schema validation; `issues[]` lists the offending fields |
| 500 | `compute_error` | engine threw while computing |

### Example

```bash
curl -s -X POST https://profitlee.com/api/calculate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROFITLEE_API_TOKEN" \
  -d '{
    "mode":"fba","region":"us",
    "L":9.75,"W":7.2,"H":4.15,"weight":1.9,
    "fob":0.69,"headShip":0.5,"duty":0.05,
    "price":21.99,"monthlyVolume":800,
    "ppcAcos":0.2,"returnRate":0.05,"referralPct":0.15,"isApparel":false,
    "inboundOption":"optimized","storageMonths":1,"storageSeason":"janSep"
  }'
```

```json
{
  "outputs": {
    "platform": "amazon", "region": "us", "mode": "fba",
    "dimWeight": 2.0959, "shipWeight": 2.0959, "sizeTier": "Large Standard", "cubicFeet": 0.1686,
    "landedCogs": 1.24, "inboundFee": 0, "fulfillmentFee": 6.1272, "referralFee": 3.2985,
    "fixedClosingFee": 0, "storageFee": 0.1315, "totalCost": 10.7972,
    "grossProfit": 11.1928, "grossMargin": 0.509,
    "ppcCostPerUnit": 4.398, "returnLossPerUnit": 0.4013,
    "netProfitAfterPPC": 6.3935, "netMarginAfterPPC": 0.2907,
    "monthlyRevenue": 17592, "monthlyGross": 8954.2375, "monthlyNetAfterPPC": 5114.7615
  }
}
```

### How the skill calls it

`calc.mjs` builds the request per product — `fob = unitFobUsd × packCount`,
`duty` and `headShip` per listing, with the standing defaults (`inboundOption:
"single"`, `headShip $0.30/unit`, `duty 0`, `referralPct 0.15`, `ppcAcos 0.20`,
`returnRate 0.05`, `storageSeason "janSep"`) — fans all 10 products out in
parallel, and maps the responses into `results.js`. Margin fields are multiplied
by 100 for the report (which renders whole percents).

## Files

```
SKILL.md              # the procedure Claude follows (4 phases)
calc.mjs              # Phase 3 helper: products.json + fob.json -> results.js (calls the API)
calc.test.mjs         # node:test unit tests for calc.mjs
report-template.html  # static report; reads results.js (window.__FBA_DATA__)
docs/specs, docs/plans# design + implementation history
```

## Notes & limits

- The 1688 batch image-matcher can return off-category matches for some images;
  the skill surfaces the matched title + seller link and hard-stops on zero/low
  matches rather than estimating.
- FOB is per single unit and multiplied by the Amazon listing's pack count;
  see the pack-count handling in `SKILL.md` Phase 2/3.
- No automated login or CAPTCHA solving — the skill asks the user to resolve
  those.
