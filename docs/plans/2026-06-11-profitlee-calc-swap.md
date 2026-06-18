# Profitlee Calc Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the skill's inline Phase 3 FBA math with calls to Profitlee's `/api/calculate`, via a committed, unit-tested `calc.mjs` helper.

**Architecture:** `calc.mjs` is pure functions (payload build, output mapping, survivor ranking) wrapped by a thin I/O shell (`callApi`, `main`). The mapping layer adapts the API's decimal margins (`0.29`) to the report template's whole-percent contract (`29.0`) and renames `ppcCostPerUnit→ppcCost`, `returnLossPerUnit→returnLoss`, `sizeTier→tier`. All 10 products POST in parallel; any failure aborts with no partial `results.js`.

**Tech Stack:** Node ≥18 ESM, built-in `node:test` + `node:assert` (no deps), global `fetch`.

**Conventions for this plan:**
- All paths are relative to the skill directory:
  `/Users/aronlee/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/4b58f008-d934-4080-bc1c-537644177e4d/e1bf8324-030e-448a-aa43-9319bd6ba425/skills/product-cost-analyze-for-fba/`
- **The skill dir is not a git repo, so commit steps are omitted.** Each task ends when its tests pass.
- Run tests from the skill dir: `node --test calc.test.mjs`

**Spec:** `docs/specs/2026-06-11-profitlee-calc-swap-design.md`

---

## File Structure

- **Create:** `calc.mjs` — exported pure fns (`deriveShipWeight`, `buildPayload`, `mapOutputs`, `selectAndRank`), I/O (`callApi`, `main`), CLI entry.
- **Create:** `calc.test.mjs` — `node:test` unit tests for every pure fn + `callApi` + `main` (with a fake `fetch` and a temp dir).
- **Modify:** `SKILL.md` — rewrite Phase 3 to invoke `calc.mjs`; delete the fee table / size-tier / storage math; add a one-time **Setup** section for `PROFITLEE_API_TOKEN`.
- **Modify (one-time, user data):** `~/.claude/settings.json` — add `env.PROFITLEE_API_TOKEN`.

---

## Task 1: `deriveShipWeight` + `buildPayload`

**Files:**
- Create: `calc.mjs`
- Test: `calc.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// calc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveShipWeight, buildPayload } from "./calc.mjs";

test("deriveShipWeight uses max of actual vs dimensional weight", () => {
  // dim weight = 10*10*10/139 = 7.194... ; actual 1 → dimensional wins
  assert.ok(Math.abs(deriveShipWeight({ L: 10, W: 10, H: 10 }, 1) - 7.1942) < 0.001);
  // actual 9 wins over dim 7.19
  assert.equal(deriveShipWeight({ L: 10, W: 10, H: 10 }, 9), 9);
});

test("deriveShipWeight floors each dimension at 2in", () => {
  // 2*2*2/139 = 0.02877 ; actual 0.01 → floored-dim wins
  assert.ok(Math.abs(deriveShipWeight({ L: 1, W: 1, H: 1 }, 0.01) - 0.02877) < 0.001);
});

test("buildPayload maps fields and derives headShip + duty", () => {
  const product = { dim: { L: 9.75, W: 7.2, H: 4.15 }, weight: 1.9, price: 21.99, monthlyVolume: 800 };
  const fobEntry = { fobUsd: 0.69 };
  const p = buildPayload(product, fobEntry);
  assert.equal(p.mode, "fba");
  assert.equal(p.region, "us");
  assert.equal(p.L, 9.75);
  assert.equal(p.weight, 1.9);
  assert.equal(p.fob, 0.69);
  assert.equal(p.price, 21.99);
  assert.equal(p.monthlyVolume, 800);
  assert.equal(p.referralPct, 0.15);
  assert.equal(p.inboundOption, "optimized");
  assert.equal(p.storageSeason, "janSep");
  // duty = 0.69 * 0.075
  assert.ok(Math.abs(p.duty - 0.051750) < 1e-6);
  // headShip = 0.5 * shipWeight ; shipWeight = max(1.9, 9.75*7.2*4.15/139=2.0959)=2.0959
  assert.ok(Math.abs(p.headShip - 1.04795) < 0.001);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test calc.test.mjs`
Expected: FAIL — `Cannot find module './calc.mjs'` / exports undefined.

