# Maanak — Accessibility Checker — Implementation Plan

Decisions on each item from `REVIEW-standards-gap.md`. Scope stays: **single-component, design-stage**.

---

## Status

**Maanak — Accessibility Checker** is a single-component, design-stage Figma plugin. It tests WCAG 2.1/2.2 AA and surfaces the equivalent GIGW 3.0 §5.2 and IS 17802 (web) obligations inline.

**Built:** deterministic runners — contrast (1.4.3, 1.4.11), images of text (1.4.5), link purpose (2.4.4), headings & labels (2.4.6), target size (2.5.8), form labels (3.3.2), typography readability, text reflow; opt-in variant audit (1.4.1, 2.4.7, 3.3.1, 3.3.3); two AI checks (image-of-text, visual review); the Mark Include/Exclude layer; semantic status colours; the WCAG·GIGW·IS standards-mapping affordance. Manual bottom note for 1.3.3, 2.2.1, 2.2.2, 2.5.1.

**Not built:** the metadata generator — design-stage handoff-spec authoring (alt text, ARIA name, tab order, `lang`, PDF annotations). Gets its own planning doc when started.

ISL-on-video and the numeric-ID flag are out of scope (content / dev-stage, not single-component design-stage).

---

## Phase 1 — built

Phase 1's WCAG-only implementation work is complete. Remaining items from the original gap review are either intentionally skipped for the current single-component design-stage scope, or deferred to the Phase 2 standards-mapping pass.

### Runners to add

| Item | Standards | Status |
|---|---|---|
| **Link Purpose** | WCAG 2.4.4 (A) | **Done.** Runner flags clickable text matching `read more`, `click here`, `learn more`, `more`, `details`, `here`, `view more`, `see more`, `tap here`, `click`, `tap`, `link`. Severity `warning`. Lives in the "Interactive elements" group. |
| **Touch Target (Minimum)** | WCAG 2.5.8 (AA, 2.2) | **Done.** New runner checks `dto.clickables` + `dto.formInputs` for bbox ≥ **24×24 px**. Emits per-element passes and severe flags. Adds shape metadata, target-size visual, "Interactive elements" group title, 2.2.1 manual note, and Include-parent descendant suppression. |
| **Headings & Labels** | WCAG 2.4.6 (AA) | **Done.** Runner flags placeholder text on form labels, clickable copy, AND standalone text nodes. Expanded keyword list (`Button`, `Heading`, `Subheading`, `Subtitle`, `Header`, `Footer`, `Caption`, `Body`, `Description`, `Copy`, `Content` …), Lorem-anywhere substring match, `H1`–`H6`, dummy copy. Text-node path is gated by an explicit reject list (numeric, currency, URLs, dates, times, version strings, common short words). Severity `warning`. Findings route to **Content & labels** group. |

### Manual notes to add

| Item | Standards | Status |
|---|---|---|
| **Timing Adjustable** | WCAG 2.2.1 (A) | **Done.** New line in the manual-notes section, alongside 2.2.2. Covers OTP / form timeout cases. |
| **Pointer-gesture alternative** | WCAG 2.5.1 | **Done for WCAG.** Existing 2.5.1 manual note remains in the bottom notes section. Standards cross-mapping / GIGW citation is deferred until the dedicated standards-mapping pass. |

### Standards mapping

Findings carry WCAG 2.1/2.2 AA plus the by-reference GIGW 3.0 §5.2 and IS 17802 (web) clauses. GIGW 3.0 §5.2 and the IS 17802 web clause adopt WCAG 2.1 AA by reference, so no per-clause research or fabricated decimals are needed — the mapping is exact at the by-reference level.

`standardsForCriterion` (`src/ui/findings-render.ts`, built on `displayCodesForCriterion`) derives the set at render time from the finding's WCAG code(s); `Finding.criterion` stays single-SC. `text-reflow` expands to its three WCAG SCs then GIGW/IS once; non-WCAG criteria (`typography`, AI) carry no mapping. The criterion code on each finding is an expandable affordance — collapsed it is the plain code plus a faint caret, expanded it shows the cross-mapped clauses. Covered by `findings-render.test.ts`.

The debug-report standards line and precise GIGW/IS sub-clause decimals are out of scope.

---

## Touch Target (Minimum) — implementation plan

**Status:** built. This section documents the implemented decisions.

### What it tests

