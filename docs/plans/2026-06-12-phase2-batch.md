# Phase 2 Batch Sourcing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SKILL.md Phase 2 (per-product 1688 image search) with the 1688 batch image-sourcing flow — one upload of all product images, one results page, per-image median + direct seller link.

**Architecture:** Documentation change to one file (`SKILL.md`, the whole Phase 2 block). One cohesive section replacement (a half-youyuan/half-batch file would be broken), a grep consistency sweep, then a live end-to-end research run on keyword "portable fly fan" as verification.

**Tech Stack:** Markdown; the documented procedure targets `mcp__Claude_in_Chrome__*` tools, in-page JavaScript, and `calc.mjs` (Phase 3, unchanged).

**Conventions:**
- Skill dir (all paths relative to it):
  `/Users/aronlee/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/4b58f008-d934-4080-bc1c-537644177e4d/e1bf8324-030e-448a-aa43-9319bd6ba425/skills/product-cost-analyze-for-fba/`
- **Not a git repo — no commits.** Each task ends when its verification passes.
- Set `SKILL_DIR` to the path above for the grep commands.

**Spec:** `docs/specs/2026-06-12-phase2-batch-design.md`

---

## File Structure

- **Modify:** `SKILL.md` — replace the entire Phase 2 block (`## Phase 2 …` through the line before `## Phase 3`). No other files. Phases 1, 3, 4 untouched.

---

## Task 1: Replace the whole Phase 2 section with the batch flow

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Read the current Phase 2** so the edit's old-text anchor is exact.

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | head -5`
This is the per-product (youyuan) version being replaced.

- [ ] **Step 2: Replace everything from `## Phase 2 — Image search for FOB on 1688.com (no fallback)` up to (but not including) `## Phase 3 — Calculate & write results.js`** with exactly this:

````markdown
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

5. **Extract per group** via `javascript_tool`. Prices render with a fullwidth
`￥`; matching on the numeric value sidesteps the symbol. Seller links are direct
`detail.1688.com/offer/<id>.html` hrefs:

```js
(function(){
  const headers = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount === 0 && e.textContent.trim() === '已为您找到相似货源');
  function groupRoot(h){ let n=h; for(let i=0;i<8&&n;i++){ if(n.querySelectorAll('a[href*="detail.1688.com/offer"]').length>=1 && /¥|￥/.test(n.textContent)) return n; n=n.parentElement;} return h.parentElement; }
  const groups = headers.map((h, idx) => {
    const root = groupRoot(h);
    const prices = [];
    root.querySelectorAll('[class*=priceMain]').forEach(el => {
      const v = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
      if (v >= 2 && v <= 80) prices.push(v);
    });
    const u = [...new Set(prices)].sort((a,b) => a-b);
    const mid = Math.floor(u.length/2);
    const median = u.length ? (u.length % 2 ? u[mid] : (u[mid-1]+u[mid])/2) : 0;
    const link = root.querySelector('a[href*="detail.1688.com/offer"]');
    return { i: idx+1, count: u.length, median, sellerUrl: link ? link.href.split('?')[0] : '' };
  });
  return JSON.stringify(groups);
})()
```

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
    "sellerUrl": "https://detail.1688.com/offer/123456789.html"
  }
]
```

`fobUsd = fobRmb / 7.2`. `candidates` is the per-image price count (typically 1–2
from the batch tool). `sellerUrl` is the first matched product's direct
`detail.1688.com/offer/<id>.html` link.

> **Only write `fob.json` after all products map cleanly** (group count ==
> product count, no 0-match product). A partial fob.json means Phase 3 cannot
> run.

### 2.5 Hygiene

Submitting `帮我寻源` creates a real sourcing task on the user's 1688 account each
run (async; visible under 历史任务 / 询盘结果). Close the batchDetail tab when done.
No images are written to disk. `fob.json` may contain session-derived data; do
not share or commit it.
````

- [ ] **Step 3: Verify the section landed and the old per-product flow is gone.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "图片批量找"`
Expected: `1`.
Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "youyuan"`
Expected: `0` (the per-product results page is gone).

---

## Task 2: Consistency sweep

**Files:** none (verification only)

- [ ] **Step 1: New batch anchors all present.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -cE "ai-avatar/procurement|帮我寻源|1688-batch|STAGED|batchDetail|已为您找到相似货源"`
Expected: `≥6`.

- [ ] **Step 2: Setup gate present (ask-user-to-open, no auto-login).**

Run: `sed -n '/### 2.1 Setup/,/### 2.3/p' "$SKILL_DIR/SKILL.md" | grep -cE "stop and ask the user|never automate sign-in"`
Expected: `≥1` for each phrase (run both):
Run: `sed -n '/### 2.1 Setup/,/### 2.3/p' "$SKILL_DIR/SKILL.md" | grep -c "never automate"`
Expected: `1`.