- [ ] **Step 3: Implement `calc.mjs` core**

```js
// calc.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API_URL = "https://profitlee.com/api/calculate";

const CONSTANTS = {
  region: "us",
  ppcAcos: 0.20,
  returnRate: 0.05,
  referralPct: 0.15,
  isApparel: false,
  inboundOption: "optimized",
  storageMonths: 1,
  storageSeason: "janSep",
  exchangeRate: 7.2,
  dutyRate: 0.075,
};

export function deriveShipWeight(dim, weight) {
  const { L, W, H } = dim;
  const dimWeight = (Math.max(L, 2) * Math.max(W, 2) * Math.max(H, 2)) / 139;
  return Math.max(weight, dimWeight);
}

export function buildPayload(product, fobEntry) {
  const shipWeight = deriveShipWeight(product.dim, product.weight);
  const fob = fobEntry.fobUsd;
  return {
    mode: "fba",
    region: CONSTANTS.region,
    L: product.dim.L,
    W: product.dim.W,
    H: product.dim.H,
    weight: product.weight,
    fob,
    headShip: 0.5 * shipWeight,
    duty: fob * CONSTANTS.dutyRate,
    price: product.price,
    monthlyVolume: product.monthlyVolume,
    ppcAcos: CONSTANTS.ppcAcos,
    returnRate: CONSTANTS.returnRate,
    referralPct: CONSTANTS.referralPct,
    isApparel: CONSTANTS.isApparel,
    inboundOption: CONSTANTS.inboundOption,
    storageMonths: CONSTANTS.storageMonths,
    storageSeason: CONSTANTS.storageSeason,
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test calc.test.mjs`
Expected: PASS (3 tests).

---

## Task 2: `mapOutputs` — the margin ×100 + rename layer

**Files:**
- Modify: `calc.mjs`
- Test: `calc.test.mjs`

- [ ] **Step 1: Append failing tests**

```js
// calc.test.mjs  (append)
import { mapOutputs } from "./calc.mjs";

const SAMPLE_PRODUCT = {
  asin: "B0TEST", title: "Test Basket", amazonUrl: "https://amazon.com/dp/B0TEST",
  imageUrl: "https://img/x.jpg", price: 21.99, monthlyVolume: 800,
  volumeSource: "badge", dim: { L: 9.75, W: 7.2, H: 4.15 }, weight: 1.9,
};
const SAMPLE_FOB = { fobRmb: 5.0, fobUsd: 0.69, source: "1688", sellerUrl: "https://detail.1688.com/offer/1.html" };
const SAMPLE_OUTPUTS = {
  shipWeight: 2.0959, sizeTier: "Large Standard",
  landedCogs: 1.24, inboundFee: 0, fulfillmentFee: 6.1272, referralFee: 3.2985,
  storageFee: 0.1315, totalCost: 10.7972, grossProfit: 11.1928, grossMargin: 0.509,
  ppcCostPerUnit: 4.398, returnLossPerUnit: 0.4013, netProfitAfterPPC: 6.3935,
  netMarginAfterPPC: 0.2907, monthlyNetAfterPPC: 5114.7615,
};

test("mapOutputs converts margins to whole percent", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.grossMargin, 50.9);
  assert.equal(m.netMarginAfterPPC, 29.07);
});

test("mapOutputs renames API field names to template names", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.ppcCost, 4.398);
  assert.equal(m.returnLoss, 0.4013);
  assert.equal(m.tier, "Large Standard");
});

test("mapOutputs rounds monthly net and passes through identity fields", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.monthlyNetAfterPPC, 5115);
  assert.equal(m.asin, "B0TEST");
  assert.equal(m.fobRmb, 5.0);
  assert.equal(m.fobUsd, 0.69);
  assert.equal(m.fobSource, "1688");
  assert.equal(m.sellerUrl, "https://detail.1688.com/offer/1.html");
  assert.equal(m.recommended, false);
  assert.equal(m.badge, null);
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test calc.test.mjs`
Expected: FAIL — `mapOutputs` is not exported.

- [ ] **Step 3: Add `mapOutputs` to `calc.mjs`**