WCAG 2.5.8 requires pointer targets to be at least **24×24 px**. The runner checks each target's bbox:

- Pass when `width >= 24` **and** `height >= 24`
- Flag when either dimension is `< 24`
- Strict numeric threshold: `23.99×24` fails
- No area-based pass: `16×24` fails because width is too small; `24×16` fails because height is too small

### What gets tested

Touch Target tests both interactive DTO streams:

| Source | Apply check? | Notes |
|---|---|---|
| `dto.clickables` | Yes | Buttons, links, tabs, chips, icon buttons, designer-included nodes, and other classifier-detected targets. TEXT-typed clickables are included when the classifier identifies them as standalone tap targets. |
| `dto.formInputs` | Yes | Form inputs ride their own DTO path and are tested directly. They are excluded from `dto.clickables`, so they should not double-report. |
| User-excluded nodes | No | Exclude marker wins. |

If a user Include-marks a parent target, descendants should be ignored by the audit. The Include-marked node is treated as the whole target for that branch.

### Interactive detection used by `dto.clickables`

Classifier priority:

1. Exclude marker -> skip
2. Component-name match: `Button`, `Btn`, `Link`, `IconButton`, `IconBtn`, `Chip`, `Tab`, `MenuItem`, `NavItem`, `ListItem`, `Checkbox`, `Radio`, `Switch`, `Toggle`, `Dropdown`, `Select`, `Combobox`
3. Interactive variants: `Hover`, `Focus`, `Pressed`, `Active`, `Selected`
4. Icon-wrapper heuristic for small named icon frames / instances
5. Include marker -> force-classify

Form inputs do not use this path for Touch Target; they are tested from `dto.formInputs`.

### Runner behavior

Add `src/checks/runners/touch-target.ts` as a pure DTO runner and wire it into `runChecks`.

For each checked target:

- Emit `status: 'pass'` when both dimensions meet the threshold
- Emit `status: 'flag'` when width or height is below the threshold
- Use `criterion: '2.5.8'`
- Use `scope: 'element'`
- Preserve existing pass-finding behavior: per-element passes are emitted and shown in the collapsed pass disclosure

Suggested pass copy:

```ts
message: '2.5.8 — target size is at least 24 × 24 px.'
```

Suggested flag details:

```ts
details: {
  width,
  height,
  required: 24,
  nodeType,
  cornerRadius,
}
```

Severity: **severe**. This is a hard AA threshold.

### Shape metadata

Add the same visual metadata to both `ClickableElement` and `FormInputElement` because the runner treats both as interactive targets:

```ts
nodeType: string
cornerRadius: number | null
```

Extraction must be defensive:

- `nodeType` comes from the Figma node type
- `cornerRadius` is `null` when the node does not expose it or returns a mixed / non-numeric value

Existing test fixtures that construct these DTOs by hand must be updated, unless these fields are made optional.

### Finding visual

Use a concentric target-size visual:

- Outer outlined shape = required minimum, fixed at `24×24`
- Inner filled shape = actual target bbox, preserving actual aspect ratio
- Numeric stack: `current <w> × <h> px` and `needs ≥ 24 × 24 px`
- Severity dot at far right

The outer reference stays fixed at `24×24`. Example: a `48×16` target shows a wide filled rectangle larger than the reference on the x-axis, but shorter on the y-axis.

Shape matching uses Tier C:

| Target shape | Visual |
|---|---|
| Square bbox | square |
| Rectangular bbox | rectangle |
| `ELLIPSE` node | circle / oval |
| Rounded frame or rectangle with large radius | circle / oval / pill-like shape |

### UI integration

- Rename group title: **Content & links** -> **Interactive elements**
- Map both `2.4.4` and `2.5.8` into that group
- Add failure headline: `Small touch target`
- Add pass disclosure label: `Target size`
- Add `2.5.8` criterion title: `Target Size (Minimum)`

### Not included in Phase 1

- WCAG 2.5.5 AAA `44×44`
- Spacing exception for small targets with enough surrounding clear space
- Inline-text exception. True inline character-range links are not currently classified; standalone `TEXT` nodes classified as clickables are treated as tap targets and tested.
- Cross-standard labels / IS 17802 mapping. Focus on WCAG for this implementation; standards cross-mapping is deferred.

### Tests covered

