# Pack-count Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account for multipack/set sizes on both ends — Amazon `packCount` and 1688 `cnPack` — so landed COGS uses `(1688 price ÷ cnPack) × amazonPack` instead of one per-unit FOB against an N-pack price.

**Architecture:** `calc.mjs` multiplies the per-unit FOB by Amazon `packCount`; Phase 2's extraction normalizes each 1688 card to per-unit by dividing its price by `cnPack` (parsed from the card title) before taking the median; SKILL.md and the report template carry/show both pack sizes.

**Tech Stack:** Node ESM + `node:test`; Markdown (SKILL.md); HTML/JS (report-template.html).

**Conventions:**
- Skill dir (`SKILL_DIR`):
  `/Users/aronlee/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/4b58f008-d934-4080-bc1c-537644177e4d/e1bf8324-030e-448a-aa43-9319bd6ba425/skills/product-cost-analyze-for-fba/`
- **Not a git repo — no commits.** Each task ends when its tests/greps pass.
- Run tests from the skill dir: `node --test calc.test.mjs`

**Spec:** `docs/specs/2026-06-17-pack-count-correction-design.md`

---

## File Structure

- **Modify:** `calc.mjs` — `buildPayload` (×packCount), `mapOutputs` (new fields).
- **Modify:** `calc.test.mjs` — pack-multiply tests.
- **Modify:** `SKILL.md` — Phase 1 (`packCount`), Phase 2 (card-level extract + `cnPack`, fob.json fields).
- **Modify:** `report-template.html` — pack tag + explicit FOB-basis chip.

---

## Task 1: calc.mjs — `buildPayload` multiplies FOB by packCount

**Files:** Modify `calc.mjs`, `calc.test.mjs`

- [ ] **Step 1: Append failing tests.**

```js
// calc.test.mjs (append)
test("buildPayload multiplies fob by packCount", () => {
  const product = { dim: { L: 9, W: 3, H: 3 }, weight: 1, price: 45.99, monthlyVolume: 100, packCount: 4 };
  const p = buildPayload(product, { fobUsd: 1.88 });
  assert.ok(Math.abs(p.fob - 7.52) < 1e-6);          // 1.88 * 4
  assert.ok(Math.abs(p.duty - 7.52 * 0.075) < 1e-6); // duty scales with fob
});

test("buildPayload defaults packCount to 1 when absent", () => {
  const product = { dim: { L: 9, W: 3, H: 3 }, weight: 1, price: 21.99, monthlyVolume: 100 };
  const p = buildPayload(product, { fobUsd: 0.76 });
  assert.equal(p.fob, 0.76);
});
```

- [ ] **Step 2: Run, verify the new tests fail.**

Run: `node --test calc.test.mjs`
Expected: FAIL (`p.fob` is 1.88 unmultiplied / current code ignores packCount).

- [ ] **Step 3: Update `buildPayload` in `calc.mjs`.** Replace the function body so it reads packCount and scales fob:

```js
export function buildPayload(product, fobEntry) {
  const shipWeight = deriveShipWeight(product.dim, product.weight);
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

- [ ] **Step 4: Run, verify all pass.**

Run: `node --test calc.test.mjs`
Expected: PASS (existing buildPayload test with no packCount still passes — default 1 keeps `fob = 0.69`).

---

## Task 2: calc.mjs — `mapOutputs` carries pack fields

**Files:** Modify `calc.mjs`, `calc.test.mjs`

- [ ] **Step 1: Append failing tests.**

```js
// calc.test.mjs (append)
test("mapOutputs carries packCount, cnPack and per-listing fob", () => {
  const product = { ...SAMPLE_PRODUCT, packCount: 4 };
  const fob = { ...SAMPLE_FOB, cnPack: 2 };
  const m = mapOutputs(product, fob, SAMPLE_OUTPUTS);
  assert.equal(m.packCount, 4);
  assert.equal(m.cnPack, 2);
  assert.equal(m.fobUsd, 0.69);                 // still per single unit
  assert.equal(m.fobUsdPerListing, 2.76);       // 0.69 * 4
});

test("mapOutputs defaults packCount and cnPack to 1", () => {
  const m = mapOutputs(SAMPLE_PRODUCT, SAMPLE_FOB, SAMPLE_OUTPUTS);
  assert.equal(m.packCount, 1);
  assert.equal(m.cnPack, 1);
  assert.equal(m.fobUsdPerListing, 0.69);
});
```

(`SAMPLE_PRODUCT`, `SAMPLE_FOB`, `SAMPLE_OUTPUTS` are defined earlier in the test file by the Task-2 mapOutputs tests from the original calc plan.)

- [ ] **Step 2: Run, verify the new tests fail.**

Run: `node --test calc.test.mjs`
Expected: FAIL (`m.packCount` undefined).

- [ ] **Step 3: Add the fields in `mapOutputs`.** Inside the returned object in `calc.mjs`, after the `dim: product.dim,` line, insert:

```js
    packCount: product.packCount || 1,
    cnPack: fobEntry.cnPack || 1,
    fobUsdPerListing: +((fobEntry.fobUsd) * (product.packCount || 1)).toFixed(2),