```js
// calc.mjs  (append after buildPayload)
export function mapOutputs(product, fobEntry, outputs) {
  return {
    asin: product.asin,
    title: product.title,
    amazonUrl: product.amazonUrl,
    imageUrl: product.imageUrl,
    price: product.price,
    monthlyVolume: product.monthlyVolume,
    volumeSource: product.volumeSource,
    fobRmb: fobEntry.fobRmb,
    fobUsd: fobEntry.fobUsd,
    fobSource: fobEntry.source || "1688",
    sellerUrl: fobEntry.sellerUrl || "",
    dim: product.dim,
    shipWeight: outputs.shipWeight,
    tier: outputs.sizeTier,
    landedCogs: outputs.landedCogs,
    inboundFee: outputs.inboundFee,
    fulfillmentFee: outputs.fulfillmentFee,
    referralFee: outputs.referralFee,
    storageFee: outputs.storageFee,
    totalCost: outputs.totalCost,
    grossProfit: outputs.grossProfit,
    grossMargin: +(outputs.grossMargin * 100).toFixed(2),
    ppcCost: outputs.ppcCostPerUnit,
    returnLoss: outputs.returnLossPerUnit,
    netProfitAfterPPC: outputs.netProfitAfterPPC,
    netMarginAfterPPC: +(outputs.netMarginAfterPPC * 100).toFixed(2),
    monthlyNetAfterPPC: Math.round(outputs.monthlyNetAfterPPC),
    recommended: false,
    badge: null,
  };
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test calc.test.mjs`
Expected: PASS (6 tests).

---

## Task 3: `selectAndRank` — survivor filter, sort, badge

**Files:**
- Modify: `calc.mjs`
- Test: `calc.test.mjs`

- [ ] **Step 1: Append failing tests**

```js
// calc.test.mjs  (append)
import { selectAndRank } from "./calc.mjs";

function mk(asin, net, margin, monthly) {
  return { asin, netProfitAfterPPC: net, netMarginAfterPPC: margin, monthlyNetAfterPPC: monthly, recommended: false, badge: null };
}

test("selectAndRank splits survivors from eliminated on netProfit>0", () => {
  const { survivors, eliminated } = selectAndRank([mk("A", 5, 20, 100), mk("B", -1, -5, 0), mk("C", 0, 0, 0)]);
  assert.deepEqual(survivors.map((s) => s.asin), ["A"]);
  assert.deepEqual(eliminated.map((s) => s.asin).sort(), ["B", "C"]);
});

test("selectAndRank sorts by margin desc then monthly net desc", () => {
  const { survivors } = selectAndRank([mk("A", 5, 20, 100), mk("B", 5, 25, 50), mk("C", 5, 25, 900)]);
  assert.deepEqual(survivors.map((s) => s.asin), ["C", "B", "A"]);
});

test("selectAndRank badges top 3 with margin>=15", () => {
  const { survivors } = selectAndRank([
    mk("A", 5, 30, 100), mk("B", 5, 25, 100), mk("C", 5, 20, 100), mk("D", 5, 16, 100), mk("E", 5, 10, 100),
  ]);
  assert.deepEqual(survivors.filter((s) => s.recommended).map((s) => [s.asin, s.badge]), [["A", 1], ["B", 2], ["C", 3]]);
  assert.equal(survivors.find((s) => s.asin === "E").badge, null);
});

test("selectAndRank does not badge sub-15 margins even with <3 badged", () => {
  const { survivors } = selectAndRank([mk("A", 5, 14, 100), mk("B", 5, 12, 100)]);
  assert.equal(survivors.every((s) => s.badge === null), true);
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test calc.test.mjs`
Expected: FAIL — `selectAndRank` not exported.

- [ ] **Step 3: Add `selectAndRank` to `calc.mjs`**

```js
// calc.mjs  (append)
export function selectAndRank(mapped) {
  const survivors = mapped.filter((p) => p.netProfitAfterPPC > 0);
  const eliminated = mapped.filter((p) => p.netProfitAfterPPC <= 0);
  survivors.sort((a, b) =>
    b.netMarginAfterPPC !== a.netMarginAfterPPC
      ? b.netMarginAfterPPC - a.netMarginAfterPPC
      : b.monthlyNetAfterPPC - a.monthlyNetAfterPPC
  );
  let badge = 0;
  for (const s of survivors) {
    if (badge < 3 && s.netMarginAfterPPC >= 15) {
      s.recommended = true;
      s.badge = ++badge;
    }
  }
  return { survivors, eliminated };
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test calc.test.mjs`
Expected: PASS (10 tests).

