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

The bundled template lives at:
```
<skill-dir>/report-template.html
```
On first run, copy it to the output directory:
```bash
cp "<skill-dir>/report-template.html" "<output-dir>/report.html"
```
On subsequent runs for the same keyword, skip the copy — `report.html` is already there.  
Open the report after Phase 3 by serving the run dir over http and navigating to it.
A `file://` URL can't load `results.js` (the browser blocks the local sub-resource
fetch), so serve it:
```bash
python3 -m http.server 7860 --directory "<output-dir>" &
```
Then `mcp__Claude_in_Chrome__navigate` to `http://localhost:7860/report.html`.

## Preconditions & setup (read once)

### Preconditions — accounts & tools the user must have

The skill drives the user's **live Chrome**, so every login below lives in that
one browser profile. Log into Amazon and 1688 there **before** starting.

| Requirement | Needed for | Required? |
|---|---|---|
| Chrome + the **Claude-in-Chrome MCP** extension, connected | browser driver for the whole workflow | **Required** |
| **1688.com account, logged in** (same Chrome profile) | Phase 2 batch image sourcing — submitting `帮我寻源` creates a real sourcing task on the account | **Required** |
| **Profitlee API token** ([profitlee.com](https://profitlee.com)) in `~/.claude/settings.json` | Phase 3 FBA-fee calculation | **Required** |
| **Node.js ≥ 18** | runs `calc.mjs` (Phase 3) — needs built-in `fetch` + `node:test` | **Required** |
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
  function pk(t){ const m=(t.match(/(\d+)\s*-?\s*pack/i)||t.match(/pack of\s*(\d+)/i)||t.match(/set of\s*(\d+)/i)||t.match(/(\d+)\s*(?:pcs|pc|pieces|count)\b/i)); return m?parseInt(m[1],10):1; }
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

## Phase 4 — Open report

Copy the template, then serve it over http and open it. `report.html` loads
`results.js` via a `<script>` tag, which a `file://` URL can't read (the browser
blocks the local sub-resource fetch), so serve the run dir:

```bash
cp "<skill-dir>/report-template.html" "<output-dir>/report.html"
python3 -m http.server 7860 --directory "<output-dir>" &
```

Then `mcp__Claude_in_Chrome__navigate` to `http://localhost:7860/report.html`
(use a fresh port if a prior server is caching an old `results.js`). The template
reads `results.js` and renders everything client-side — no HTML generation, zero
tokens spent on the report on every subsequent run.
