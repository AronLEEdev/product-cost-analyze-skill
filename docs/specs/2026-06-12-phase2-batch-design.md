# Design: Replace Phase 2 with 1688 batch image sourcing

**Date:** 2026-06-12
**Status:** Approved (design), pending implementation
**Scope:** Phase 2 only. Phases 1, 3, 4 unchanged.

## Problem / goal

The per-product 1688 image search (just hardened) is reliable but slow: 10×
(navigate → inject → click → capture → extract → close). 1688 now offers a
**batch image sourcing** tool at
`https://air.1688.com/kapp/1688-pc-front/ai-avatar/procurement?tab=imageBatch`
("图片批量找") that accepts up to 200 images at once and returns one result page
grouping matches per image, each with prices and **direct
`detail.1688.com/offer/<id>.html` links**.

Verified live this session: injecting all 10 product images, submitting, and
extracting per-image median + seller link works end-to-end. Replace Phase 2 with
this batch flow for speed and clean seller links, accepting its thinner price
sample.

## Tradeoff (accepted)

The batch page surfaces only ~2 matched products per image inline (vs 30–50 from
the per-product search), so the median is less robust and the chosen match may be
a different pack size. The user has accepted this in exchange for one-shot speed
and direct seller links.

## Non-goals

- Phases 1, 3, 4 unchanged.
- **No youyuan fallback.** The per-product flow is removed; batch is the whole of
  Phase 2.
- No expanding each image's "›" carousel for more prices (would reintroduce
  per-product navigation and erase the speed win).

## Driver

Claude-in-Chrome MCP (`mcp__Claude_in_Chrome__*`), same as before.

## §2.1 Setup — require a logged-in batch tab

The batch tool requires login, and login must be done by the user (no automated
sign-in). So:

1. `select_browser`, then `tabs_context_mcp`.
2. Look for an existing tab whose URL contains
   `air.1688.com/kapp/1688-pc-front/ai-avatar/procurement`.
3. **If none is found, pause and ask the user** to manually open
   `https://air.1688.com/kapp/1688-pc-front/ai-avatar/procurement?tab=imageBatch`
   and log in, then confirm. Do not auto-navigate to it or attempt login.
4. Once the tab exists (and is logged in), use it as the working tab; if it is
   not on `?tab=imageBatch`, navigate it there. Run the block-probe (below)
   before proceeding.

## §2.3 Batch flow (replaces the per-product loop)

1. On the batch tab, run the block-probe (CAPTCHA can appear post-login):
   ```js
   (function(){
     const t = document.title || '';
     const x = (document.body ? document.body.innerText : '').slice(0, 800);
     const blocked = /captcha|interception|验证|滑动|滑块|unusual traffic/i.test(t + ' ' + x);
     return JSON.stringify({ blocked, title: t.slice(0, 60) });
   })()
   ```
   If `blocked`, hard-stop and ask the user to resolve it (§ Hard-stop).

2. **Inject all images.** Read `imageUrl`s from products.json (in order) and set
   them all on the batch `multiple` file input in one pass:
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
   Require `STAGED N/N` (all images staged). Fewer than N → hard-stop (an image
   URL failed; re-check products.json).

3. **Wait for upload**, then **submit with a real pointer click** on the
   `帮我寻源` button (`computer left_click` by screenshot coordinate — a JS click
   will not submit, same trusted-gesture rule as the per-product search). The tab
   navigates to `…/batchDetail?taskId=<id>&tab=imageBatch`.

4. **Poll until done.** The detail page streams results and shows progress
   `搜索匹配商品中 X/N`. Poll every ~20–30 s until the progress text is gone and the
   number of `已为您找到相似货源` groups equals N (typically 1–2 min).

5. **Extract per group** via `javascript_tool`:
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

6. **Map by order**: group `i` ↔ products[`i`-1] (upload order is preserved).
   Sanity-check `groups.length === products.length`; mismatch → hard-stop.

## Hard-stop rules (no estimation)

The `count ≥ 3` threshold is **removed** (batch yields ~2). Replacements:
- **Block-probe `blocked:true`** → ask the user to resolve the CAPTCHA, retry.
- **`STAGED` count < N** → an image URL failed; hard-stop, fix products.json.
- **Group count ≠ product count** after completion → hard-stop (order mapping
  unsafe).
- **A product group with 0 prices in ¥2–80** → that product is unmatched;
  hard-stop for the user rather than estimating.
- Otherwise use the group median even if `count` is 1–2.

## fob.json (shape unchanged, calc.mjs-compatible)

Per product: `{ asin, matched:true, source:"1688-batch", fobRmb:<median>,
fobUsd:<median/7.2, 2dp>, candidates:<count>, sellerUrl }`. Only write after all
products are mapped and none is a 0-match hard-stop.

## Account action

Submitting `帮我寻源` creates a real sourcing task on the user's 1688 account each
run (async, ~1–2 min; visible under 历史任务 / 询盘结果). This is inherent to the
chosen approach; document it in §2.5 so it is not a surprise.

## §2.5 hygiene

Close the batchDetail tab when done. `fob.json` may contain session-derived data;
do not share or commit it. No images are written to disk.

## Verification

No unit test (live site). Verify with a real batch run on the existing
storage-basket 10 images:
- setup correctly uses an existing `air.1688` tab, or prompts to open + log in
  when none exists;
- `STAGED 10/10`, task submits, polling detects completion;
- extraction yields 10 groups each with a numeric median and a real
  `detail.1688.com/offer/<id>.html` sellerUrl;
- fob.json maps each ASIN in order; a forced block (logged-out) triggers the
  hard-stop;
- Phase 3 (`calc.mjs`) consumes the new fob.json without change.

## Files

- **Edit:** `SKILL.md` Phase 2 (§2.1 setup, §2.3 flow, §2.4 fob.json note, §2.5
  hygiene). Remove the per-product youyuan loop.
- Skill dir is not a git repo; no commit step.