---

## Task 4: `callApi` — bearer auth + error surfacing

**Files:**
- Modify: `calc.mjs`
- Test: `calc.test.mjs`

- [ ] **Step 1: Append failing tests (fake fetch, no network)**

```js
// calc.test.mjs  (append)
import { callApi } from "./calc.mjs";

test("callApi sends Bearer token and returns outputs", async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ outputs: { netProfitAfterPPC: 1 } }) };
  };
  const out = await callApi({ price: 1 }, "tok_abc", fakeFetch);
  assert.equal(out.netProfitAfterPPC, 1);
  assert.equal(seen.opts.headers.Authorization, "Bearer tok_abc");
  assert.equal(seen.opts.method, "POST");
});

test("callApi throws on non-200", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  await assert.rejects(() => callApi({}, "bad", fakeFetch), /HTTP 401/);
});

test("callApi throws when outputs missing", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(() => callApi({}, "tok", fakeFetch), /missing outputs/);
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test calc.test.mjs`
Expected: FAIL — `callApi` not exported.

- [ ] **Step 3: Add `callApi` to `calc.mjs`**

```js
// calc.mjs  (append)
export async function callApi(payload, token, fetchImpl = fetch) {
  const res = await fetchImpl(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.outputs) throw new Error("missing outputs in response");
  return json.outputs;
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test calc.test.mjs`
Expected: PASS (13 tests).

---

## Task 5: `main` — orchestration, token guard, hard-stop, results.js

**Files:**
- Modify: `calc.mjs`
- Test: `calc.test.mjs`

- [ ] **Step 1: Append failing tests (fake fetch + temp dir)**

```js
// calc.test.mjs  (append)
import { main } from "./calc.mjs";
import { mkdtemp, writeFile as wf, readFile as rf, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

async function makeRun() {
  const dir = await mkdtemp(pjoin(tmpdir(), "fba-"));
  await wf(pjoin(dir, "products.json"), JSON.stringify([
    { asin: "B1", title: "T1", amazonUrl: "u1", imageUrl: "i1", price: 21.99, monthlyVolume: 800, volumeSource: "badge", dim: { L: 9.75, W: 7.2, H: 4.15 }, weight: 1.9 },
    { asin: "B2", title: "T2", amazonUrl: "u2", imageUrl: "i2", price: 22.0, monthlyVolume: 100, volumeSource: "badge", dim: { L: 22, W: 17, H: 12 }, weight: 3.5 },
  ]));
  await wf(pjoin(dir, "fob.json"), JSON.stringify([
    { asin: "B1", fobRmb: 5.0, fobUsd: 0.69, source: "1688", sellerUrl: "s1" },
    { asin: "B2", fobRmb: 28.5, fobUsd: 3.96, source: "1688", sellerUrl: "s2" },
  ]));
  return dir;
}

test("main throws when token missing (before any file read)", async () => {
  await assert.rejects(
    () => main("/nonexistent", "kw", { token: undefined, fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /PROFITLEE_API_TOKEN not set/
  );
});

test("main hard-stops with no results.js when any product fails", async () => {
  const dir = await makeRun();
  const fakeFetch = async (_u, opts) => {
    const body = JSON.parse(opts.body);
    if (body.price === 22.0) return { ok: false, status: 500, text: async () => "boom" };
    return { ok: true, status: 200, json: async () => ({ outputs: stubOut(8) }) };
  };
  await assert.rejects(() => main(dir, "kw", { token: "t", fetchImpl: fakeFetch }), /Calc failed/);
  await assert.rejects(() => rf(pjoin(dir, "results.js")), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test("main writes results.js with survivors on happy path", async () => {
  const dir = await makeRun();
  const fakeFetch = async (_u, opts) => {
    const body = JSON.parse(opts.body);
    // B1 profitable, B2 unprofitable
    return { ok: true, status: 200, json: async () => ({ outputs: body.price === 22.0 ? stubOut(-2) : stubOut(6) }) };
  };
  const data = await main(dir, "storage basket", { token: "t", fetchImpl: fakeFetch });
  const written = await rf(pjoin(dir, "results.js"), "utf8");
  assert.ok(written.startsWith("window.__FBA_DATA__ = "));
  assert.equal(data.keyword, "storage basket");
  assert.equal(data.survivors.length, 1);
  assert.equal(data.eliminated.length, 1);
  assert.equal(data.survivors[0].asin, "B1");
  assert.match(data.marketInsight, /1 of 2 products profitable/);
  await rm(dir, { recursive: true, force: true });
});

// helper producing a CalcOutputs-shaped stub with a given net profit
function stubOut(net) {
  return {
    shipWeight: 2.1, sizeTier: "Large Standard", landedCogs: 1.2, inboundFee: 0,
    fulfillmentFee: 6.1, referralFee: 3.3, storageFee: 0.13, totalCost: 10.8,
    grossProfit: net + 4.8, grossMargin: 0.5, ppcCostPerUnit: 4.4, returnLossPerUnit: 0.4,
    netProfitAfterPPC: net, netMarginAfterPPC: net / 22, monthlyNetAfterPPC: net * 100,
  };
}
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test calc.test.mjs`
Expected: FAIL — `main` not exported.