```

(Leave `fobUsd: fobEntry.fobUsd` and `fobRmb: fobEntry.fobRmb` as-is — they remain per single unit.)

- [ ] **Step 4: Run, verify all pass.**

Run: `node --test calc.test.mjs`
Expected: PASS (all prior tests still green).

---

## Task 3: SKILL.md Phase 1 — capture packCount

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Add a detection note + fields to §1.5.** In the §1.5 "Write products.json" section, add `packCount`/`packSource` to the JSON example and a paragraph above it:

```markdown
**Pack count.** Amazon listings are often multipacks; parse the title for the
unit count and record it (Phase 3 multiplies FOB by it). Add `packCount` (int)
and `packSource` to each product. Patterns (case-insensitive): `N Pack`,
`N-Pack`, `Npack`, `Pack of N`, `Set of N`, `N pcs|pc|pieces|count`. No match →
`packCount: 1, packSource: "default"` (a true single, or a missed pack).
```

And in the products.json example object add the two fields:

```json
    "packCount": 4,
    "packSource": "title",
```

- [ ] **Step 2: Verify.**

Run: `sed -n '/## Phase 1/,/## Phase 2/p' "$SKILL_DIR/SKILL.md" | grep -cE "packCount|packSource"`
Expected: `≥3`.

---

## Task 4: SKILL.md Phase 2 — card-level extraction + cnPack

**Files:** Modify `SKILL.md`

- [ ] **Step 1: Replace the §2.3 step-5 extraction block** (the `(function(){ … priceMain … })()` snippet) with the card-level version:

````markdown
5. **Extract per group, normalized per unit** via `javascript_tool`. Each group's
matched cards carry a title, a price, and a `detail.1688.com/offer` link. A 1688
price may cover a set (e.g. `4个装`), so divide each card's price by its set size
(`cnPack`, parsed from the title) before taking the median — the result is a
per-single-unit FOB. Seller links are direct hrefs:

```js
(function(){
  function cnPackOf(t){
    t = t || '';
    const m = t.match(/(\d+)\s*(?:个|只|支|件|台|条|包|盒|套|组)\s*装/)
           || t.match(/(\d+)\s*件套/)
           || t.match(/(\d+)\s*(?:个|只|支|件)\s*[\/／]\s*(?:套|包|盒|组)/)
           || t.match(/(\d+)\s*(?:pcs?|pack)/i);
    const n = m ? parseInt(m[1],10) : 1;
    return (n>=1 && n<=50) ? n : 1;
  }
  const headers = [...document.querySelectorAll('*')]
    .filter(e => e.childElementCount===0 && e.textContent.trim()==='已为您找到相似货源');
  function groupRoot(h){ let n=h; for(let i=0;i<8&&n;i++){ if(n.querySelectorAll('a[href*="detail.1688.com/offer"]').length>=1 && /¥|￥/.test(n.textContent)) return n; n=n.parentElement;} return h.parentElement; }
  const groups = headers.map((h, idx) => {
    const root = groupRoot(h);
    const cards = [...root.querySelectorAll('a[href*="detail.1688.com/offer"]')].map(a => {
      const card = a.closest('[class*=card], [class*=item], [class*=offer], li, div') || a.parentElement;
      const pe = card.querySelector('[class*=priceMain]');
      const price = pe ? parseFloat(pe.textContent.replace(/[^0-9.]/g,'')) : NaN;
      const title = (card.textContent || '').replace(/\s+/g,' ').trim().slice(0,60);
      return { title, price, offerUrl: a.href.split('?')[0], cnPack: cnPackOf(title) };
    });
    const perUnit = cards.map(c => c.price / c.cnPack).filter(v => v>=2 && v<=80);
    const u = [...new Set(perUnit)].sort((a,b)=>a-b);
    const mid = Math.floor(u.length/2);
    const median = u.length ? (u.length%2 ? u[mid] : (u[mid-1]+u[mid])/2) : 0;
    const first = cards[0] || {};
    return { i: idx+1, count: u.length, median, sellerUrl: first.offerUrl || '', cnPack: first.cnPack || 1, matchedTitle: first.title || '' };
  });
  return JSON.stringify(groups);
})()
```

`fobRmb = median` (per single unit), `candidates = count`, `cnPack` and
`matchedTitle` describe the chosen offer.
````

- [ ] **Step 2: Update §2.4 fob.json schema** — add `cnPack` and `matchedTitle`, and note per-unit basis. Replace the JSON example's fields to include:

```json
    "cnPack": 1,
    "matchedTitle": "驱蝇器黑色 电池款",
