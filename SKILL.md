---
name: product-cost-analyze-for-fba
description: Perform FBA product-cost analysis for ecommerce sellers. Given a product keyword, drive the user's logged-in Chrome via the Claude-in-Chrome MCP to capture top Amazon listings (volume from "bought in past month" badges), batch reverse-image-search 1688.com for wholesale FOB prices, compute FBA fees via the Profitlee calc API, and render a static HTML profitability report.
---

# Product Research Procedure

A reusable browser automation for fetching product data and estimating FBA profitability. The user provides a product keyword; the skill drives the user's logged-in Chrome through the **Claude-in-Chrome MCP** to find matching products on Amazon (monthly volume from the **"bought in past month"** badges), batch reverse-image-searches **1688.com** for a wholesale FOB reference, runs the FBA profitability formula (via the **Profitlee** calc API), and writes a `results.js` data file that the bundled **static HTML template** renders — so the HTML is never regenerated and costs zero tokens per run.

## Output files (per run)

All outputs go into a run directory, e.g. `~/Documents/product-research/<keyword>/`:

| File | Written by | Description |
|---|---|---|
| `products.json` | Phase 1 | Amazon listings |
| `fob.json` | Phase 2 | 1688 FOB prices |
| `results.js` | Phase 3 | `window.__FBA_DATA__ = {...}` — loaded by the template |
| `report.html` | **one-time copy** | Copy of the bundled template (copy, don't regenerate) |

**This skill is a single file.** A user only needs `SKILL.md` — the two runtime
assets are produced on demand into the run dir:
- `calc.mjs` (Phase 3 helper) is **written from the copy embedded in this file** (§3.2). No dependencies beyond Node ≥18 built-ins.
- `report-template.html` (Phase 4 renderer) is **fetched from the skill's repo** on first run (§Phase 4) and saved as `report.html`.

See Phase 4 for serving + opening the report.

## Preconditions & setup (read once)

### Preconditions — accounts & tools the user must have

The skill drives the user's **live Chrome**, so every login below lives in that
one browser profile. Log into Amazon and 1688 there **before** starting.

| Requirement | Needed for | Required? |
|---|---|---|
| Chrome + the **Claude-in-Chrome MCP** extension, connected | browser driver for the whole workflow | **Required** |
| **1688.com account, logged in** (same Chrome profile) | Phase 2 batch image sourcing — submitting `帮我寻源` creates a real sourcing task on the account | **Required** |
| Internet access to **Profitlee's public calc API** (no token — see [docs](https://profitlee.com/docs/api)) | Phase 3 FBA-fee calculation | **Required** |
| **Node.js ≥ 18** | runs the Phase 3 `calc.mjs` helper (written to the run dir) — needs built-in `fetch` | **Required** |
| **Python 3** (or any static file server) | serves the report over http (Phase 4) | **Required** |
| **Amazon** — a logged-in Chrome profile | Phase 1 scraping (anonymous browsing works but trips bot-detection/CAPTCHA more often) | Recommended |
| **Helium 10** extension + account | richer per-product sales volume; otherwise volume is estimated from the "bought in past month" badge | Optional |

If a required item is missing the run cannot complete — e.g. no Profitlee token
hard-stops Phase 3, and a logged-out 1688 hard-stops Phase 2 (the skill asks the
user to resolve it rather than working around it).

### Driver — Claude-in-Chrome MCP

This skill drives the user's own logged-in Chrome through the **Claude-in-Chrome
MCP** (`mcp__Claude_in_Chrome__*`) for **both phases** — no API key, no credits,
and the live session already holds the user's Amazon and 1688 login cookies.
(An earlier `browser-act` CLI path was dropped — it failed to connect reliably.)

Tools used throughout:
- `list_connected_browsers` / `select_browser` — pick the local Chrome.
- `tabs_context_mcp` (with `createIfEmpty: true`) / `tabs_create_mcp` / `tabs_close_mcp` — manage the working tab(s).
- `navigate` — drive the tab to a URL.
- `javascript_tool` — run in-page `eval` for extraction (preferred over `get markdown`; far fewer tokens).
- `computer` — `screenshot` and **real pointer clicks** (needed where a JS click won't trigger a gesture-gated action; see Phase 2).

> **No automated login or CAPTCHA solving.** If a site shows a login wall or a
> verification slider, stop and ask the user to resolve it, then continue.

### Profitlee calc API (public — no token)

Phase 3 calls **Profitlee's public calc engine** at
`https://profitlee.com/api/v1/calculate` — no API key, no auth, nothing to set
up. Full API reference: <https://profitlee.com/docs/api>.

## Phase 1 — Keyword search on Amazon (Claude-in-Chrome MCP)

Goal: capture the top 10 products (ASIN, title, price, volume, image, pack count) filtered to a $10–$50 price band.

### 1.1 Browser setup

Connect to the user's Chrome via the MCP:
1. `mcp__Claude_in_Chrome__list_connected_browsers` → `select_browser` with the
   local browser's `deviceId`.
2. `mcp__Claude_in_Chrome__tabs_context_mcp` with `createIfEmpty: true` to get a
   working tab; note its `tabId` and reuse it through Phase 1.

### 1.2 Navigate to filtered search

Encode the $10–$50 price band directly in the URL — faster and more reliable than clicking the left-rail filter. `mcp__Claude_in_Chrome__navigate` the tab to:

```
https://www.amazon.com/s?k=<keyword>&rh=p_36%3A1000-5000&language=en_US
```

(`p_36%3A1000-5000` = cents, so $10–$50.)

### 1.3 Extract product data with eval (not get markdown)

`get markdown` on an Amazon search page returns ~40,000 tokens of navigation chrome, chat widgets, and keyboard shortcuts — almost none of it useful. Run a targeted `javascript_tool` eval instead. It also parses **monthly volume** from the "bought in past month" badge and the **pack count** from the title (Phase 3 multiplies FOB by it):

```js
(function(){
  function vol(t){ if(!t) return 100; const m=t.match(/([\d.]+)K\+/i); if(m) return Math.round(parseFloat(m[1])*1000); const n=t.match(/(\d+)\+/); return n?parseInt(n[1]):100; }
  function pk(t){ const m=(t.match(/(\d+)\s*-?\s*pack/i)||t.match(/pack of\s*(\d+)/i)||t.match(/set of\s*(\d+)/i)||t.match(/(\d+)\s*-?\s*pk\b/i)||t.match(/(\d+)\s*(?:pcs|pc|pieces|count)\b/i)||t.match(/(\d+)\s*each\b/i)); return m?parseInt(m[1],10):1; }
  const seen=new Set();
  return JSON.stringify(
    Array.from(document.querySelectorAll('.s-result-item[data-asin]:not([data-asin=""])')).slice(0,25).map(el=>{
      const asin=el.getAttribute('data-asin'); if(seen.has(asin)) return null; seen.add(asin);
      const title=(el.querySelector('h2 span')||{}).textContent||'';
      const pe=el.querySelector('.a-price .a-offscreen');
      const price=pe?parseFloat(pe.textContent.replace(/[^0-9.]/g,'')):null;
      const be=el.querySelector('.a-size-base.a-color-secondary:not(.a-text-normal)');
      const bought=be?be.textContent.trim():'';
      const ie=el.querySelector('img.s-image');
      const imageUrl=(ie?ie.src:'').replace('_AC_UL320_','_AC_UL640_');
      const packCount=pk(title);
      return { asin, title, price, monthlyVolume:vol(bought), volumeSource:'badge', imageUrl, amazonUrl:'https://www.amazon.com/dp/'+asin, packCount, packSource: packCount>1?'title':'default' };
    }).filter(p=>p&&p.asin&&p.title&&p.price).slice(0,10)
  );
})()
```

Volume comes from the Amazon "bought in past month" badge (`"10K+" → 10000`, `"1K+" → 1000`, `"500+" → 500`, etc.; `volumeSource: "badge"`). Helium 10 is **optional** — if the extension is installed and shows per-product units, use those and set `volumeSource: "helium10"` — but it is not required.

> **`window.*` page variables are cleared by navigation.** If you stash results on `window`, capture the image URLs (and anything else you need) before visiting detail pages in §1.4 — or just re-extract `asin → imageUrl` from the search page afterward. Page-scoped state does not survive a `navigate`.

### 1.4 Get product dimensions

Phase 3 needs L/W/H/weight. For each ASIN, `mcp__Claude_in_Chrome__navigate` to the detail page, then `javascript_tool` eval the product-info table:

```js
(function(){
  const rows=[...document.querySelectorAll('#productDetails_techSpec_section_1 tr, #prodDetails tr, #detailBullets_feature_div li')];
  let dim='', wt='';
  for(const r of rows){
    const t=r.textContent.replace(/\s+/g,' ');
    if(/dimension/i.test(t)&&!dim) dim=t.trim();
    if(/item weight/i.test(t)&&!/shipping/i.test(t)&&!wt) wt=t.trim();
  }
  return JSON.stringify({ dim: dim.slice(0,120), wt: wt.slice(0,60) });
})()
```

Parse `"... 13.7 x 5.31 x 1.57 inches"` → `{L:13.7, W:5.31, H:1.57}` and `"8.8 ounces"` → `weight: 0.55 lb` (ounces ÷ 16).  
If a listing has no dimensions, use category-typical estimates and flag as `dimsSource: "estimated"` in `products.json`.

### 1.5 Write products.json

**Pack count.** Amazon listings are often multipacks; the listing price covers
all units, but the 1688 FOB is per single unit, so Phase 3 multiplies FOB by the
pack count. Parse the title and record `packCount` (int) and `packSource`.
Patterns (case-insensitive): `N Pack`, `N-Pack`, `Npack`, `Pack of N`,
`Set of N`, `N pcs|pc|pieces|count`. No match → `packCount: 1,
packSource: "default"` (a true single, or a missed pack).

```json
[
  {
    "asin": "B0EXAMPLE",
    "title": "Product title",
    "amazonUrl": "https://www.amazon.com/dp/B0EXAMPLE",
    "price": 24.99,
    "monthlyVolume": 3000,
    "volumeSource": "badge",
    "imageUrl": "https://m.media-amazon.com/images/I/example._AC_UL640_.jpg",
    "dim": { "L": 13.7, "W": 5.3, "H": 1.6 },
    "weight": 0.55,
    "dimsSource": "scraped",
    "packCount": 4,
    "packSource": "title"
  }
]
```

> **Pagination cursor:** track the current page and seen ASINs so a retry can fetch the next page without overlap.

## Phase 2 — Batch image sourcing for FOB on 1688.com (no fallback)

Goal: upload all product images at once to 1688's batch image-sourcing tool
("图片批量找") and extract a wholesale FOB reference + a seller link per product
from the single results page. **Real 1688 data only — no estimation, no Taobao
fallback. If access is blocked, stop and wait for the user to resolve it.**

### 2.1 Setup — require a logged-in batch tab

The batch tool lives at
`https://air.1688.com/kapp/1688-pc-front/ai-avatar/procurement?tab=imageBatch`
and requires login. Login must be done by the user — never automate sign-in.

1. `mcp__Claude_in_Chrome__list_connected_browsers` → `select_browser`, then
   `mcp__Claude_in_Chrome__tabs_context_mcp`.
2. Look for an existing tab whose URL contains
   `air.1688.com/kapp/1688-pc-front/ai-avatar/procurement`.
3. **If none is found, stop and ask the user** to open
   `https://air.1688.com/kapp/1688-pc-front/ai-avatar/procurement?tab=imageBatch`
   and log in, then confirm. Do NOT auto-navigate there or attempt login.
4. Once the tab exists and is logged in, use it as the working tab. If it is not
   on `?tab=imageBatch`, `navigate` it there. Then run the §2.3 step-1
   block-probe before proceeding.

### 2.2 (removed)

Images are injected from their URLs in §2.3 — there is no disk download step.

### 2.3 Batch search

1. **Block-probe** (a CAPTCHA can appear even when logged in). Run via
   `javascript_tool` on the batch tab:

```js
(function(){
  const t = document.title || '';
  const x = (document.body ? document.body.innerText : '').slice(0, 800);
  const blocked = /captcha|interception|验证|滑动|滑块|unusual traffic/i.test(t + ' ' + x);
  return JSON.stringify({ blocked, title: t.slice(0, 60) });
})()
```

If `blocked:true`, hard-stop (step 7).

2. **Inject all images** from products.json `imageUrl`s (in array order) into the
single `multiple` file input, in one pass. Substitute the real URL array for
`URLS`:

```js
(async function(urls){
  const inp = [...document.querySelectorAll('input[type=file]')]
    .find(el => el.multiple && /image/.test(el.accept));
  if (!inp) return 'NO_MULTI_INPUT';
  const dt = new DataTransfer(); let ok = 0;
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await fetch(urls[i]); if (!r.ok) continue;
      const b = await r.blob();
      dt.items.add(new File([b], 'img' + i + '.jpg', { type: b.type || 'image/jpeg' }));
      ok++;
    } catch (e) {}
  }
  inp.files = dt.files;
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  return 'STAGED ' + ok + '/' + urls.length;
})(URLS)
```

Require `STAGED N/N`. Fewer than N → an image URL failed; hard-stop and fix
products.json.

3. **Wait for upload** to read `上传成功`, then **submit with a REAL pointer
click** on the `帮我寻源` button: `mcp__Claude_in_Chrome__computer` `screenshot`
to locate it, then `computer left_click` by coordinate. A JS `.click()` will not
submit (1688 opens the result via a gesture-gated action). The tab navigates to
`…/procurement/batchDetail?taskId=<id>&tab=imageBatch`.

4. **Poll until done.** The detail page streams results and shows progress
`搜索匹配商品中 X/N`; processing takes ~1–2 min. Poll every ~20–30 s with:

```js
(function(){
  const m = document.body.innerText.match(/搜索匹配商品中\s*(\d+)\/(\d+)/);
  const groups = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && e.textContent.trim() === '已为您找到相似货源').length;
  return JSON.stringify({ progress: m ? m[0] : '(none)', groups });
})()
```

Done when `progress` is `(none)` and `groups` equals N.

5. **Extract per group, normalized per unit** via `javascript_tool`. Each group's
matched cards carry a title, a price, and a direct `detail.1688.com/offer/<id>.html`
link. Read the **full price from the card's `¥X.XX` text** — the `priceMain`
element holds only the integer part for cheap items (¥1.75 → "1"). A 1688 price
may cover a set (e.g. `4个装`), so divide each card's price by its set size
(`cnPack`, parsed from the title) **before** taking the median — the result is a
per-single-unit FOB. Band is ¥0.5–80 (real single-unit wholesale runs as low as
~¥1; this still drops ¥0.03-type junk):

```js
(function(){
  function cnPackOf(t){
    t = t || '';
    const m = t.match(/(\d+)\s*(?:个|只|支|件|台|条|包|盒|套|组)\s*装/)
           || t.match(/(\d+)\s*件套/)
           || t.match(/(\d+)\s*(?:个|只|支|件)\s*[\/／]\s*(?:套|包|盒|组)/)
           || t.match(/(\d+)\s*(?:pcs?|pack)/i);
    const n = m ? parseInt(m[1],10) : 1;
    return (n >= 1 && n <= 50) ? n : 1;
  }
  const headers = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && e.textContent.trim() === '已为您找到相似货源');
  function groupRoot(h){ let n=h; for(let i=0;i<8&&n;i++){ if(n.querySelectorAll('a[href*="detail.1688.com/offer"]').length>=1 && /¥|￥/.test(n.textContent)) return n; n=n.parentElement;} return h.parentElement; }
  const groups = headers.map((h, idx) => {
    const root = groupRoot(h);
    const cards = [...root.querySelectorAll('a[href*="detail.1688.com/offer"]')].map(a => {
      let card = a;
      for (let i = 0; i < 6 && card.parentElement; i++) { if (card.querySelector && card.querySelector('[class*=priceMain]')) break; card = card.parentElement; }
      const ym = (card.textContent || '').match(/[¥￥]\s*(\d+\.?\d*)/);
      const price = ym ? parseFloat(ym[1]) : NaN;
      const title = (card.textContent || '').replace(/\s+/g,' ').trim().slice(0,60);
      return { title, price, offerUrl: a.href.split('?')[0], cnPack: cnPackOf(title) };
    });
    const perUnit = cards.map(c => c.price / c.cnPack).filter(v => v >= 0.5 && v <= 80);
    const u = [...new Set(perUnit)].sort((a,b) => a-b);
    const mid = Math.floor(u.length/2);
    const median = u.length ? (u.length % 2 ? u[mid] : (u[mid-1]+u[mid])/2) : 0;
    const first = cards[0] || {};
    return { i: idx+1, count: u.length, median, sellerUrl: first.offerUrl || '', cnPack: first.cnPack || 1, matchedTitle: first.title || '' };
  });
  return JSON.stringify(groups);
})()
```

`fobRmb = median` (per single unit), `candidates = count`; `cnPack` and
`matchedTitle` describe the chosen offer (surfaced so a missed set is catchable).

6. **Map by upload order:** group `i` ↔ products[`i`-1]. Sanity-check
`groups.length === products.length`; mismatch → hard-stop.

7. **Hard-stop rules (no estimation).** Stop and wait for the user (then retry)
when any of these holds — never estimate or fall back:
- block-probe `blocked:true` → ask the user to solve the CAPTCHA / re-login;
- `STAGED` count < N → an image URL failed;
- `groups.length !== products.length` after completion → order mapping unsafe;
- any product group has 0 prices in ¥2–80 → that product is unmatched.
Otherwise accept the group median even when `count` is 1–2.

> ⛔ **1688 batch blocked / incomplete.** Resolve access (log in / solve the
> slider) or fix the failing input, confirm here, then re-run Phase 2. There is
> no fallback — FOB must come from a live 1688 batch result.

### 2.4 Write fob.json

```json
[
  {
    "asin": "B0EXAMPLE",
    "matched": true,
    "source": "1688-batch",
    "fobRmb": 7.3,
    "fobUsd": 1.01,
    "candidates": 2,
    "cnPack": 1,
    "matchedTitle": "驱蝇器黑色 电池款",
    "sellerUrl": "https://detail.1688.com/offer/123456789.html"
  }
]
```

`fobRmb` and `fobUsd` are **per single unit** (`fobUsd = fobRmb / 7.2`).
`candidates` is the per-image price count (typically 1–2 from the batch tool).
`cnPack` is the matched offer's set size (units its price covers; usually 1) and
`matchedTitle` is its name — both surfaced so a missed set is catchable.
`sellerUrl` is the first matched product's direct
`detail.1688.com/offer/<id>.html` link.

> **Only write `fob.json` after all products map cleanly** (group count ==
> product count, no 0-match product). A partial fob.json means Phase 3 cannot
> run.

### 2.5 Hygiene

Submitting `帮我寻源` creates a real sourcing task on the user's 1688 account each
run (async; visible under 历史任务 / 询盘结果). Close the batchDetail tab when done.
No images are written to disk. `fob.json` may contain session-derived data; do
not share or commit it.

## Phase 3 — Calculate & write results.js

The FBA math lives in Profitlee's tested calc engine, not in this skill. Phase 3
sends each product to `POST https://profitlee.com/api/v1/calculate` (public, no auth) and writes
`results.js` from the responses. Do **not** hand-roll fee tables here.

### 3.1 Preconditions

- `<run-dir>/products.json` and `<run-dir>/fob.json` both exist and cover the
  same ASINs (Phase 2 completed with no hard-stop).
- Internet access (Phase 3 POSTs to Profitlee's public calc API — no token).

### 3.2 Write and run the calc helper

The helper has **no dependencies** (Node ≥18 built-ins only). Write the script
below verbatim to `<run-dir>/calc.mjs`, then run it:

```bash
node "<run-dir>/calc.mjs" "<run-dir>" "<keyword>"
```

It fires all products in parallel, maps the API outputs into the report
template's shape (margins as whole percents; `ppcCost`/`returnLoss`/`tier` field
names; `fob = fobUsd × packCount`), filters survivors (`netProfitAfterPPC > 0`),
sorts by net margin then monthly net, badges the top 3 with margin ≥ 15%, and
writes `<run-dir>/results.js`.

Write this to `<run-dir>/calc.mjs`:

```js
// calc.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const API_URL = "https://profitlee.com/api/v1/calculate";

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

export async function main(runDir, keyword, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;

  const products = JSON.parse(await readFile(join(runDir, "products.json"), "utf8"));
  const fob = JSON.parse(await readFile(join(runDir, "fob.json"), "utf8"));
  const fobMap = new Map(fob.map((f) => [f.asin, f]));

  const settled = await Promise.allSettled(
    products.map(async (p) => {
      const f = fobMap.get(p.asin);
      if (!f) throw new Error(`no fob.json entry`);
      const outputs = await callApi(buildPayload(p, f), fetchImpl);
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
```

### 3.3 Hard-stop on failure

If any product's API call fails (non-200, validation error, network),
`calc.mjs` exits non-zero, prints the failing ASIN(s), and writes **no**
`results.js`. Resolve the cause (e.g. set the token, retry transient network)
and re-run — never edit `results.js` by hand.

The inputs `calc.mjs` sends per product: physical dims + weight (products.json),
`fob`=fobUsd×packCount, `headShip`=$0.30×packCount, `duty`=0, price + monthlyVolume,
and the standing assumptions (`ppcAcos` 0.20, `returnRate` 0.05, `referralPct`
0.15, `inboundOption` "single", `storageMonths` 1, `storageSeason` "janSep").

## Phase 4 — Open report

Fetch the report renderer from the skill's repo (first run only — skip if
`report.html` already exists in the run dir), then serve it over http and open
it. `report.html` loads `results.js` via a `<script>` tag, which a `file://` URL
can't read (the browser blocks the local sub-resource fetch), so serve the run dir:

```bash
[ -f "<output-dir>/report.html" ] || curl -fsSL \
  https://raw.githubusercontent.com/AronLEEdev/product-cost-analyze-skill/main/report-template.html \
  -o "<output-dir>/report.html"
python3 -m http.server 7860 --directory "<output-dir>" &
```

Then `mcp__Claude_in_Chrome__navigate` to `http://localhost:7860/report.html`
(use a fresh port if a prior server is caching an old `results.js`). The template
reads `results.js` and renders everything client-side — no HTML generation, zero
tokens spent on the report on every subsequent run.