- [ ] **Step 3: Add `main` to `calc.mjs`**

```js
// calc.mjs  (append)
export async function main(runDir, keyword, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const token = "token" in opts ? opts.token : process.env.PROFITLEE_API_TOKEN;
  if (!token) {
    throw new Error("PROFITLEE_API_TOKEN not set. Add it to ~/.claude/settings.json env (see SKILL.md → Setup).");
  }

  const products = JSON.parse(await readFile(join(runDir, "products.json"), "utf8"));
  const fob = JSON.parse(await readFile(join(runDir, "fob.json"), "utf8"));
  const fobMap = new Map(fob.map((f) => [f.asin, f]));

  const settled = await Promise.allSettled(
    products.map(async (p) => {
      const f = fobMap.get(p.asin);
      if (!f) throw new Error(`no fob.json entry`);
      const outputs = await callApi(buildPayload(p, f), token, fetchImpl);
      return mapOutputs(p, f, outputs);
    })
  );

  const failures = settled
    .map((s, i) => (s.status === "rejected" ? `${products[i].asin}: ${s.reason.message}` : null))
    .filter(Boolean);
  if (failures.length) {
    throw new Error("Calc failed — no results.js written:\n" + failures.join("\n"));
  }

  const mapped = settled.map((s) => s.value);
  const { survivors, eliminated } = selectAndRank(mapped);

  const bestMonthly = survivors.length ? Math.max(...survivors.map((s) => s.monthlyNetAfterPPC)) : 0;
  const marketInsight = survivors.length
    ? `${survivors.length} of ${mapped.length} products profitable. Top margin: ${survivors[0].netMarginAfterPPC.toFixed(1)}% (${survivors[0].asin}). Best monthly: $${bestMonthly}/mo.`
    : `0 of ${mapped.length} products profitable.`;

  const data = {
    keyword,
    date: new Date().toISOString().slice(0, 10),
    assumptions: {
      exchangeRate: CONSTANTS.exchangeRate,
      dutyRate: CONSTANTS.dutyRate,
      referralPct: CONSTANTS.referralPct,
      ppcAcos: CONSTANTS.ppcAcos,
      returnRate: CONSTANTS.returnRate,
      storageSeason: CONSTANTS.storageSeason,
    },
    survivors,
    eliminated,
    retried: false,
    initialSurvivors: survivors.length,
    retrySurvivors: 0,
    marketInsight,
  };

  await writeFile(join(runDir, "results.js"), "window.__FBA_DATA__ = " + JSON.stringify(data, null, 2) + ";");
  return data;
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test calc.test.mjs`
Expected: PASS (16 tests).

---

## Task 6: CLI entry

**Files:**
- Modify: `calc.mjs`

- [ ] **Step 1: Append CLI guard at the end of `calc.mjs`**

```js
// calc.mjs  (append at very end)
if (import.meta.url === `file://${process.argv[1]}`) {
  const [runDir, keyword] = process.argv.slice(2);
  if (!runDir || !keyword) {
    console.error('Usage: node calc.mjs <run-dir> "<keyword>"');
    process.exit(1);
  }
  main(runDir, keyword)
    .then((d) => console.log(`Wrote results.js — ${d.survivors.length} survivors, ${d.eliminated.length} eliminated.`))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
