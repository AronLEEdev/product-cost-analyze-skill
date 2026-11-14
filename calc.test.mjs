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
  // ad cost added back: 6.3935 + 4.398 = 10.7915 → 10.7915 / 21.99
  assert.equal(m.marginBeforePPC, 49.07);
});

test("mapOutputs reports profit before ads and drops the ad-cost guess", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.profitBeforePPC, 10.7915);
  assert.equal("ppcCost" in m, false);
  assert.equal("netProfitAfterPPC" in m, false);
  assert.equal("netMarginAfterPPC" in m, false);
});

test("mapOutputs gives cash per sale = price - referral - FBA - return loss", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.cashPerSale, +(21.99 - 3.2985 - 6.1272 - 0.4013).toFixed(4));
});

test("mapOutputs leaves cash per sale unknown (null, not 0) when a fee is missing", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, { ...SAMPLE_OUTPUTS, fulfillmentFee: null });
  assert.equal(m.cashPerSale, null);
});

test("mapOutputs throws when net profit is missing (no silent zero)", () => {
  assert.throws(() => mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, { ...SAMPLE_OUTPUTS, netProfitAfterPPC: null }), /missing netProfitAfterPPC/);
});

test("buildPayload sends no ad cost (ppcAcos 0)", () => {
  const p = buildPayload(SAMPLE_PRODUCT, SAMPLE_FOB);
  assert.equal(p.ppcAcos, 0);
});

test("mapOutputs renames API field names to template names", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.returnLoss, 0.4013);
  assert.equal(m.tier, "Large Standard");
});

test("mapOutputs rounds monthly net and passes through identity fields", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.monthlyBeforePPC, Math.round(10.7915 * 800));
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
  return { asin, profitBeforePPC: net, marginBeforePPC: margin, monthlyBeforePPC: monthly, recommended: false, badge: null };
}

test("selectAndRank splits survivors from eliminated on profit before ads > 0", () => {
  const { survivors, eliminated } = selectAndRank([mk("A", 5, 20, 100), mk("B", -1, -5, 0), mk("C", 0, 0, 0)]);
  assert.deepEqual(survivors.map((s) => s.asin), ["A"]);
  assert.deepEqual(eliminated.map((s) => s.asin).sort(), ["B", "C"]);
});

test("selectAndRank sorts by margin desc then monthly net desc", () => {
  const { survivors } = selectAndRank([mk("A", 5, 20, 100), mk("B", 5, 25, 50), mk("C", 5, 25, 900)]);
  assert.deepEqual(survivors.map((s) => s.asin), ["C", "B", "A"]);
});

test("selectAndRank badges top 3 with margin before ads >= 30", () => {
  const { survivors } = selectAndRank([
    mk("A", 5, 50, 100), mk("B", 5, 40, 100), mk("C", 5, 30, 100), mk("D", 5, 35, 100), mk("E", 5, 10, 100),
  ]);
  // sorted A 50, B 40, D 35, C 30 → first three badged
  assert.deepEqual(survivors.filter((s) => s.recommended).map((s) => [s.asin, s.badge]), [["A", 1], ["B", 2], ["D", 3]]);
  assert.equal(survivors.find((s) => s.asin === "C").badge, null);
  assert.equal(survivors.find((s) => s.asin === "E").badge, null);
});

