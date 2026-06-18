# Cost Inputs + Report Cost-Stack Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the FBA cost inputs to single inbound + flat $0.30/unit head-ship + $0 duty, and split the report's bundled "Landed COGS" into separate FOB / Head-shipping / Duty rows, with an honest net-margin label.

**Architecture:** The skill owns FOB/head-ship/duty as inputs to Profitlee's `/api/calculate`; no API change. `calc.mjs` changes the inputs it sends and passes `headShip`/`duty` through to results.js; `report-template.html` shows them as separate rows.

**Tech Stack:** Node ESM + `node:test`; HTML/JS (report-template.html).

**Conventions:**
- Skill dir (`SKILL_DIR`):
  `/Users/aronlee/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/4b58f008-d934-4080-bc1c-537644177e4d/e1bf8324-030e-448a-aa43-9319bd6ba425/skills/product-cost-analyze-for-fba/`
- **Not a git repo — no commits.** Each task ends when its tests/greps pass.
- Run tests from the skill dir: `node --test calc.test.mjs`

**Spec:** `docs/specs/2026-06-17-cost-inputs-and-report-design.md`

---

## File Structure

- **Modify:** `calc.mjs` — CONSTANTS, `buildPayload`, `mapOutputs`, `main` (assumptions + consistency warn).
- **Modify:** `calc.test.mjs` — update pack test, add input/passthrough tests.
- **Modify:** `report-template.html` — cost-stack rows, inbound label, net-margin label, assumptions footer.

---

## Task 1: calc.mjs CONSTANTS + buildPayload

**Files:** Modify `calc.mjs`, `calc.test.mjs`

- [ ] **Step 1: Update the existing pack test and add input assertions.** In `calc.test.mjs`, replace the test `"buildPayload multiplies fob by packCount"` with:

```js
test("buildPayload: single inbound, flat head-ship, zero duty, fob×pack", () => {
  const product = { dim: { L: 9, W: 3, H: 3 }, weight: 1, price: 45.99, monthlyVolume: 100, packCount: 4 };
  const p = buildPayload(product, { fobUsd: 1.88 });
  assert.ok(Math.abs(p.fob - 7.52) < 1e-6);        // 1.88 × 4
  assert.ok(Math.abs(p.headShip - 1.20) < 1e-6);   // 0.30 × 4
  assert.equal(p.duty, 0);
  assert.equal(p.inboundOption, "single");
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `node --test calc.test.mjs`
Expected: FAIL (`headShip` is `0.5×shipWeight`, `duty` non-zero, `inboundOption` "optimized").

- [ ] **Step 3: Update CONSTANTS in `calc.mjs`** — set single inbound, add head-ship rate, zero duty:

```js
const CONSTANTS = {
  region: "us",
  ppcAcos: 0.20,
  returnRate: 0.05,
  referralPct: 0.15,
  isApparel: false,
  inboundOption: "single",
  storageMonths: 1,
  storageSeason: "janSep",
  exchangeRate: 7.2,
  dutyRate: 0,
  headShipPerUnit: 0.30,
};
```

- [ ] **Step 4: Update `buildPayload`** — head-ship is flat per-unit × pack, duty derives from dutyRate (now 0). Replace the function body's first lines and the `headShip`/`duty` fields:

Replace:
```js
  const shipWeight = deriveShipWeight(product.dim, product.weight);
  const packCount = product.packCount || 1;
  const fob = fobEntry.fobUsd * packCount;
```
with:
```js
  const packCount = product.packCount || 1;
  const fob = fobEntry.fobUsd * packCount;
```
and replace:
```js
    headShip: 0.5 * shipWeight,
    duty: fob * CONSTANTS.dutyRate,
```
with:
```js
    headShip: CONSTANTS.headShipPerUnit * packCount,
    duty: fob * CONSTANTS.dutyRate,