```

- [ ] **Step 2: Verify the CLI guard does not break the test suite**

Run: `node --test calc.test.mjs`
Expected: PASS (16 tests) — importing the module must not trigger the CLI block.

- [ ] **Step 3: Verify the missing-token CLI path**

Run: `env -u PROFITLEE_API_TOKEN node calc.mjs /tmp/nope "kw"; echo "exit=$?"`
Expected: prints the `PROFITLEE_API_TOKEN not set...` message and `exit=1`.

---

## Task 7: Rewrite SKILL.md Phase 3 + add Setup

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: Add a Setup section** under the existing "Prerequisites & cost model" area, before Phase 1:

```markdown
### Setup — Profitlee API token (one-time)

Phase 3 calls Profitlee's calc engine at `https://profitlee.com/api/calculate`.
It authenticates with a bearer token read from `PROFITLEE_API_TOKEN`.

Store the token once in `~/.claude/settings.json`:

```json
{ "env": { "PROFITLEE_API_TOKEN": "<your token>" } }
```

The harness injects it into every session. Verify presence (never print the value):

```bash
node -e "console.log(process.env.PROFITLEE_API_TOKEN ? 'PRESENT' : 'MISSING')"
```

If it shows `MISSING` right after adding it, restart the session — settings.json
env is applied at session start.
```

- [ ] **Step 2: Replace the entire Phase 3 section** (everything from `## Phase 3 — Calculate & write results.js` up to but not including `## Phase 4 — Open report`) with:

```markdown
## Phase 3 — Calculate & write results.js

The FBA math lives in Profitlee's tested calc engine, not in this skill. Phase 3
sends each product to `POST https://profitlee.com/api/calculate` and writes
`results.js` from the responses. Do **not** hand-roll fee tables here.

### 3.1 Preconditions

- `<run-dir>/products.json` and `<run-dir>/fob.json` both exist and cover the
  same ASINs (Phase 2 completed with no hard-stop).
- `PROFITLEE_API_TOKEN` is set (see Setup). Confirm with the presence-probe.

### 3.2 Run the calc helper

```bash
node "<skill-dir>/calc.mjs" "<run-dir>" "<keyword>"
```

`calc.mjs` fires all products in parallel, maps the API outputs into the report
template's shape (margins as whole percents; `ppcCost`/`returnLoss`/`tier`
field names), filters survivors (`netProfitAfterPPC > 0`), sorts by net margin
then monthly net, badges the top 3 with margin ≥ 15%, and writes
`<run-dir>/results.js`.

### 3.3 Hard-stop on failure

If any product's API call fails (missing token, non-200, validation error),
`calc.mjs` exits non-zero, prints the failing ASIN(s), and writes **no**
`results.js`. Resolve the cause (e.g. set the token, retry transient network)
and re-run — never edit `results.js` by hand.

