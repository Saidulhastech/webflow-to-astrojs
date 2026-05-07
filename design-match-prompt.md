# Design-Match Prompt — Webflow ⇄ Astro Mapping Sync

> Run this when the rendered `astro-{NAME}/` site does **not** match the original Webflow design pixel-for-pixel.
> The prompt is dynamic: it derives every path from `project.config.json::name`, so it works for any project.

Paste the body of this file into Claude Code (or any agent with shell + repo access) and start the session. The agent will deep-scan the source Webflow CSS, diff it against the converted output, and patch the map JSONs + Tailwind config until the design matches.

---

## What the agent must read first (always, in order)

1. `project.config.json` — get `NAME = .name`. **Every path below depends on this.**
2. `{NAME}.webflow/css/{NAME}.webflow.css` — original site CSS (source of truth).
3. `{NAME}.webflow/css/normalize.css` + `webflow.css` — framework baselines.
4. `output-{NAME}-tailwind-v4/` — the converted HTML the agent must make match the source.
5. `astro-{NAME}/src/pages/**/*.astro` — final rendered pages.
6. `astro-{NAME}/src/styles/{custom,tailwind}.css` — final shipped CSS.
7. `cms-dump.json` — collection list (do NOT hand-edit; re-fetch if stale, see §6).

## Files this prompt is allowed to modify

| File | Owner / regenerator | Edit policy |
|------|---------------------|-------------|
| `class-tw-full.json` | `build-maps.js` | Patch only when `build-maps.js` heuristic provably misses a case; prefer fixing the rule |
| `responsive-tw-map.json` | `build-maps.js` | Same as above |
| `media-display-classes.json` | `build-maps.js` | Same as above |
| `tailwind.config.js` | `build-maps.js` | Re-derived from `:root` vars; add new colors/spacing/font-size scales here |
| `*.bak` | `build-maps.js` (one-shot snapshots) | **Never touch.** Restore points if a regeneration goes wrong |
| `cms-dump.json` | `fetch-cms.js` | Re-fetch — never hand-edit |
| `build-maps.js` | manual | **Preferred fix site** when many classes share a missed pattern |
| `transform-tw-v4.js` | manual | Touch only when class-injection logic itself is wrong |
| `class-tw-map.json` / `class-tw-map-v2.json` | (legacy, unreferenced) | Delete on sight — these are stale outputs from earlier iterations |

---

## Core principle

`build-maps.js` is the **source of truth** for every JSON in this list. Hand-edited JSONs get clobbered on the next `node build-maps.js` run. Therefore:

1. **First fix attempt: improve `build-maps.js`** — extend `mapProp()` / `KEEP_ALWAYS` / `BPMAP` / token detection to handle the case generically. Re-run `node build.js --only=maps` and verify.
2. **Only fall back to JSON patches** for genuinely one-off, project-specific overrides, and protect them via the override pattern in §5.

---

## 1. Locate the mismatch

```bash
# Run the dev server on the converted output to see what currently renders:
cd astro-{NAME} && npm install && npm run dev
# Open every primary page side-by-side with the live Webflow source:
#   https://{NAME}.webflow.io/  vs  http://localhost:4321/
```

For each visual diff the agent finds:

- Element-level: open Devtools on the live Webflow page, copy the failing class chain (e.g. `.about-hero-image`).
- Read the corresponding rule from `{NAME}.webflow/css/{NAME}.webflow.css`.
- Read the same class entry from `class-tw-full.json` (or `responsive-tw-map.json` for `@media` blocks).
- Compute what the entry **should** contain.

## 2. Diff the maps to expectations

Pseudo-loop the agent should follow for each mismatched class `cls`:

```
expected_tw   = derive Tailwind utilities from CSS rule  (apply build-maps.js mapProp logic by hand)
expected_keep = props that have no TW equivalent (gradients, var(), filters, transforms with multiple values, …)
actual        = JSON.parse(class-tw-full.json)[cls]

if expected_tw  ≠ actual.tw     → tw mapping wrong
if expected_keep ≠ actual.keep  → keep set wrong (causes double-rules or missing styles)
if cls absent from JSON          → selector skipped (likely compound, see §3)
```

Same loop with `responsive-tw-map.json[cls][bpPrefix]` for `@media`-scoped diffs.

## 3. Common Webflow CSS patterns and where they break

| Pattern in source CSS | Symptom in output | Fix location |
|---|---|---|
| Compound selector `.a.b` | Class skipped (build-maps only matches `.singleClass`) | Patch `analyzeCss()` regex in `build-maps.js`, or add manual override (§5) |
| `@media (max-width: 1279px)` | Treated as `xl` but BPMAP misses non-standard breakpoints | Extend `BPMAP` in `build-maps.js` |
| `transform: translate3d(...)` (IX2) | Passed to TW as junk | Already filtered by `cleanStyle()` in `transform-tw-v4.js` — verify it ran |
| `background: linear-gradient(...)` | Goes into `keep` (correct) but lands in custom.css | OK — confirm `custom.css` still includes the rule |
| `font-family: var(--xyz)` | Falls into `keep` automatically | OK — verify the var resolves in `:root` |
| Pseudo-class `:hover` / `::before` | Emits non-`@media` rule with `:hover` suffix → rejected by selector regex | Extend the selector regex in `analyzeCss()` |
| Webflow framework class `w-nav` | Stripped by `WF_STRIP` patterns | Intentional — webflow.js still binds JS, CSS lives in `webflow.css` |
| Per-instance class like `home-one .button` | Skipped (compound) | Add manual override or refactor source to use a single class |