```

and ensure the surrounding text says `fobRmb`/`fobUsd` are **per single unit**
(`fobUsd = fobRmb / 7.2`).

- [ ] **Step 3: Verify.**

Run: `sed -n '/## Phase 2/,/## Phase 3/p' "$SKILL_DIR/SKILL.md" | grep -cE "cnPack|cnPackOf|matchedTitle|per single unit"`
Expected: `≥4`.

---

## Task 5: report-template.html — pack tag + explicit FOB chip

**Files:** Modify `report-template.html`

- [ ] **Step 1: Read the card render** to find where tags and the `FOB:` chip are built.

Run: `grep -n "FOB\|fobRmb\|fobUsd\|Small Brand\|tags" "$SKILL_DIR/report-template.html"`

- [ ] **Step 2: Add a pack tag.** Next to the existing brand/FOB tags, add (when `p.packCount > 1`) a tag:

```js
${p.packCount > 1 ? `<span class="tag">📦 ${p.packCount}-pack</span>` : ''}
```

- [ ] **Step 3: Make the FOB chip explicit.** Replace the FOB chip text builder so it shows the basis when either pack size > 1, else the simple form. Use this expression for the chip's inner text:

```js
${(p.cnPack > 1 || p.packCount > 1)
  ? `FOB ¥${p.fobRmb}${p.cnPack > 1 ? ` ÷ ${p.cnPack}pcs` : ''} = $${p.fobUsd.toFixed(2)}/unit × ${p.packCount}-pack = $${(p.fobUsdPerListing ?? p.fobUsd * (p.packCount||1)).toFixed(2)}/listing`
  : `FOB ¥${p.fobRmb} ($${p.fobUsd.toFixed(2)})`}
```

- [ ] **Step 4: Verify the template still parses** by loading it against the corrected data in Task 6 (no standalone test for HTML).

---

## Task 6: Verify on the portable-fly-fan data

**Files:** Modify `/Users/aronlee/Documents/product-research/portable-fly-fan/products.json` (add packCount) for the re-run.

- [ ] **Step 1: Add packCount to that run's products.json.** The 1688 matches were single units, so `cnPack` defaults to 1 in fob.json (no change needed there). Set each product's `packCount` from its title:
B0CXX7CKJ8→4, B0CXDJGB21→4, B0GG8YWWLS→2, B0GGB4BX5Z→4, B0GGR1X5Z3→4,
B0B6R358LV→4, B0DWMX9WCY→4, B0BX56YNLQ→4, B084XQPG2H→2, B0DJ2KY2FY→4
(each with `"packSource": "title"`).

- [ ] **Step 2: Re-run calc.**

Run: `node "$SKILL_DIR/calc.mjs" "/Users/aronlee/Documents/product-research/portable-fly-fan" "portable fly fan"`
Expected: exit 0; survivor/eliminated counts reflect corrected (lower) margins.

- [ ] **Step 3: Confirm corrected numbers.**

Run:
```bash
node -e '
const fs=require("fs");
eval(fs.readFileSync("/Users/aronlee/Documents/product-research/portable-fly-fan/results.js","utf8").replace("window.__FBA_DATA__","var D"));
[...D.survivors,...D.eliminated].forEach(s=>console.log(s.asin,"pack"+s.packCount,"cn"+s.cnPack,s.netMarginAfterPPC+"%","perListingFob$"+s.fobUsdPerListing));
'
```
Expected: B0BX56YNLQ ≈ 34%, B0DWMX9WCY ≈ 0.7% (now near/below the survivor cutoff), and `fobUsdPerListing` = per-unit × packCount.

- [ ] **Step 4: Confirm the report renders the pack basis.** Serve the run dir
(`python3 -m http.server 7844 --directory …/portable-fly-fan`), load
`report.html` via the Chrome MCP, and confirm cards show `📦 4-pack` and the
explicit `FOB … /listing` chip, with margins matching Step 3.

---

## Self-Review

**Spec coverage:**
- Cost model `(price÷cnPack)×amazonPack` → Task 1 (×pack) + Task 4 (÷cnPack) ✓
- Phase 1 packCount/packSource → Task 3 ✓
- Phase 2 card-level extract + cnPack detector + per-unit median → Task 4 ✓
- fob.json cnPack/matchedTitle, per-unit basis → Task 4 step 2 ✓
- calc.mjs buildPayload ×packCount, mapOutputs fields → Tasks 1, 2 ✓
- Report pack tag + explicit FOB chip → Task 5 ✓
- Verification incl. corrected fly-fan numbers → Task 6 ✓
- Limits (cnPack title-based, default 1) → encoded in the `cnPackOf` default and surfaced via matchedTitle ✓

**Placeholder scan:** none. Regex `\d+`/`N` and the field values are intentional.

**Consistency:** field names `packCount`, `cnPack`, `fobUsd`, `fobUsdPerListing`,
`matchedTitle` match across calc.mjs, tests, SKILL.md, and the template; the
extractor's `median`/`count`/`sellerUrl`/`cnPack` map to fob.json's
`fobRmb`/`candidates`/`sellerUrl`/`cnPack`.