```

(`deriveShipWeight` stays exported and tested; `buildPayload` no longer calls it.)

- [ ] **Step 5: Run, verify all pass.**

Run: `node --test calc.test.mjs`
Expected: PASS.

---

## Task 2: calc.mjs mapOutputs — carry headShip + duty

**Files:** Modify `calc.mjs`, `calc.test.mjs`

- [ ] **Step 1: Append a passthrough test.**

```js
// calc.test.mjs (append near the other mapOutputs tests)
test("mapOutputs carries headShip and duty (per listing)", () => {
  const product = { ...SAMPLE_PRODUCT, packCount: 4 };
  const m = mapOutputs(product, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.headShip, 1.2);   // 0.30 × 4
  assert.equal(m.duty, 0);
  assert.equal(m.fobUsdPerListing, 2.76); // 0.69 × 4
});
```

- [ ] **Step 2: Run, verify it fails.**

Run: `node --test calc.test.mjs`
Expected: FAIL (`m.headShip` undefined).

- [ ] **Step 3: Add the two fields in `mapOutputs`.** Immediately after the existing `fobUsdPerListing: …,` line, insert:

```js
    headShip: +(CONSTANTS.headShipPerUnit * (product.packCount || 1)).toFixed(2),
    duty: +((fobEntry.fobUsd) * (product.packCount || 1) * CONSTANTS.dutyRate).toFixed(2),
```

- [ ] **Step 4: Run, verify all pass.**

Run: `node --test calc.test.mjs`
Expected: PASS.

---

## Task 3: calc.mjs main — assumptions + consistency warning

**Files:** Modify `calc.mjs`

- [ ] **Step 1: Extend the `assumptions` object** in `main`. Replace the assumptions block with:

```js
    assumptions: {
      exchangeRate: CONSTANTS.exchangeRate,
      dutyRate: CONSTANTS.dutyRate,
      headShipPerUnit: CONSTANTS.headShipPerUnit,
      inboundOption: CONSTANTS.inboundOption,
      referralPct: CONSTANTS.referralPct,
      ppcAcos: CONSTANTS.ppcAcos,
      returnRate: CONSTANTS.returnRate,
      storageSeason: CONSTANTS.storageSeason,
    },
```

- [ ] **Step 2: Add a consistency warning.** Immediately after `const mapped = settled.map((s) => s.value);` in `main`, insert:

```js
  for (const m of mapped) {
    const sum = m.fobUsdPerListing + m.headShip + m.duty;
    if (Math.abs(sum - m.landedCogs) > 0.05) {
      console.warn(`warn ${m.asin}: FOB+headShip+duty ($${sum.toFixed(2)}) != API landedCogs ($${m.landedCogs})`);
    }
  }
```

- [ ] **Step 3: Verify the suite still passes and the script runs.**

Run: `node --test calc.test.mjs`
Expected: PASS (21+ tests).
Run: `node --check "$SKILL_DIR/calc.mjs" && echo "syntax ok"`
Expected: `syntax ok`.

---

## Task 4: report-template.html — split cost-stack rows + inbound label

**Files:** Modify `report-template.html`

- [ ] **Step 1: Locate the cost-stack rows.**

Run: `grep -n "Landed COGS\|FBA Inbound\|Net Margin (post-PPC)\|Head-haul\|optimized" "$SKILL_DIR/report-template.html"`

- [ ] **Step 2: Replace the single Landed COGS row** with three rows. Find:

```js
      <tr><td>Landed COGS (FOB + Ship + Duty)</td><td class="dr">${fmtUsd(p.landedCogs)}</td><td class="dr">${(p.landedCogs/p.price*100).toFixed(1)}%</td></tr>
```
and replace with:
```js
      <tr><td>FOB${p.packCount>1?' (× '+p.packCount+' pack)':''}</td><td class="dr">${fmtUsd(p.fobUsdPerListing)}</td><td class="dr">${(p.fobUsdPerListing/p.price*100).toFixed(1)}%</td></tr>
      <tr><td>Head-shipping</td><td class="dr">${fmtUsd(p.headShip)}</td><td class="dr">${(p.headShip/p.price*100).toFixed(1)}%</td></tr>
      <tr><td>Duty</td><td class="dr">${fmtUsd(p.duty)}</td><td class="dr">${(p.duty/p.price*100).toFixed(1)}%</td></tr>
