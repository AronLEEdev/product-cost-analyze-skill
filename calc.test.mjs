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
  // 2*2*2/139 = 0.05755 ; actual 0.01 → floored-dim wins
  assert.ok(Math.abs(deriveShipWeight({ L: 1, W: 1, H: 1 }, 0.01) - 0.05755) < 0.001);
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
  assert.equal(p.inboundOption, "single");
  assert.equal(p.storageSeason, "janSep");
  // duty default 0
  assert.equal(p.duty, 0);
  // headShip = 0.30/unit × packCount(=1 here)
  assert.ok(Math.abs(p.headShip - 0.30) < 1e-6);
});

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

// calc.test.mjs  (append)
import { callApi } from "./calc.mjs";

test("callApi POSTs JSON (no auth) and returns outputs", async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, json: async () => ({ result: { netProfitAfterPPC: 1 } }) };
  };
  const out = await callApi({ price: 1 }, fakeFetch);
  assert.equal(out.netProfitAfterPPC, 1);
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers["Content-Type"], "application/json");
  assert.equal(seen.opts.headers.Authorization, undefined); // public endpoint, no auth
});

test("callApi throws on non-200", async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(() => callApi({}, fakeFetch), /HTTP 500/);
});

test("callApi throws when outputs missing", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(() => callApi({}, fakeFetch), /missing result/);
});

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

test("main hard-stops with no results.js when any product fails", async () => {
  const dir = await makeRun();
  const fakeFetch = async (_u, opts) => {
    const body = JSON.parse(opts.body);
    if (body.price === 22.0) return { ok: false, status: 500, text: async () => "boom" };
    return { ok: true, status: 200, json: async () => ({ result: stubOut(8) }) };
  };
  await assert.rejects(() => main(dir, "kw", { fetchImpl: fakeFetch }), /Calc failed/);
  await assert.rejects(() => rf(pjoin(dir, "results.js")), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test("main writes results.js with survivors on happy path", async () => {
  const dir = await makeRun();
  const fakeFetch = async (_u, opts) => {
    const body = JSON.parse(opts.body);
    // B1 profitable, B2 unprofitable
    return { ok: true, status: 200, json: async () => ({ result: body.price === 22.0 ? stubOut(-2) : stubOut(6) }) };
  };
  const data = await main(dir, "storage basket", { fetchImpl: fakeFetch });
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

// Pack-count correction: Amazon packCount scales fob; 1688 cnPack rides through.
test("buildPayload: single inbound, flat head-ship, zero duty, fob×pack", () => {
  const product = { dim: { L: 9, W: 3, H: 3 }, weight: 1, price: 45.99, monthlyVolume: 100, packCount: 4 };
  const p = buildPayload(product, { fobUsd: 1.88 });
  assert.ok(Math.abs(p.fob - 7.52) < 1e-6);        // 1.88 × 4
  assert.ok(Math.abs(p.headShip - 1.20) < 1e-6);   // 0.30 × 4
  assert.equal(p.duty, 0);
  assert.equal(p.inboundOption, "single");
});

test("mapOutputs carries headShip and duty (per listing)", () => {
  const product = { ...SAMPLE_PRODUCT, packCount: 4 };
  const m = mapOutputs(product, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.headShip, 1.2);
  assert.equal(m.duty, 0);
  assert.equal(m.fobUsdPerListing, 2.76);
});

test("buildPayload defaults packCount to 1 when absent", () => {
  const product = { dim: { L: 9, W: 3, H: 3 }, weight: 1, price: 21.99, monthlyVolume: 100 };
  const p = buildPayload(product, { fobUsd: 0.76 });
  assert.equal(p.fob, 0.76);
});

test("mapOutputs carries packCount, cnPack and per-listing fob", () => {
  const product = { ...SAMPLE_PRODUCT, packCount: 4 };
  const fob = { ...SAMPLE_FOB, cnPack: 2 };
  const m = mapOutputs(product, fob, SAMPLE_OUTPUTS);
  assert.equal(m.packCount, 4);
  assert.equal(m.cnPack, 2);
  assert.equal(m.fobUsd, 0.69);
  assert.equal(m.fobUsdPerListing, 2.76);
});

test("mapOutputs defaults packCount and cnPack to 1", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.packCount, 1);
  assert.equal(m.cnPack, 1);
  assert.equal(m.fobUsdPerListing, 0.69);
});

// Regression: the CLI guard must fire when run directly, even when the script
// path contains spaces (the skill installs under ".../Application Support/...").
// A naive `file://${process.argv[1]}` guard silently no-ops on such paths.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";

test("CLI guard fires when invoked directly (no args → usage + exit 1)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const r = spawnSync(process.execPath, [joinPath(here, "calc.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: node calc\.mjs/);
});