- Clickable pass at `24×24`
- Clickable pass above threshold
- Width fail: `16×24`
- Height fail: `24×16`
- Both fail: `16×16`
- Fractional fail: `23.99×24`
- Form input pass / fail
- Mixed pass + flag in one DTO
- Passes survive aggregation and render in the collapsed pass disclosure
- Include-marked parent suppresses descendants
- Existing DTO fixtures updated for shape metadata

---

## Headings & Labels (2.4.6) — implementation plan

**Status:** built. This section documents the implemented decisions.

### What it tests

WCAG 2.4.6 requires headings and labels to describe topic or purpose. The runner flags label and clickable copy that matches placeholder patterns — text that is present but says nothing meaningful.

### Flag list

Trim input, then match against:

| # | Pattern | Example matches | Won't match |
|---|---|---|---|
| 1 | Empty / whitespace only | `""`, `"   "` | — |
| 2 | Single Unicode letter | `"A"`, `"क"` | `"→"`, `"&"`, `"7"` |
| 3 | Punctuation / symbols / whitespace, 2+ chars | `"---"`, `"..."`, `"___"` | `"OK!"`, `"."` |
| 4 | Generic UI noun + optional trailing digits | `Button`, `Btn`, `Link`, `Label`, `Field`, `Input`, `Text`, `Heading`, `Subheading`, `Subhead`, `Subtitle`, `Header`, `Footer`, `Caption`, `Body`, `Paragraph`, `Description`, `Copy`, `Content`, `Title`, `Placeholder`, `Untitled` · alone or with trailing digits (`Text 1`, `Heading 2`, `Heading 2024`) | `Buttons`, `Welcome heading`, `Card description copy` |
| 5 | Heading shorthand `H1`–`H6` | `H1`, `h6` | `H7`, `H1 hero` |
| 6 | Lorem anywhere (word-boundary substring) | `Lorem`, `Lorem ipsum dolor`, `Welcome to lorem section` | `florem`, `loremly` |
| 7 | Dummy copy tokens (exact) | `xxx`, `xxxx`, `asdf`, `tbd`, `todo`, `test`, `temp`, `dummy`, `sample`, `foo`, `bar`, `baz` | `tested`, `foobar` |

### Scope

| DTO source | Reject list? | Flag list? | Per-element passes? |
|---|---|---|---|
| `clickables[]` (where `textNormalized !== ''`) | No | Yes | Yes |
| `formInputs[].childTextNodes` where `isLabel === true` | No | Yes | Yes |
| `texts[]` (all standalone text in the subtree) | **Yes** (pre-filter) | Yes (after reject pass) | **No** — flags only |

Text nodes get a strict pre-filter so legitimate content (prices, dates, URLs, OTP samples, common short words) doesn't false-positive. The reject list is text-node-only; clickables and form labels keep their original strict-scope behavior.

### Reject list (text-node path only)

| # | Rule | Examples skipped |
|---|---|---|
| 1 | Numeric-only (digits + separators) | `42`, `1,250`, `0.95`, `123 456` |
| 2 | Number with currency / percent symbol | `$99`, `₹500`, `12.5%`, `€1.20` |
| 3 | Version / code string | `v1.0`, `1.2.3`, `#3076`, `vol. 2` |
| 4 | URL / email / `@handle` | `example.com`, `user@host.com`, `@username` |
| 5 | Date-ish | `01/01/2025`, `2025-01-01`, `Jan 2025`, `15 May` |
| 6 | Time | `10:30`, `10:30 AM`, `14:00` |
| 7 | Common short legitimate words (locked list) | `OK`, `Yes`, `No`, `On`, `Off`, `New`, `All`, `Any`, `None`, `Edit`, `Save`, `Done`, `Back`, `Next`, `Skip`, `Open`, `Close`, `Add`, `Show`, `Hide`, `Sort`, `View`, `Search`, `Filter`, `Cancel`, `Apply`, `Reset`, `Clear`, `Help`, `Info`, `More`, `Less`, `Top`, `End` |

### Runner behavior

Add `src/checks/runners/headings-labels.ts` as a pure DTO runner and wire it into `runChecks`.

For each checked label / clickable:

- Emit `status: 'pass'` when the normalized text matches none of the patterns
- Emit `status: 'flag'` when it matches at least one pattern
- Use `criterion: '2.4.6'`
- Use `scope: 'element'`
- Preserve existing pass-finding behavior: per-element passes flow into the collapsed pass disclosure