test("selectAndRank does not badge margins under 30 even with <3 badged", () => {
  const { survivors } = selectAndRank([mk("A", 5, 29.99, 100), mk("B", 5, 12, 100)]);
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
    grossProfit: net + 0.4, grossMargin: 0.5, ppcCostPerUnit: 0, returnLossPerUnit: 0.4,
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

// calc.test.mjs  (append) — profitlee-mcp transport: emit-payloads + outputs modes
import { emitPayloads } from "./calc.mjs";

test("emitPayloads writes payloads.json keyed by asin with buildPayload args", async () => {
  const dir = await makeRun();
  const payloads = await emitPayloads(dir);
  assert.equal(payloads.length, 2);
  const written = JSON.parse(await rf(pjoin(dir, "payloads.json"), "utf8"));
  assert.deepEqual(written.map((e) => e.asin), ["B1", "B2"]);
  const b1 = written.find((e) => e.asin === "B1").payload;
  assert.equal(b1.mode, "fba");
  assert.equal(b1.inboundOption, "single");
  assert.equal(b1.duty, 0);
  assert.ok(Math.abs(b1.fob - 0.69) < 1e-6);       // fobUsd × packCount(1)
  assert.ok(Math.abs(b1.headShip - 0.30) < 1e-6);  // 0.30 × packCount(1)
  await rm(dir, { recursive: true, force: true });
});

test("emitPayloads scales fob and headShip by packCount", async () => {
  const dir = await mkdtemp(pjoin(tmpdir(), "fba-"));
  await wf(pjoin(dir, "products.json"), JSON.stringify([
    { asin: "P4", title: "T", amazonUrl: "u", imageUrl: "i", price: 45.99, monthlyVolume: 100, volumeSource: "badge", dim: { L: 9, W: 3, H: 3 }, weight: 1, packCount: 4 },
  ]));
  await wf(pjoin(dir, "fob.json"), JSON.stringify([{ asin: "P4", fobRmb: 13.5, fobUsd: 1.88, source: "1688", sellerUrl: "s" }]));
  const [{ payload }] = await emitPayloads(dir);
  assert.ok(Math.abs(payload.fob - 7.52) < 1e-6);      // 1.88 × 4
  assert.ok(Math.abs(payload.headShip - 1.20) < 1e-6); // 0.30 × 4
  await rm(dir, { recursive: true, force: true });
});

test("emitPayloads throws when a product has no fob entry", async () => {
  const dir = await mkdtemp(pjoin(tmpdir(), "fba-"));
  await wf(pjoin(dir, "products.json"), JSON.stringify([
    { asin: "B9", title: "T", amazonUrl: "u", imageUrl: "i", price: 21.99, monthlyVolume: 100, volumeSource: "badge", dim: { L: 9, W: 3, H: 3 }, weight: 1 },
  ]));
  await wf(pjoin(dir, "fob.json"), JSON.stringify([]));
  await assert.rejects(() => emitPayloads(dir), /no fob\.json entry for B9/);
  await rm(dir, { recursive: true, force: true });
});

test("main with outputsByAsin maps + ranks without any network", async () => {
  const dir = await makeRun();
  const throwFetch = async () => { throw new Error("network called"); };
  const data = await main(dir, "storage basket", {
    fetchImpl: throwFetch,
    outputsByAsin: { B1: stubOut(6), B2: stubOut(-2) },
  });
  const written = await rf(pjoin(dir, "results.js"), "utf8");
  assert.ok(written.startsWith("window.__FBA_DATA__ = "));
  assert.equal(data.survivors.length, 1);
  assert.equal(data.survivors[0].asin, "B1");
  assert.equal(data.eliminated.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("main unwraps a {result: ...} envelope in outputsByAsin (MCP shape)", async () => {
  const dir = await makeRun();
  const data = await main(dir, "kw", {
    fetchImpl: async () => { throw new Error("network called"); },
    outputsByAsin: { B1: { result: stubOut(6) }, B2: { result: stubOut(-2) } },
  });
  assert.equal(data.survivors.length, 1);
  assert.equal(data.survivors[0].asin, "B1");
  await rm(dir, { recursive: true, force: true });
});

test("main hard-stops (no results.js) when outputsByAsin misses an asin", async () => {
  const dir = await makeRun();
  await assert.rejects(
    () => main(dir, "kw", { outputsByAsin: { B1: stubOut(6) } }),
    /Calc failed/
  );
  await assert.rejects(() => rf(pjoin(dir, "results.js")), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test("CLI --outputs reads a file and writes results.js (exit 0)", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = await makeRun();
  await wf(pjoin(dir, "outputs.json"), JSON.stringify({ B1: stubOut(6), B2: stubOut(-2) }));
  const r = spawnSync(process.execPath, [joinPath(here, "calc.mjs"), dir, "kw", "--outputs", "outputs.json"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const written = await rf(pjoin(dir, "results.js"), "utf8");
  assert.ok(written.startsWith("window.__FBA_DATA__ = "));
  await rm(dir, { recursive: true, force: true });
});

test("CLI --emit-payloads writes payloads.json (exit 0)", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = await makeRun();
  const r = spawnSync(process.execPath, [joinPath(here, "calc.mjs"), dir, "kw", "--emit-payloads"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const written = JSON.parse(await rf(pjoin(dir, "payloads.json"), "utf8"));
  assert.equal(written.length, 2);
  await rm(dir, { recursive: true, force: true });
});