```

- [ ] **Step 3: Relabel the inbound row.** Find `FBA Inbound (Optimized)` and change it to `FBA Inbound (single)` (leave the `${fmtUsd(p.inboundFee)}` cells).

- [ ] **Step 4: Verify.**

Run: `grep -cE "Head-shipping|<td>Duty</td>|FBA Inbound \(single\)" "$SKILL_DIR/report-template.html"`
Expected: `3`. And the old bundled row is gone:
Run: `grep -c "Landed COGS (FOB + Ship + Duty)" "$SKILL_DIR/report-template.html"`
Expected: `0`.

---

## Task 5: report-template.html — net-margin label + assumptions footer

**Files:** Modify `report-template.html`

- [ ] **Step 1: Relabel net margin.** Replace the metric label text `Net Margin (post-PPC)` with `Net after PPC + returns` (there may be one in the survivor card and one in the eliminated/mini card — replace all occurrences).

- [ ] **Step 2: Update the assumptions footer.** Find the footer line beginning `<strong>Assumptions:</strong>` and replace its content with:

```js
    <strong>Assumptions:</strong> FOB rate ¥${a.exchangeRate}/$1 · Duty ${(a.dutyRate*100).toFixed(0)}% · Head-ship $${(a.headShipPerUnit ?? 0.30).toFixed(2)}/unit · Inbound: ${a.inboundOption || 'single'} · ${a.storageSeason==='octDec'?'Oct–Dec':'Jan–Sep'} storage · ACoS ${(a.ppcAcos*100).toFixed(0)}% · Return rate ${(a.returnRate*100).toFixed(0)}% · Referral ${(a.referralPct*100).toFixed(0)}% · FBA 2026 + 3.5% fuel surcharge.<br>
```

- [ ] **Step 3: Verify.**

Run: `grep -cE "Net after PPC \+ returns|Head-ship \\$|Inbound: " "$SKILL_DIR/report-template.html"`
Expected: `≥3`.
Run: `grep -cE "Net Margin \(post-PPC\)|Head-haul|Inbound .optimized" "$SKILL_DIR/report-template.html"`
Expected: `0`.

---

## Task 6: Verify on portable-fly-fan

**Files:** none (verification only; re-runs the existing run dir)

- [ ] **Step 1: Re-run calc.**

Run: `node "$SKILL_DIR/calc.mjs" "/Users/aronlee/Documents/product-research/portable-fly-fan" "portable fly fan"`
Expected: exit 0, no `warn …` lines (components sum to landedCogs).

- [ ] **Step 2: Confirm fields + a recomputed product.**

Run:
```bash
node -e '
const fs=require("fs");
eval(fs.readFileSync("/Users/aronlee/Documents/product-research/portable-fly-fan/results.js","utf8").replace("window.__FBA_DATA__","var D"));
const s=D.survivors[0];
console.log("assumptions:", JSON.stringify(D.assumptions));
console.log(s.asin,"FOB$"+s.fobUsdPerListing,"headShip$"+s.headShip,"duty$"+s.duty,"inbound$"+s.inboundFee,"net "+s.netMarginAfterPPC+"%");
console.log("sum check:", (s.fobUsdPerListing+s.headShip+s.duty).toFixed(2), "vs landedCogs", s.landedCogs);
'
```
Expected: `headShip` = $0.30 × packCount, `duty` = 0, `inboundFee` > 0 (single), assumptions show `inboundOption:"single"`, `dutyRate:0`, `headShipPerUnit:0.3`; sum ≈ landedCogs.

- [ ] **Step 3: Render the report (fresh port to dodge cache).** Copy the template, serve on an unused port, load via Chrome MCP:
Run: `cp "$SKILL_DIR/report-template.html" /Users/aronlee/Documents/product-research/portable-fly-fan/report.html`
Then `python3 -m http.server 7846 --directory /Users/aronlee/Documents/product-research/portable-fly-fan &` and load `http://localhost:7846/report.html`.
Expected: cost stack shows separate **FOB / Head-shipping / Duty** rows then **FBA Inbound (single)**; the margin tile reads **"Net after PPC + returns"**; footer shows the new assumptions.

---

## Self-Review

**Spec coverage:**
- single inbound + $0.30/unit head-ship + $0 duty inputs → Task 1 ✓
- headShip/duty passed through → Task 2 ✓
- consistency check (sum == landedCogs) → Task 3 step 2 ✓
- assumptions object updated → Task 3 step 1 ✓
- cost stack split into FOB/Head-ship/Duty rows + inbound "(single)" → Task 4 ✓
- net-margin relabel "Net after PPC + returns" → Task 5 step 1 ✓
- assumptions footer updated → Task 5 step 2 ✓
- verification on real data → Task 6 ✓

**Placeholder scan:** none — all code blocks complete; `??`/defaults are real fallbacks.

**Consistency:** field names `fobUsdPerListing`, `headShip`, `duty`, `inboundFee`,
`landedCogs`, `packCount`, and assumptions keys `headShipPerUnit`/`inboundOption`/
`dutyRate` match across calc.mjs, mapOutputs, the report rows, and the footer.
`CONSTANTS.headShipPerUnit`/`dutyRate` referenced in Tasks 1–3 are defined in Task 1 step 3.