Suggested flag details: `{ text, matchedPattern }` so group-similar can collapse identical offenders.

Severity: **warning**. Content-quality issue, not a hard barrier.

### Finding output

**Pass — collapsed disclosure (existing pattern):**
> `Headings & labels — Email, Password, Submit, Forgot password?`

Each node name is a clickable purple chip. No card, no body.

**Flag — finding card body:**

| Region | Content |
|---|---|
| Headline | `Label looks like a placeholder` / `Link text looks like a placeholder` / `Text looks like a placeholder` (by `details.source`) |
| Node names | Clickable purple chips for every node in the group |
| Visual | Quoted-text row (reuse the 2.4.4 component): `"Text 1"` with a mild severity dot on the far right |
| Right-side meta | Criterion code `2.4.6` |

### Group-similar rule

Collapse by **literal matched text**, not by pattern bucket. Three buttons named `"Button"` collapse into one card with three chips; mixing `"Button"` + `"Text 1"` + `"Label"` would hide which copy needs fixing.

### UI integration

- New group `content-labels` titled **Content & labels** (added to `GROUP_ORDER` between `content-links` and `inclusive-instructions`). All three source paths route to it.
- Headlines branch on `details.source`:
  - `form-label` → `Label looks like a placeholder`
  - `clickable` → `Link text looks like a placeholder`
  - `text-node` → `Text looks like a placeholder`
- Criterion title: `Headings and Labels`
- Pass disclosure label: `Headings & labels`
- Visual: shared `buildQuotedTextVisual` helper extracted from 2.4.4; 2.4.6 uses the same quoted-text + mild severity dot row (fallback copy reads `placeholder text`).

### Relationship with 2.4.4

2.4.4 (vague link text) and 2.4.6 (placeholder label) can fire on the same clickable. Decision: keep them as separate criteria; a node can carry both codes. Different patterns, different SCs, both are useful signal.

### Files touched

| File | Change |
|---|---|
| `src/checks/runners/headings-labels.ts` | Runner — flag list, reject list (`isRejected`), clickable + form-label + standalone-text paths |
| `src/checks/orchestrator.ts` | Wired into `runChecks` |
| `src/checks/__tests__/runners-headings-labels.test.ts` | Tests |
| `src/ui/findings-groups.ts` | New `content-labels` group ("Content & labels"); `2.4.6` → `content-labels`; criterion title |
| `src/ui/headlines.ts` | Three source-discriminated headlines (form-label / clickable / text-node) |
| `src/ui/group-similar.ts` | Collapse `2.4.6` by lowercased `text` |
| `src/ui/findings-render.ts` | Shared `buildQuotedTextVisual`; `passLabel` entry |
| `src/ui/__tests__/{headlines,group-similar,findings-groups}.test.ts` | Coverage |

### Tests planned

