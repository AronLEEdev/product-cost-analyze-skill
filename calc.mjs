// calc.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const API_URL = "https://profitlee.com/api/v1/calculate";

const CONSTANTS = {
  region: "us",
  // Advertising is NOT priced here. Margins are before ads; the product-ppc-analysis
  // skill prices ads from market suggested bids. A flat ACoS guess hid products whose
  // clicks cost more than a sale earns (a $13.99 item with $2.50 clicks still "passed").
  ppcAcos: 0,
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
    returnLoss: outputs.returnLossPerUnit,
    ...beforeAds(product, outputs),
    recommended: false,
    badge: null,
  };
}

/** Profit and cash per sale BEFORE advertising.
 *  profitBeforePPC = Profitlee net profit with any ad cost added back (0 when ppcAcos is 0).
 *  marginBeforePPC (whole %) is also the break-even ACoS: ads may take up to this share of
 *  the price before the sale loses money.
 *  cashPerSale = what a sale pays out once stock and freight are already paid:
 *  price − referral − FBA fulfilment − return loss. The PPC skill uses it for the cash view. */
export function beforeAds(product, outputs) {
  const num = (v) => (v == null ? null : Number(v)); // Number(null) === 0 trap
  const net = num(outputs.netProfitAfterPPC);
  const ad = num(outputs.ppcCostPerUnit) ?? 0;
  if (net == null || !Number.isFinite(net)) throw new Error("missing netProfitAfterPPC in calc outputs");
  const profit = net + ad;
  const price = Number(product.price);
  const parts = [outputs.referralFee, outputs.fulfillmentFee, outputs.returnLossPerUnit].map(num);
  const cash = parts.some((v) => v == null || !Number.isFinite(v)) ? null : price - parts[0] - parts[1] - parts[2];
  return {
    profitBeforePPC: +profit.toFixed(4),
    marginBeforePPC: +((profit / price) * 100).toFixed(2),
    monthlyBeforePPC: Math.round(profit * (Number(product.monthlyVolume) || 0)),
    cashPerSale: cash == null ? null : +cash.toFixed(4),
  };
}

/** Badge threshold: margin before ads, whole percent (Aron, Nov 14 2026). */
export const BADGE_MARGIN_BEFORE_PPC = 30;

export function selectAndRank(mapped) {
  const survivors = mapped.filter((p) => p.profitBeforePPC > 0);
  const eliminated = mapped.filter((p) => p.profitBeforePPC <= 0);
  survivors.sort((a, b) =>
    b.marginBeforePPC !== a.marginBeforePPC
      ? b.marginBeforePPC - a.marginBeforePPC
      : b.monthlyBeforePPC - a.monthlyBeforePPC
  );
  let badge = 0;
  for (const s of survivors) {
    if (badge < 3 && s.marginBeforePPC >= BADGE_MARGIN_BEFORE_PPC) {
      s.recommended = true;
      s.badge = ++badge;
    }
  }
  return { survivors, eliminated };
}

export async function callApi(payload, fetchImpl = fetch) {
  const res = await fetchImpl(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const out = json.result || json.outputs; // v1 wraps in `result`; `outputs` kept for back-compat
  if (!out) throw new Error("missing result in response");
  return out;
}

export async function emitPayloads(runDir) {
  const products = JSON.parse(await readFile(join(runDir, "products.json"), "utf8"));
  const fob = JSON.parse(await readFile(join(runDir, "fob.json"), "utf8"));
  const fobMap = new Map(fob.map((f) => [f.asin, f]));
  const payloads = products.map((p) => {
    const f = fobMap.get(p.asin);
    if (!f) throw new Error(`no fob.json entry for ${p.asin}`);
    return { asin: p.asin, payload: buildPayload(p, f) };
  });
  await writeFile(join(runDir, "payloads.json"), JSON.stringify(payloads, null, 2));
  return payloads;
}

export async function main(runDir, keyword, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;

  const products = JSON.parse(await readFile(join(runDir, "products.json"), "utf8"));
  const fob = JSON.parse(await readFile(join(runDir, "fob.json"), "utf8"));
  const fobMap = new Map(fob.map((f) => [f.asin, f]));

  const settled = await Promise.allSettled(
    products.map(async (p) => {
      const f = fobMap.get(p.asin);
      if (!f) throw new Error(`no fob.json entry`);
      let outputs;
      if (opts.outputsByAsin) {
        const raw = opts.outputsByAsin[p.asin];
        if (!raw) throw new Error(`no outputs for ${p.asin}`);
        outputs = raw.result || raw; // tolerate {result: CalcOutputs} (MCP) or a raw CalcOutputs
      } else {
        outputs = await callApi(buildPayload(p, f), fetchImpl);
      }
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

  const bestMonthly = survivors.length ? Math.max(...survivors.map((s) => s.monthlyBeforePPC)) : 0;
  const marketInsight = survivors.length
    ? `${survivors.length} of ${mapped.length} products profitable before ads. Top margin before ads: ${survivors[0].marginBeforePPC.toFixed(1)}% (${survivors[0].asin}). Best monthly before ads: $${bestMonthly}/mo. Run product-ppc-analysis for the margin after ads.`
    : `0 of ${mapped.length} products profitable, even before ads.`;

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
      marginBasis: "beforeAds",
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
  const argv = process.argv.slice(2);
  const runDir = argv[0];
  const keyword = argv[1];
  const emitFlag = argv.includes("--emit-payloads");
  const outIdx = argv.indexOf("--outputs");
  const outputsFile = outIdx >= 0 ? argv[outIdx + 1] : null;
  if (!runDir || !keyword) {
    console.error('Usage: node calc.mjs <run-dir> "<keyword>" [--emit-payloads | --outputs <file>]');
    process.exit(1);
  }
  const run = async () => {
    if (emitFlag) {
      const payloads = await emitPayloads(runDir);
      console.log(`Wrote payloads.json — ${payloads.length} products.`);
      return;
    }
    let opts = {};
    if (outputsFile) {
      const path = isAbsolute(outputsFile) ? outputsFile : join(runDir, outputsFile);
      opts = { outputsByAsin: JSON.parse(await readFile(path, "utf8")) };
    }
    const d = await main(runDir, keyword, opts);
    console.log(`Wrote results.js — ${d.survivors.length} survivors, ${d.eliminated.length} eliminated.`);
  };
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