- [ ] **Step 3: Old per-product trigger and disk steps gone.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -cE "搜索图片|fob-tmp|s\.1688\.com/youyuan"`
Expected: `0`.

- [ ] **Step 4: Hard-stop rules present.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "no estimation"`
Expected: `≥1`. And the removed threshold is gone:
Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "count < 3"`
Expected: `0`.

---

## Task 3: Live end-to-end research run — keyword "portable fly fan"

**Files:** writes a new run dir `/Users/aronlee/Documents/product-research/portable-fly-fan/`

> Full pipeline test of the rewritten skill. Runs in this session (needs the live
> MCP + the user's logged-in 1688). Follow the current SKILL.md exactly.

- [ ] **Step 1: Phase 1 (Amazon).** Per SKILL.md Phase 1: create the run dir,
search `https://www.amazon.com/s?k=portable+fly+fan&rh=p_36%3A1000-5000&language=en_US`
via the Chrome MCP, extract the top 10 products with the §1.3 eval, visit each
detail page for dimensions (§1.4), and write
`/Users/aronlee/Documents/product-research/portable-fly-fan/products.json`.
Expected: 10 products with asin/title/price/monthlyVolume/imageUrl/dim/weight.

- [ ] **Step 2: Phase 2 (batch 1688).** Per the rewritten Phase 2: ensure a
logged-in `air.1688.com/...procurement` tab exists (ask the user to open + log in
if not), inject all 10 product image URLs, submit `帮我寻源`, poll to completion,
extract the 10 groups, order-map to ASINs, and write
`/Users/aronlee/Documents/product-research/portable-fly-fan/fob.json`.
Expected: 10 fob entries, `source:"1688-batch"`, each with a numeric `fobRmb` and
a `detail.1688.com/offer/<id>.html` sellerUrl. If blocked/incomplete, follow the
⛔ hard-stop and wait for the user.

- [ ] **Step 3: Phase 3 (calc).** Run:
`node "$SKILL_DIR/calc.mjs" "/Users/aronlee/Documents/product-research/portable-fly-fan" "portable fly fan"`
Expected: `Wrote results.js — N survivors, M eliminated.` (N+M=10), exit 0.

- [ ] **Step 4: Phase 4 (report).** Copy the template and serve it:
Run: `cp "$SKILL_DIR/report-template.html" "/Users/aronlee/Documents/product-research/portable-fly-fan/report.html"`
Then start a server from the run dir (`python3 -m http.server 7844 --directory /Users/aronlee/Documents/product-research/portable-fly-fan`) and load `http://localhost:7844/report.html` via the Chrome MCP.
Expected: report renders `window.__FBA_DATA__` with the keyword, survivor cards
showing 🛒 Amazon and 🏭 1688 links, and sane whole-percent margins.

- [ ] **Step 5: Sanity-check the output.** Confirm
`results.js` has survivors+eliminated = 10, margins are whole-percent (e.g. ~25,
not 0.25), and each card's 1688 link is a real `detail.1688.com/offer` URL.
Report the survivor table to the user.

---

## Self-Review

**Spec coverage:**
- §2.1 setup gate (detect tab / ask user to open + login, no auto-login) → Task 1 §2.1 + Task 2 step 2 ✓
- Block-probe → Task 1 §2.3.1 ✓
- Inject all images one-pass, require STAGED N/N → Task 1 §2.3.2 ✓
- Real pointer-click submit → Task 1 §2.3.3 ✓
- Poll to completion → Task 1 §2.3.4 ✓
- Per-group extraction (priceMain ¥2–80, direct offer link) → Task 1 §2.3.5 ✓
- Order mapping + count-equality check → Task 1 §2.3.6 ✓
- Hard-stop rules, count≥3 removed → Task 1 §2.3.7 + Task 2 step 4 ✓
- fob.json shape `source:"1688-batch"` → Task 1 §2.4 ✓
- Account-action note + close tab → Task 1 §2.5 ✓
- No youyuan fallback / per-product flow removed → Task 1 §2.3 + Task 2 step 3 ✓
- Verification on a real run → Task 3 (portable fly fan) ✓

**Placeholder scan:** none. `URLS`, `<id>`, `B0EXAMPLE`, `X/N`, `N` are
intentional substitution markers documented in-line.

**Consistency:** field names (`median`/`count` → `fobRmb`/`candidates`,
`sellerUrl`) match §2.4 and what `calc.mjs` reads from fob.json; the block-probe,
inject, poll, and extract snippets match the spec verbatim.
