// calc.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_URL = "https://profitlee.com/api/calculate";

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

export function deriveShipWeight(dim, weight) {
  const { L, W, H } = dim;
  const dimWeight = (Math.max(L, 2) * Math.max(W, 2) * Math.max(H, 2)) / 139;
  return Math.max(weight, dimWeight);
}

export function buildPayload(product, fobEntry) {
  const packCount = product.packCount || 1;
  const fob = fobEntry.fobUsd * packCount;
  return {
    mode: "fba",
    region: CONSTANTS.region,
    L: product.dim.L,
    W: product.dim.W,
    H: product.dim.H,
    weight: product.weight,
    fob,
    headShip: CONSTANTS.headShipPerUnit * packCount,
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
    packCount: product.packCount || 1,
    cnPack: fobEntry.cnPack || 1,
    fobUsdPerListing: +((fobEntry.fobUsd) * (product.packCount || 1)).toFixed(2),
    headShip: +(CONSTANTS.headShipPerUnit * (product.packCount || 1)).toFixed(2),
    duty: +((fobEntry.fobUsd) * (product.packCount || 1) * CONSTANTS.dutyRate).toFixed(2),
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

  for (const m of mapped) {
    const sum = m.fobUsdPerListing + m.headShip + m.duty;
    if (Math.abs(sum - m.landedCogs) > 0.05) {
      console.warn(`warn ${m.asin}: FOB+headShip+duty ($${sum.toFixed(2)}) != API landedCogs ($${m.landedCogs})`);
    }
  }

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
      headShipPerUnit: CONSTANTS.headShipPerUnit,
      inboundOption: CONSTANTS.inboundOption,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