- Each of the 7 patterns matches a representative string
- Real copy doesn't match (`Submit`, `Forgot password?`, `Continue with Google`)
- Single symbol `→` passes (rule #2 letter-only)
- Casing variants all flag (`BUTTON`, `button`, `Button`)
- Empty label on form input flags
- `Click here` does **not** trigger 2.4.6 (it's 2.4.4 territory)
- Group-similar collapses three nodes all named `"Text 1"` into one row

### Not included in Phase 1

- Semantic heading-level detection (Figma has no heading semantics). Standalone text *content* is checked behind the reject filter, but the plugin does not infer which text is a "heading."
- Cross-standard labels / IS 17802 mapping
- Localization of the pattern list — English placeholders only

---

## Interactive-element detection — **built**

Lives in `src/read/interactivity.ts`. Built alongside the Link Purpose runner; current consumers are 2.4.4 Link Purpose and 2.5.8 Touch Target.

**Exports:**
- `isClickableName(name)` — slash + camelCase morpheme matcher (pure, testable)
- `hasInteractiveVariants(compSet)` — checks variant set for Hover/Focus/Pressed states
- `normalizeLinkText(raw)` — text normalization for vague-text matching
- `buildClickableElements(root, instances, formInputIds)` — async builder

**DTO:** `ClickableElement[]` on `AuditDTO.clickables`.

### Signals used

| Priority | Signal | Source |
|---|---|---|
| 1 | **Exclude marker** | If node id is explicitly excluded, it is never classified as clickable. Exclude wins over all other signals. |
| 2 | **Component-name regex** | Match `node.name` and, for instances, main-component / component-set names against the interactive allowlist: `Button`, `Btn`, `Link`, `IconButton`, `IconBtn`, `Tap`, `Chip`, `Tab`, `MenuItem`, `NavItem`, `ListItem`, `Checkbox`, `Radio`, `Switch`, `Toggle`, `Dropdown`, `Select`, `Combobox`. Container names such as `ButtonGroup`, `Tabs`, `Menu`, `Toolbar`, `Navigation` are rejected. |
| 3 | **Interactive variants** | Main component has variant property values like `Hover`, `Focus`, `Pressed`, `Active`, `Disabled`. Reuse `src/read/variants.ts`. |
| 4 | **Icon-wrapper heuristic** | Small near-square `FRAME` / `INSTANCE` with visible vector-like descendants and icon-ish names such as `info`, `help`, `close`, `search`, `settings`, `chevron`, `arrow`, `copy`, `edit`, `delete`, `warning`. Rejects names such as `button`, `chip`, `tab`, `link`, `input`, `card`, `label`, `logo`, `brand`, `decorative`, `separator`, `divider`. |
| 5 | **Include marker** | If node id is explicitly included, it is force-classified as clickable. Descendants are suppressed so the included parent is audited as the whole target. |

Form inputs are not a `ClickableSignal`; they are collected through `dto.formInputs` and tested directly by Touch Target.

### Signals not used

| Signal | Why dropped |
|---|---|
| **Reactions / prototyping** | Most designs aren't fully prototyped — relying on this would catch almost nothing. |
| **Visual heuristics** (shape + label inside) | Too noisy. |
| **AI vision classifier** | Defer — revisit if false-negative rate hurts. |

### Output shape

```ts
type ClickableSignal =
  | 'component-name'
  | 'variant-states'
  | 'icon-wrapper'
  | 'designer-marked';
```

Touch Target applies the 24×24 check to nodes emitted in `AuditDTO.clickables`.

### Known limitation

**Loose vectors** — a raw `Vector` with no clickable wrapper is intentionally not classified as interactive. Small wrapped icon frames / instances can classify through the icon-wrapper heuristic when their size, shape, vector descendant, and name signals match.

### Deferred options

| Item | Decision |
|---|---|
| Confidence levels | Dropped for now. Boolean classification is enough. |
| User-extendable regex via settings | Not in Phase 1. Hard-code, revisit if teams ask. |

---

## Other open questions

### IS 17802 5.11: ISL slot annotation on video — **dropped**

**Decision: out of scope.** Requiring an Indian Sign Language interpreter track/slot on prerecorded video is a content / development-stage concern, not a design-level item the plugin can meaningfully check on a single component. Not revisiting.

### Numeric-ID anti-pattern flag — **dropped**

**Decision: out of scope.** Catching opaque-ID labels (`001223`, `Document 1`) cleanly requires fighting the 2.4.6 reject list (prices, dates, counts must stay skipped). The signal-to-noise and value are too low for the complexity. Not building.

---

## Skipping — and why

### WCAG

| SC | Reason skipped |
|---|---|
| **1.4.4** Resize Text | Full browser zoom behavior is dev-stage. Figma-stage coverage is limited to the built Text reflow fixed-height heuristic. |
| **3.1.2** Language of Parts | Content-level. Lives in build, not Figma. |

> **2.4.6 Headings & Labels is no longer skipped — it is built** (see Phase 1 "Done" above). It flags placeholder copy on clickables, form labels, and standalone text behind a reject filter.

### GIGW 3.0

| Clause | Reason skipped |
|---|---|
| **5.1.13 / 5.10.1** Unicode-Indian fonts | Dev / font-pipeline concern. Out of plugin's control. |
| **5.2.45** Indian input format hints | Content-level. |
| **5.4.10** Language toggle present | Page / structure-level. Plugin tests single components. |
| **5.2.42 / 5.2.43** Consistent nav & component identification | Page / structure-level. |

### IS 17802

| Clause | Reason skipped |
|---|---|
| Unicode-Indian fonts (dup of GIGW) | Same — dev-pipeline. |
| **5.3** Biometric fallback | Structure / flow-level. |

---

## Mark Interactive Elements — feature spec

Designer-driven override for the interactivity classifier. Lets the user (a) force-include nodes the classifier missed and (b) force-exclude nodes the classifier wrongly flagged.

### Storage
- `figma.clientStorage` — per-user, per-machine
- Key: `maanak.markers.v1` (loader falls back once to the compatibility key `wcag-auditor.markers.v1`)
- Shape: `{ [fileKey: string]: { include: string[]; exclude: string[] } }`
- Silent prune of missing node IDs on each plugin run

### Header button
- Position: between AI indicator and settings cog
- Phosphor cursor icon + "Mark" text label
- Click → opens marking page (full-panel takeover like settings)

### Marking page

**Selection card (top)** — shows the current Figma selection; state pill `● Include` / `● Exclude` / none for Neutral.

**Primary CTAs** — two side-by-side buttons: **Include** · **Exclude**.
- Never disabled when something is selected
- Clicking the opposite CTA replaces the current flag (no two-step)
- Active CTA filled in its color; inactive outlined
- **Reset** text-link below, visible only when state ≠ Neutral

**Empty state** (nothing selected) — both CTAs disabled, "Select a node" message, no Reset.

**List** — visible when selection is Neutral OR Exclude. Hidden when Include.
- Rows: classifier-detected + Include-marked nodes within the selection subtree
- Row layout: leading dot · node name · `[Inc] [Exc] [↺]` controls
- Click name → jump to node in Figma (select + zoom)
- Same toggle semantics as top CTAs; reset is an icon-only button
- "auto" pill on classifier-detected rows the user hasn't explicitly marked

### Color tokens
- Include = accent purple (existing `--accent`)
- Exclude = muted amber (desaturated, not destructive red)
- Neutral = default outlined
- Auto = dashed-outline pill

### Classifier integration
**Status:** built.

`buildClickableElements` uses the `'designer-marked'` signal for explicit includes:
- If node id ∈ `exclude` → never classified as clickable (overrides all other signals)
- If node id ∈ `include` → always classified as clickable
- Otherwise existing signals apply

---

## Phase 2 — metadata generator (next, after / alongside standards-mapping)

Extend the plugin into a **design-stage handoff spec generator** for things only a designer can author:

- Alt text per image (with type: logo / decoration / informational / infographic)
- ARIA name per interactive element
- Tab order
- `lang` annotation per text node (for code-mixed content)
- PDF-export accessibility annotations

Phase 1 has landed. This is the bigger of the two Phase 2 chunks (new feature surface, not just a refactor) — worth its own planning doc and an explicit go decision before starting. ISL-on-video is **not** in scope (dropped — content/dev stage).

---

## Notes & follow-ups (track during Phase 1 implementation)

### Audit classifier — widen Include-suppression to ALL descendants
**Status:** built with Touch Target.

When a node is Include-marked, every descendant inside that subtree is skipped by the clickable audit. The Include-marked node is treated as the whole target for that branch.



### Expand interactivity classifier with icon-wrapper detection
**Status:** built.

Built into `src/read/interactivity.ts` so small icon wrappers participate in normal audits and can be checked by Link Purpose and Touch Target.

**Rule — Icon-wrapper frame / instance.**
- Type is FRAME or INSTANCE
- Aspect ratio between 0.75 and 1.33
- Width and height both 12–48 px
- Contains at least one visible VECTOR / BOOLEAN_OPERATION descendant
- Name has an icon-ish morpheme such as `info`, `help`, `close`, `search`, `settings`, `chevron`, `arrow`, `copy`, `edit`, `delete`, `warning`
- Rejects obvious non-icon/decorative names such as `button`, `chip`, `tab`, `link`, `input`, `card`, `label`, `logo`, `brand`, `decorative`, `separator`, `divider`
- TEXT descendants are ignored; they do not qualify or disqualify the wrapper

Adds `ClickableSignal` value `'icon-wrapper'`.

Loose vector (no wrapper at all) is intentionally not handled — documented limitation.


### Text reflow runner — separate from typography readability
**Status:** built.

SC 1.4.4, 1.4.10, and 1.4.12 are **user-override resilience** checks: text must survive resize, reflow, and spacing overrides without clipped content. This is different from the current typography readability floors.

Built as a dedicated **Text reflow** runner with a deliberately simple heuristic:

- Test only text nodes, not parent containers.
- Pass when the text node height can grow (`textAutoResize` is height-auto / hug behavior).
- Flag when the text node height is fixed (`textAutoResize === 'NONE'`).
- Do not simulate 200% size, line-height, paragraph spacing, letter spacing, or word spacing math.
- Preserve existing pass behavior: emit per-element passes and show them in the collapsed pass disclosure.

UI:

- Internal criterion can stay runner-specific, e.g. `text-reflow`; do **not** refactor backend `Finding.criterion` for multi-SC support here.
- The finding row should display WCAG codes **1.4.4 · 1.4.10 · 1.4.12** in the existing right-side code area as a UI-only detail.
- Flag headline: `Text may not reflow`.
- Visual/copy:
  - `Currently: fixed-height text box`
  - `Needed: height can grow when text size or spacing changes`

The current typography readability check (line-height / letter-spacing / paragraph-spacing) is **NOT** WCAG 1.4.12 and uses the `'typography'` criterion id — no SC code shown in the UI.

### Typography readability — current state
Lives in `src/checks/typography.ts` + `runners/typography.ts`. Floors are general design opinion, not codified:

| Property | Floor | Baseline |
|---|---|---|
| Line-height | ≥ 75% | font size |
| Letter-spacing | ≥ -6% | font size (negative tracking allowed up to -6%) |
| Paragraph-spacing | ≥ 70% | effective line-height (1.2× fontSize fallback when AUTO) |
| Word-spacing | *not checked* | Figma has no UI for it |

Criterion id: `'typography'` (not a WCAG SC). UI hides the code on these findings.


### Form-input regex needs expansion
**Status:** Done.

`FORM_INPUT_RE` in `src/read/regex.ts` now includes these BFSI / India-domain `input/<suffix>` entries (longest-before-prefix ordered; `\b` guarded):

`pan, aadhaar, aadhar, address, pincode, pin, income, salary, ifsc, gstin, gst, accountnumber, accno, account, dob, otp`

Superset names (`input/pinterest`, `input/accountant`, `input/panic`, `input/addressbook`) correctly do **not** match. The geometric shape guard in `form-input.ts` (aspect ratio ≥ 2.0, ≤ 4 child texts) remains the false-positive backstop. Covered by `src/read/__tests__/regex.test.ts`.

### Rename `interactive.ts` / `InteractiveElement`
**Status:** Done.

Mechanical rename completed:
- `src/read/interactive.ts` → `src/read/non-text-contrast.ts`
- `InteractiveElement` → `NonTextContrastElement`
- `buildInteractiveElements` → `buildNonTextContrastElements`
- `kind: 'interactive'` → `kind: 'non-text-contrast'`
- `AuditDTO.interactives` → `AuditDTO.nonTextContrast` (+ the AI-context `counts` key + the `AuditContext` type)
- Debug trace heading "Interactives" → "Non-text contrast"

Consumers updated (`read/index.ts`, `contrast.ts` runner, `findings-render.ts`, `debug-report.ts`, `ui/index.ts`, `ai/run.ts`) and all DTO test fixtures. Clickable classifier (`interactivity.ts` / `ClickableElement`), the marking flow (`descendantInteractives`), and the "Interactive elements" group title / Mark-page heading are deliberately untouched. Typecheck clean; 337 tests green.

---

## Conventions for the implementation

### Semantic status colors

Three muted earth tones tint the audit-result status icons. Applies to the count chips (top stats + per-group card stats) and the inline section-label icons inside flagged / passed / unable summaries. Count text stays `--fg`. Severity dots stay accent-plum. Header icons (cog, mark, back) stay foreground.

| Token | Semantic | Light | Dark |
|---|---|---|---|
| `--status-pass` | check icon — passed | `#5F7A47` (muted sage) | `#A2BC79` (lifted sage) |
| `--status-flag` | warning icon — flagged | `#A14738` (terracotta) | `#D38478` (lifted terracotta) |
| `--status-unable` | prohibit icon — unable to test | `#8B7530` (antique gold) | `#D0BA66` (lifted gold) |

Token names deliberately avoid the word "warning" — the Phosphor `warning` icon is recolored to red (flag), so a `--status-warning` mapped to yellow would create confusion.

### Cross-standard mapping in plugin UI

When a single check satisfies more than one standard (e.g., touch target = WCAG 2.5.8 + IS 17802 11.2.5), the finding card should list **all applicable SCs**, each labeled with its standard:

> **Standards:** WCAG 2.5.8 · IS 17802 11.2.5

Format: `<Standard> <Clause>`, separated by middle dot. Applies to every finding card that maps across standards.