## 4. Tailwind config gaps (most-frequent design drift cause)

If a color, spacing, or font-size renders close-but-not-equal, the value likely lacked a token and was emitted as `[arbitrary]` — fine, but missing variants. To add a real token:

1. Open the source `:root` block in `{NAME}.webflow/css/{NAME}.webflow.css` and copy any new `--var: value;` declarations.
2. Re-run `node build.js --only=maps`. `extractThemeTokens()` + `deriveScales()` automatically pick them up.
3. Inspect generated `tailwind.config.js` — confirm the value appears under `theme.extend.colors|spacing|fontSize`.
4. If the source CSS uses a hard-coded value (no `:root` var), add it to `BASE_SPACING` in `build-maps.js`, then re-run.

## 5. Per-project overrides (when `build-maps.js` truly cannot derive)

Create `tw-overrides.json` at repo root **only if** §1–§4 cannot solve the case. Schema:

```json
{
  "base": {
    "<class-name>": { "tw": ["..."], "strip": ["..."], "keep": ["..."] }
  },
  "responsive": {
    "<class-name>": {
      "max-md": { "tw": ["..."], "keep": {} }
    }
  },
  "mediaDisplay": ["<class-name>"]
}
```

Then patch `build-maps.js` once to merge it after `analyzeCss()`:

```js
const OVR = fs.existsSync('tw-overrides.json')
  ? JSON.parse(fs.readFileSync('tw-overrides.json','utf8'))
  : { base:{}, responsive:{}, mediaDisplay:[] };
for (const [c, v] of Object.entries(OVR.base ?? {})) {
  baseClasses[c] = { ...(baseClasses[c]||{tw:[],strip:[],keep:[]}), ...v };
}
for (const [c, bp] of Object.entries(OVR.responsive ?? {})) {
  respClasses[c] = { ...(respClasses[c]||{}), ...bp };
}
for (const c of OVR.mediaDisplay ?? []) mediaDisplay.add(c);
```

Overrides are tracked in git, regenerate cleanly, and document the per-project drift explicitly.

## 6. Refresh `cms-dump.json` (if collection content drifted)

```bash
node build.js --only=fetch        # re-pulls Webflow source + cms-dump.json
node build.js --only=maps         # rebuild class maps + tailwind.config
node build.js --only=tw           # rebuild tailwind v4 output
node build.js --only=post         # strip framework prefixes
node build.js --only=astro        # rebuild Astro project (mdx + content collections)
```

## 7. Verification (each iteration)

```bash
node build.js --only=maps
node build.js --only=tw
node build.js --only=post
node build.js --only=astro

# Visual diff:
cd astro-{NAME} && npm run dev
# Open both URLs in same browser, viewport-by-viewport:
#   sm  375  →  http://localhost:4321 vs https://{NAME}.webflow.io
#   md  768
#   lg  991
#   xl  1280
#   2xl 1440
#   3xl 1920
```

For pixel-level confirmation (optional):

```bash
npx pixelmatch \
  reference/{page}-{vp}.png \
  current/{page}-{vp}.png \
  diff.png 0.1
```

QA the pages `transform-tw-v4.js` already gates on (`idxHTML`, `featuresHTML`, `contactHTML`, `aboutHTML`) plus every CMS detail.

## 8. Stop conditions

- Every primary route passes side-by-side review at all 6 breakpoints.
- `node build.js` runs end-to-end with zero warnings.
- `npx astro check` (inside `astro-{NAME}/`) → 0 errors.
- `lighthouse` Performance ≥ 95, SEO = 100, Best Practices = 100.

If any step fails, repeat §1–§7 until clean.

---

## 9. Agent execution outline (single self-contained run)

When the user invokes this prompt, the agent should:

1. Read `project.config.json` → resolve `NAME`, `site`.
2. Verify all source/derived paths exist (re-fetch if missing — see §6).
3. Spawn `npm run dev` inside `astro-{NAME}/` (background task).
4. For every primary route + every CMS list/detail:
   - Compare to live `https://{NAME}.webflow.io/<path>` (or supplied screenshots).
   - Identify mismatched classes.
   - Apply §3–§5 fix priority order.
5. Re-run the pipeline subset needed (`--only=maps` → `--only=tw` → `--only=post` → `--only=astro`).
6. Repeat until §8 stop conditions all pass.
7. Commit changes per file with concise messages:
   - `maps: extend BPMAP for 1023px`
   - `overrides: pin .home-hero-image radius to 24px`
   - etc.

## 10. Files NEVER to delete

- `*.bak` — backup snapshots, restore points if a regen damages output.
- `tailwind.config.js.bak` — same.
- `webflow.css` and `normalize.css` under `{NAME}.webflow/css/` — needed by `transform-tw-v4.js` for framework rules.

## 11. Files SAFE to delete

- `class-tw-map.json`, `class-tw-map-v2.json` — legacy iterations, not referenced by current pipeline (verify with `grep -rn "class-tw-map" *.js *.mjs` returning empty).

---

_This prompt is part of the Webflow → Astro pipeline. Re-run when design drift is detected. Update §3 / §5 / §10 as new edge cases surface so future runs handle them automatically._