The inputs `calc.mjs` sends per product: physical dims + weight (products.json),
`fob`=fobUsd, `headShip`=0.5×shipWeight, `duty`=fob×0.075, price + monthlyVolume,
and the standing assumptions (`ppcAcos` 0.20, `returnRate` 0.05, `referralPct`
0.15, `inboundOption` "optimized", `storageMonths` 1, `storageSeason` "janSep").
```

- [ ] **Step 3: Verify no orphaned fee-table content remains**

Run: `grep -nE "fulfillment fee table|6.97|0.08·|usFulfillmentFee|Size tier|dimWeight =|Large Standard.*base" SKILL.md`
Expected: no matches (all hand-rolled math removed).

- [ ] **Step 4: Verify the new references exist**

Run: `grep -nE "calc.mjs|PROFITLEE_API_TOKEN|api/calculate" SKILL.md`
Expected: matches in both Setup and Phase 3.

---

## Task 8: Configure the token (one-time, requires user's token)

**Files:**
- Modify: `~/.claude/settings.json`

> Execute this only when the user has provided the token value. Do not echo the value back into the transcript.

- [ ] **Step 1: Read current settings.json**

Run: `cat ~/.claude/settings.json 2>/dev/null || echo "{}"`
Note whether an `env` block already exists so the next step merges rather than overwrites.

- [ ] **Step 2: Add `env.PROFITLEE_API_TOKEN`**

Merge the key into the existing JSON (preserve all other keys). Resulting shape:

```json
{
  "env": {
    "PROFITLEE_API_TOKEN": "<user-provided value>"
  }
}
```

Prefer editing via the `update-config` skill if available; otherwise edit the
file directly, preserving existing content.

- [ ] **Step 3: Verify presence without printing the value**

Run: `node -e "console.log(process.env.PROFITLEE_API_TOKEN ? 'PRESENT' : 'MISSING')"`
Expected: `PRESENT`. If `MISSING`, the value lands next session — note it and continue; the integration test in Task 9 will confirm once active.

---

## Task 9: Integration verification (real API)

**Files:** none (verification only)

- [ ] **Step 1: Back up the existing storage-basket results.js**

Run: `cp /Users/aronlee/Documents/product-research/storage-basket/results.js /tmp/results.prev.js`

- [ ] **Step 2: Run the real calc against the existing run dir**

Run: `node "<skill-dir>/calc.mjs" "/Users/aronlee/Documents/product-research/storage-basket" "storage basket"`
Expected: `Wrote results.js — N survivors, M eliminated.` (N+M=10), exit 0.

- [ ] **Step 3: Sanity-check the output values**

Run:
```bash
node -e '
const fs=require("fs");
eval(fs.readFileSync("/Users/aronlee/Documents/product-research/storage-basket/results.js","utf8").replace("window.__FBA_DATA__","var D"));
const t=D.survivors[0];
console.log("survivors",D.survivors.length,"eliminated",D.eliminated.length);
console.log("top",t.asin,t.netMarginAfterPPC+"%","$"+t.netProfitAfterPPC,"badge",t.badge);
console.log("marginInWholePercent", t.netMarginAfterPPC>1 && t.netMarginAfterPPC<100);
'
```
Expected: survivors+eliminated=10; top margin is a sane whole-percent number (e.g. ~29, not 0.29 and not 2900); `marginInWholePercent` is `true`; top survivor has `badge 1`.

- [ ] **Step 4: Confirm the report renders correctly**

Ensure a static server is serving the run dir (reuse the existing one or start `python3 -m http.server 7843` from the run dir), then load `http://localhost:7843/report.html` and confirm via `mcp__Claude_in_Chrome__javascript_tool` that `window.__FBA_DATA__.survivors[0].netMarginAfterPPC` matches the value from Step 3 and the "Best Net Margin" stat shows a sane percentage (not 0.x%).

- [ ] **Step 5: Confirm the hard-stop path**

Run: `PROFITLEE_API_TOKEN=definitely_invalid_token node "<skill-dir>/calc.mjs" "/Users/aronlee/Documents/product-research/storage-basket" "storage basket"; echo "exit=$?"`
Expected: **only if auth is enabled server-side** — non-zero exit, failing ASINs listed, and `results.js` unchanged from Step 2 (the run that just succeeded). If the endpoint is still open, this returns 200s and exits 0; that is acceptable today and the guard is still covered by the Task 5 unit test.

- [ ] **Step 6: Restore note**

The Step 2 run already overwrote `results.js` with fresh, correct data; `/tmp/results.prev.js` is the pre-swap backup if comparison is needed. No restore required.

---

## Self-Review

**Spec coverage:**
- Endpoint + payload mapping → Tasks 1, 2, 4 ✓
- Margin ×100 + field renames → Task 2 ✓
- Parallel calls → Task 5 (`Promise.allSettled`) ✓
- Hard-stop, no partial file → Task 5 + Task 9 Step 5 ✓
- Token storage + missing-token guard + presence-probe → Tasks 5, 7, 8 ✓
- SKILL.md Phase 3 rewrite + delete fee tables + Setup → Task 7 ✓
- Selection logic unchanged → Task 3 ✓
- Verification (numbers shift, report renders) → Task 9 ✓
- Out of scope (referral category, template edit) → honored; not implemented ✓

**Placeholder scan:** none — every code/test step has complete content.

**Type/name consistency:** `deriveShipWeight`, `buildPayload`, `mapOutputs`, `selectAndRank`, `callApi`, `main` are named identically across definition, tests, and CLI. Output field names (`ppcCost`, `returnLoss`, `tier`, `grossMargin`, `netMarginAfterPPC`) match the report template's reads and the Task 2 assertions. `CONSTANTS` keys referenced in `buildPayload`/`main` are all defined in Task 1.
