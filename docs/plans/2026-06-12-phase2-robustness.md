# Phase 2 Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite SKILL.md Phase 2 (1688 image search) as a hardened, JS-driven procedure on the Claude-in-Chrome MCP, replacing the dead browser-act flow and the stale disk-upload / sellerUrl / hard-stop steps.

**Architecture:** Pure documentation change to one file (`SKILL.md`, §2.1–§2.5). Each task replaces one subsection with exact new markdown, verified by grep. Final task is a live browser run on 2–3 ASINs (no unit tests possible against a live anti-bot site).

**Tech Stack:** Markdown; the documented procedure targets `mcp__Claude_in_Chrome__*` tools and in-page JavaScript.

**Conventions:**
- Skill dir (all paths relative to it):
  `/Users/aronlee/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/4b58f008-d934-4080-bc1c-537644177e4d/e1bf8324-030e-448a-aa43-9319bd6ba425/skills/product-cost-analyze-for-fba/`
- **Not a git repo — no commits.** Each task ends when its grep verification passes.
- Before editing, read the current Phase 2: `SKILL.md` lines 196–313.

**Spec:** `docs/specs/2026-06-12-phase2-robustness-design.md`

---

## File Structure

- **Modify:** `SKILL.md` — §2.1 (browser setup), §2.2 (delete), §2.3 (per-product loop + 3 snippets), §2.4 (sellerUrl note), §2.5 (hygiene). No other files.

---

## Task 1: Rewrite §2.1 — MCP browser setup

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Replace the §2.1 block.** Replace the current text from the line `### 2.1 Session` up to (but not including) `### 2.2 Download images` with:

```markdown
### 2.1 Browser setup (Claude-in-Chrome MCP)

Phase 2 drives the user's live, logged-in Chrome through the Claude-in-Chrome
MCP (`mcp__Claude_in_Chrome__*`) — **not** browser-act. The live session already
holds 1688 login cookies, so no profile import or login step is needed.

1. `mcp__Claude_in_Chrome__list_connected_browsers` → `select_browser` with the
   local browser's `deviceId`.
2. `mcp__Claude_in_Chrome__tabs_context_mcp` with `createIfEmpty: true` to obtain
   a working **home tab**; note its `tabId`. Reuse this one tab for every
   product (each product re-navigates it; see §2.3a).

```

- [ ] **Step 2: Verify.**

Run: `sed -n '/### 2.1 Browser setup/,/### 2.2/p' "$SKILL_DIR/SKILL.md" | grep -c "list_connected_browsers"`
(where `SKILL_DIR` is the skill dir above)
Expected: `1`. And confirm no `browser-act` remains in this block:
Run: `sed -n '/### 2.1 Browser setup/,/### 2.2/p' "$SKILL_DIR/SKILL.md" | grep -c "browser-act"`
Expected: `0`.

---

## Task 2: Delete §2.2 — disk download

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Remove the §2.2 block.** Delete the entire current section from `### 2.2 Download images` up to (but not including) `### 2.3 Per-product 1688 image search`. Images are now injected from their URL in §2.3b, so nothing replaces it.

- [ ] **Step 2: Verify §2.2 is gone.**

Run: `grep -c "### 2.2" "$SKILL_DIR/SKILL.md"`
Expected: `0`.
Run: `grep -c "fob-tmp" "$SKILL_DIR/SKILL.md"`
Expected: `1` (only the §2.5 hygiene mention remains until Task 5 removes it; if Task 5 already ran, `0`).

---

## Task 3: Rewrite §2.3 — per-product loop + canonical snippets

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Replace the §2.3 block.** Replace everything from `### 2.3 Per-product 1688 image search` up to (but not including) `### 2.4 Write fob.json` with the following. Reproduce the JS snippets **verbatim** — they are the proven-working code:

````markdown
### 2.3 Per-product 1688 image search

Loop over products one at a time. Each product reuses the home tab (§2.1) and
opens one disposable results tab.

**a) Navigate home** (fresh each product clears stale panel state):
`mcp__Claude_in_Chrome__navigate` → `https://www.1688.com/` on the home tab.

**b) Inject the product image** from its Amazon `imageUrl` straight into the
hidden file input — no disk download, no `file_upload` (the MCP blocks
uploading files it didn't receive from the user). Run via `javascript_tool` on
the home tab, substituting the real URL:

```js
(async function(){
  const el = document.getElementById('img-search-upload');
  if (!el) return 'NO_INPUT';
  const r = await fetch('<IMAGE_URL>');
  if (!r.ok) return 'IMG_FETCH_' + r.status;
  const b = await r.blob();
  const f = new File([b], 'q.jpg', { type: b.type || 'image/jpeg' });
  const dt = new DataTransfer(); dt.items.add(f);
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'OK';
})()
```

`OK` = injected. `NO_INPUT` = the input isn't in the DOM yet: JS-click the
`以图搜款` button to mount the panel, then retry the inject once.
`IMG_FETCH_<status>` = the Amazon image URL failed; re-check it in products.json.

**c) Trigger the search** by clicking the element whose exact text is `搜索图片`
(stable selector — never pixel coordinates). Run on the home tab:

```js
(function(){
  const all = [...document.querySelectorAll('.search-btn, button, div, span, a')];
  const b = all.find(e => e.textContent.trim() === '搜索图片');
  if (!b) return 'NO_BTN';
  b.click();
  return 'CLICKED';
})()
```

`CLICKED` opens a **new results tab**. `NO_BTN` means the image didn't register —
re-check step b returned `OK`.

**d) Capture the results tab:** call `mcp__Claude_in_Chrome__tabs_context_mcp`
and pick the newest tab whose URL contains `s.1688.com/youyuan` and
`tab=imageSearch`. Note its `tabId`.

**e) Extract prices + seller URL** via `javascript_tool` on the results tab.
Returns ONLY `{median,count,sellerUrl}` — never `document.URL`, which the MCP
privacy filter blocks:

```js
(function(){
  const prices = [];
  document.querySelectorAll('[class*=price]').forEach(el => {
    const m = el.textContent.trim().match(/¥(\d+\.?\d*)/);
    if (m) { const v = parseFloat(m[1]); if (v >= 2 && v <= 80) prices.push(v); }
  });
  const u = [...new Set(prices)].sort((a,b) => a-b);
  const mid = Math.floor(u.length/2);
  const median = u.length ? (u.length % 2 ? u[mid] : (u[mid-1]+u[mid])/2) : 0;
  const links = [...document.querySelectorAll('a[href*="air.1688.com"][href*="offerId="]')];
  const ids = [...new Set(links.map(a => { try { return new URL(a.href).searchParams.get('offerId'); } catch(e){ return null; } }).filter(Boolean))];
  const sellerUrl = ids.length ? 'https://detail.1688.com/offer/' + ids[0] + '.html' : '';
  return JSON.stringify({ median, count: u.length, sellerUrl });
})()
```

`fobRmb = median`, `candidates = count`. The ¥2–80 band drops per-order totals
and shipping outliers.

**f) Hard-stop check (no fallback).** Read the results tab's URL from the
`tabs_context_mcp` result of step d — do NOT run an eval that returns
`document.URL`. Treat the product as **blocked** if that URL contains `login`,
`punish`, or `captcha`, OR if the extract returned `count < 3`. On block, show
this and wait:

> ⛔ **1688 access blocked for ASIN `<asin>`.**
> The page hit a login/CAPTCHA wall or returned too few prices. Please:
> 1. Open 1688.com and log in, or solve the verification slider.
> 2. Confirm here once 1688 search results load normally.
>
> **Do not proceed until the user confirms.** Then retry this ASIN from step (a).

No Taobao fallback, no estimation — FOB must come from a live 1688 image search.

**g) Close the results tab** with `mcp__Claude_in_Chrome__tabs_close_mcp` (the
`tabId` from step d) before moving to the next product, so result tabs don't
accumulate.
````

- [ ] **Step 2: Verify the snippets and selectors landed.**

Run: `sed -n '/### 2.3 Per-product/,/### 2.4/p' "$SKILL_DIR/SKILL.md" | grep -c "img-search-upload"`
Expected: `≥1`.
Run: `sed -n '/### 2.3 Per-product/,/### 2.4/p' "$SKILL_DIR/SKILL.md" | grep -c "air.1688.com"`
Expected: `1`.
Run: `sed -n '/### 2.3 Per-product/,/### 2.4/p' "$SKILL_DIR/SKILL.md" | grep -c "tabs_close_mcp"`
Expected: `1`.
Run: `sed -n '/### 2.3 Per-product/,/### 2.4/p' "$SKILL_DIR/SKILL.md" | grep -c "browser-act"`
Expected: `0`.

---

## Task 4: Correct §2.4 — sellerUrl note

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Replace the two note blockquotes in §2.4.** Keep the existing JSON example and the `fobUsd = fobRmb / 7.2` line. Replace the current "Note on sellerUrl" blockquote (the one claiming empty sellerUrl is "expected") and keep the "write only after all succeed" guidance, so §2.4's notes read exactly:

```markdown
> **sellerUrl:** taken from the first `air.1688.com…offerId=` link on the
> results page and rebuilt as `https://detail.1688.com/offer/<offerId>.html`.
> This reliably resolves for image-search results (the older
> `a[href*="detail.1688.com"]` selector did not). If no `offerId` link is found,
> leave `sellerUrl: ""`; but an empty sellerUrl **together with** `count < 3`
> means the search likely failed — treat it as a §2.3f hard-stop, not a normal
> empty result.

> **Only write `fob.json` after every product has succeeded.** A blocked product
> pauses the run — keep the session open and retry it after the user resolves
> access. A partial `fob.json` means Phase 3 cannot run.
```

- [ ] **Step 2: Verify.**

Run: `sed -n '/### 2.4 Write fob.json/,/### 2.5/p' "$SKILL_DIR/SKILL.md" | grep -c "reliably resolves"`
Expected: `1`.
Run: `sed -n '/### 2.4 Write fob.json/,/### 2.5/p' "$SKILL_DIR/SKILL.md" | grep -c "expected and not a failure"`
Expected: `0` (the old defeatist note is gone).

---

## Task 5: Rewrite §2.5 — hygiene

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Replace the §2.5 block.** Replace everything from `### 2.5 Hygiene` up to (but not including) `## Phase 3` with:

```markdown
### 2.5 Hygiene

No images are written to disk — they're injected from their URL (§2.3b). Close
each results tab after extraction (§2.3g) so tabs don't accumulate across
products. `fob.json` may contain session-derived data; do not share or commit
it.

```

- [ ] **Step 2: Verify no disk artifacts remain in Phase 2.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "fob-tmp"`
Expected: `0`.

---

## Task 6: Whole-phase consistency sweep

**Files:** none (verification only)

- [ ] **Step 1: No browser-act anywhere in Phase 2.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -ci "browser-act"`
Expected: `0`.

- [ ] **Step 2: No stale upload/disk references.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -cE "upload <|\.fob-tmp|get markdown"`
Expected: `0`.

- [ ] **Step 3: Required new anchors all present.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -cE "mcp__Claude_in_Chrome|img-search-upload|搜索图片|tab=imageSearch|tabs_close_mcp"`
Expected: `≥5`.

- [ ] **Step 4: Price band updated.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "v <= 80"`
Expected: `1`. And the old band is gone:
Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -c "v <= 50"`
Expected: `0`.

---

## Task 7: Live verification (real 1688 run)

**Files:** none (verification only)

> Requires the user's Chrome logged into 1688 and the Claude-in-Chrome MCP
> connected. Run by the controller, not a subagent (needs the live session).

- [ ] **Step 1: Pick 2–3 ASINs** from the existing run set with known-good Amazon
image URLs (read them from
`/Users/aronlee/Documents/product-research/storage-basket/products.json`):
e.g. `B0C3PLGMCQ`, `B09MQFRZHC`.

- [ ] **Step 2: Execute §2.1–§2.3 for each picked ASIN** exactly as the rewritten
SKILL.md now says: select browser, create home tab, then per ASIN navigate →
inject (step b snippet with that ASIN's imageUrl) → trigger search (step c) →
capture results tab (step d) → extract (step e) → close tab (step g).

- [ ] **Step 3: Confirm each ASIN's extract** returns `count ≥ 3`, a numeric
`median` in roughly ¥2–80, and a `sellerUrl` matching
`^https://detail\.1688\.com/offer/\d+\.html$`. Record the JSON for each.

- [ ] **Step 4: Confirm tab hygiene** — after the loop,
`mcp__Claude_in_Chrome__tabs_context_mcp` shows the result tabs were closed (tab
count back to the home tab plus at most one in-flight).

- [ ] **Step 5: Confirm hard-stop path** — if any ASIN's results tab URL contains
`login`/`punish`/`captcha` or `count < 3`, verify the procedure surfaces the ⛔
message and pauses rather than recording a zero. (If no natural block occurs,
note that the `count < 3` branch is covered by the step-3 threshold check and
move on — do not fabricate a block.)

---

## Self-Review

**Spec coverage:**
- MCP driver + self-contained setup → Task 1 ✓
- Delete disk download → Task 2 ✓
- Per-product loop, inject/search/capture/extract/close snippets → Task 3 ✓
- Inject fallback (`NO_INPUT` → click 以图搜款 → retry) → Task 3 step b ✓
- New-tab capture criteria (`s.1688.com/youyuan` + `tab=imageSearch`) → Task 3 step d ✓
- Hard-stop via tab-context URL + `count < 3`, never `document.URL` → Task 3 step f ✓
- Tab hygiene → Task 3 step g + Task 5 ✓
- sellerUrl correction (air.1688.com offerId) → Task 3 step e + Task 4 ✓
- Price band ¥2–80 → Task 3 step e + Task 6 step 4 ✓
- fob.json shape unchanged + write-after-all → Task 4 ✓
- Verification on 2–3 ASINs → Task 7 ✓
- Non-goals (no parallelism, no HTTP path, Phase 1 untouched) → honored; no task touches them ✓

**Placeholder scan:** none. `<IMAGE_URL>` is an intentional substitution token in a runnable snippet, documented in-line.

**Consistency:** the three snippets are identical to the spec; return tokens (`OK`/`NO_INPUT`/`IMG_FETCH_`/`CLICKED`/`NO_BTN`) are referenced consistently in the surrounding prose; field names (`median`/`count`/`sellerUrl` → `fobRmb`/`candidates`/`sellerUrl`) match §2.4 and what `calc.mjs` reads from fob.json.
