import type { MainToUI, SelectionInfo, UIToMain } from '../shared/protocol'
import type { AuditDTO } from '../shared/dtos'
import type { Finding, FindingsReport } from '../checks/findings.ts'
import { formatDebugReport } from './debug-report.ts'
import {
  renderFindingsCards,
  buildManualBottomNote,
  buildSeverityDot,
  buildSectionLabel,
  buildPassDisclosure,
  buildUnableDisclosure,
  buildNodeLink,
  type RenderCallbacks,
} from './findings-render.ts'
import { headlineFor } from './headlines.ts'
// AI provider abstraction. The UI iframe calls the user-configured provider
// (OpenRouter / Anthropic / Google) directly using the API key stored in
// figma.clientStorage. No localhost server, no shared key.
import { PROVIDERS, PROVIDER_LABELS } from './ai/registry.ts'
import { ProviderError, type ProviderId } from './ai/provider.ts'
import { runImageOfTextCheck, runVisualReview } from './ai/run.ts'

// ── Per-user AI settings (figma.clientStorage round-trip) ──────────
import { attachSettingsMessageHandler, loadSettings } from './settings/store.ts'
import { initSettingsPage } from './settings/page.ts'
attachSettingsMessageHandler()
initSettingsPage()
// Kick off the initial load. Header indicator state in Phase D will subscribe
// to the store and re-render once this resolves. Failure mode: cache stays
// at DEFAULT_SETTINGS (key empty) — UI shows the "needs setup" state, which
// is the right answer either way.
void loadSettings()

// ── Marker page (designer interactivity overrides) ─────────────────
import { initMarkingPage, showMarkingPage } from './marking/page.ts'
initMarkingPage()
import { buildStat } from './icon-stat.ts'

// Shared timeout for AI-backed fetches (visual review + image-of-text). 60s
// gives slow vision models time to think on dense screenshots while still
// preventing the UI from spinning forever on a hung provider.
const AI_FETCH_TIMEOUT_MS = 60_000
const PLUGIN_VERSION = '0.2.0'
const TOAST_VISIBLE_MS = 1500

function send(msg: UIToMain): void {
  parent.postMessage({ pluginMessage: msg }, '*')
}

// Single source of render callbacks for every section that needs to wire
// element clicks back to figma. Posting `select-node` to main lets it select
// + scroll into view in the canvas. Used by the main group cards, the
// image-of-text section, and the variant section (when extended).
const renderCallbacks: RenderCallbacks = {
  onSelectNode: (nodeId: string) => send({ kind: 'select-node', nodeId }),
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} missing from DOM`)
  return el as T
}

const heroTitle = $<HTMLHeadingElement>('hero-title')
const heroMeta = $<HTMLParagraphElement>('hero-meta')
const runBtn = $<HTMLButtonElement>('run-btn')
const runBtnLabel = $<HTMLSpanElement>('run-btn-label')
const resultsBody = $<HTMLDivElement>('results-body')
const copyDebugBtn = $<HTMLButtonElement>('copy-debug-btn')
const toastEl = $<HTMLDivElement>('toast')
const aiIndicatorBtn = $<HTMLButtonElement>('ai-indicator')
const aiIndicatorState = $<HTMLSpanElement>('ai-indicator-state')
const settingsCogBtn = $<HTMLButtonElement>('settings-cog')
const markBtn = $<HTMLButtonElement>('mark-btn')

let lastResult: { dto: AuditDTO; findings: FindingsReport } | null = null

// ── AI status indicator ─────────────────────────────────────────────
// Three states derived from settings:
//   - apiKey === ''               → 'needs-setup' (click → open settings)
//   - apiKey !== '' && aiEnabled  → 'on'          (click → flip to off)
//   - apiKey !== '' && !aiEnabled → 'off'         (click → flip to on)
//
// The cog button is always visible alongside and always opens settings,
// regardless of state. AI on/off only matters when a key is configured —
// without one, both states are equivalent ("can't call anything anyway").
//
// Persistence lives in figma.clientStorage via the settings store; the
// indicator just reads the cached snapshot and re-renders on subscribe.

import { getSettings, subscribe as subscribeSettings, saveSettings } from './settings/store.ts'
import { showSettingsPage } from './settings/page.ts'
import type { AiSettings } from '../shared/settings.ts'

type AiIndicatorState = 'needs-setup' | 'on' | 'off'

function deriveIndicatorState(s: AiSettings): AiIndicatorState {
  if (!s.apiKey) return 'needs-setup'
  return s.aiEnabled ? 'on' : 'off'
}

function renderAiIndicator(s: AiSettings): void {
  const state = deriveIndicatorState(s)
  aiIndicatorBtn.setAttribute('aria-pressed', state === 'on' ? 'true' : 'false')
  aiIndicatorBtn.classList.toggle('ai-indicator--needs-setup', state === 'needs-setup')
  aiIndicatorBtn.classList.toggle('ai-indicator--off', state === 'off')
  aiIndicatorBtn.classList.toggle('ai-indicator--on', state === 'on')
  aiIndicatorState.textContent =
    state === 'needs-setup' ? 'not set up' : state === 'on' ? 'on' : 'off'
}

aiIndicatorBtn.addEventListener('click', () => {
  const s = getSettings()
  const state = deriveIndicatorState(s)
  if (state === 'needs-setup') {
    showSettingsPage()
    return
  }
  // Flip aiEnabled. Save round-trips through main → clientStorage; the
  // optimistic cache update inside the store re-renders the indicator
  // immediately via the subscriber.
  void saveSettings({ ...s, aiEnabled: !s.aiEnabled })
})

settingsCogBtn.addEventListener('click', () => {
  showSettingsPage()
})

markBtn.addEventListener('click', () => {
  showMarkingPage()
})

// Re-render the indicator on every settings change (initial load, save,
// clear, toggle). The settings page closes via its own `onClose` callback
// that we don't strictly need here — the subscriber covers it.
subscribeSettings(renderAiIndicator)
// Also render once on boot so the header shows 'not set up' immediately,
// before the first settings-loaded message arrives.
renderAiIndicator(getSettings())

let currentSelection: SelectionInfo = { kind: 'none' }
let runState: 'idle' | 'running' = 'idle'

// What the current Results pane is *about*. Lives independently of
// `currentSelection` so the audit results stay sticky when the user clicks
// around in Figma to inspect things. Cleared only on explicit re-run, on
// audit-error, or when the plugin first opens.
interface AuditedNode {
  id: string
  name: string
  type: string
  width: number
  height: number
}
let auditedNode: AuditedNode | null = null

const selectedWarningEl = $<HTMLParagraphElement>('selected-warning')
const resultsTitleMetaEl = $<HTMLSpanElement>('results-title-meta')
const resultsStatsEl = $<HTMLSpanElement>('results-stats')

function renderSelection(sel: SelectionInfo): void {
  // Selection changes update the Selected pane only — never the Results pane.
  // The audited component is preserved until the user explicitly re-runs.
  currentSelection = sel
  heroTitle.removeAttribute('title')
  heroMeta.removeAttribute('title')

  switch (sel.kind) {
    case 'none':
      heroTitle.textContent = 'No selection'
      heroMeta.textContent = auditedNode
        ? 'Select a component to audit, or keep inspecting the results below.'
        : 'Select a component, instance, or frame to audit.'
      runBtn.disabled = true
      break
    case 'multiple':
      heroTitle.textContent = 'Multiple items selected'
      heroMeta.textContent = `${sel.count} items — pick one. Audits run on a single component at a time.`
      runBtn.disabled = true
      break
    case 'unsupported': {
      // Largest slot keeps showing the actual node name — layout stays
      // consistent across selection types. Meta carries `<type> · <reason>`
      // on a single line so the error reads as a continuation of the stats
      // pattern, not a separate row.
      const t = formatType(sel.nodeType)
      const metaText = `${t} · Can't audit a ${t} — pick a component, instance, or frame.`
      heroTitle.textContent = sel.nodeName
      heroTitle.title = sel.nodeName
      heroMeta.textContent = metaText
      heroMeta.title = metaText
      runBtn.disabled = true
      break
    }
    case 'ok':
      heroTitle.textContent = sel.name
      heroTitle.title = sel.name
      heroMeta.textContent = `${sel.id} · ${formatType(sel.type)} · ${sel.width}×${sel.height}`
      runBtn.disabled = runState === 'running'
      break
  }
  updateRunCtaForState()
}


interface ImageCandidate {
  id: string
  name: string
  /** Raw asset bytes (via figma.getImageByHash). Format depends on what the
   * designer uploaded — could be PNG, JPEG, WEBP, or GIF — so the matching
   * `mimeType` is required when constructing the data URL for the server. */
  bytes: Uint8Array
  mimeType: 'png' | 'jpeg' | 'webp' | 'gif'
}

function renderAuditResult(
  dto: AuditDTO,
  findings: FindingsReport,
  screenshot: Uint8Array | null,
  imageCandidates: ImageCandidate[]
): void {
  // Stash the latest result so the debug-copy button has data to format.
  lastResult = { dto, findings }
  copyDebugBtn.hidden = false

  // Stamp the audited node so the Results pane stays sticky on this component
  // even when the user changes selection. Also surface its name in the
  // Results title so the report is unambiguous.
  const c = dto.component
  auditedNode = {
    id: c.id,
    name: c.name,
    type: c.type,
    width: c.width,
    height: c.height,
  }
  // Title carries just the audited component name. Type and dimensions
  // are intentionally omitted — they're available in the DTO inspector
  // when needed and the report header reads cleaner without them.
  resultsTitleMetaEl.textContent = ` — ${auditedNode.name}`
  resultsTitleMetaEl.hidden = false

  // Stats cluster moves up to the section header (right side of the title row).
  // Replaces the old "meta-block" row that lived under the header hairline.
  resultsStatsEl.innerHTML = ''
  resultsStatsEl.appendChild(buildStat('check', findings.passes.length, 'passed'))
  resultsStatsEl.appendChild(buildStat('warning', findings.flags.length, 'flagged'))
  resultsStatsEl.appendChild(buildStat('prohibit', findings.unableToTest.length, 'unable to test'))
  resultsStatsEl.hidden = false

  updateRunCtaForState()

  resultsBody.innerHTML = ''
  resultsBody.appendChild(buildGroupedFindings(dto, findings))

  // Variant audit sits directly after the deterministic group cards so the
  // user reads it as a continuation of the audit before hitting the AI
  // sections. Same bar-collapsed pattern as the AI sections; runs only on
  // click. Only rendered when the component actually has variants.
  const dtoTyped = dto as { variants?: unknown }
  if (dtoTyped.variants !== null && dtoTyped.variants !== undefined) {
    resultsBody.appendChild(buildVariantAuditSection())
  }

  // Bug 7 — Image-of-text (AI). Only rendered when the component has
  // candidate images that need evaluation. Collapsible:
  //   AI master ON  → <details open>, auto-fetch
  //   AI master OFF → closed bar with "Run with AI" override
  if (imageCandidates.length > 0) {
    resultsBody.appendChild(buildImageOfTextSection(imageCandidates, renderCallbacks))
  }

  // Visual Review section. Same collapsible state machine:
  //   AI on  → <details open>, auto-fetch
  //   AI off → closed bar with "Run with AI" override
  resultsBody.appendChild(buildVisualReviewSection(screenshot, dto, findings))

  // Manual bottom note (1.3.3 Sensory Characteristics). Always sits at the
  // very end of the report — extracted from the group cards so it can stay
  // below variant audit + AI sections too.
  const manualNote = buildManualBottomNote(findings.manual as unknown as Parameters<typeof buildManualBottomNote>[0])
  if (manualNote) resultsBody.appendChild(manualNote)

  if (findings.warnings.length > 0) {
    resultsBody.appendChild(buildWarnings(findings.warnings))
  }

  // Hairline divider — signals the boundary between the audit results
  // (everything above) and the developer/inspector tooling (the DTO inspector
  // below). Single divider only — the panel's own bottom edge closes the
  // report visually, no second hairline needed.
  const divider = document.createElement('div')
  divider.className = 'section-divider'
  resultsBody.appendChild(divider)

  resultsBody.appendChild(buildDtoInspector(dto))
}

// ── Variant audit (collapsed-bar pattern, mirrors AI sections) ──────

function buildVariantAuditSection(): HTMLElement {
  const wrap = document.createElement('section')
  wrap.className = 'variant-section'
  wrap.dataset.section = 'variant'

  // Row 1 — title left, run button right.
  const bar = document.createElement('div')
  bar.className = 'variant-section__bar'

  const title = document.createElement('span')
  title.className = 'variant-section__title'
  title.textContent = 'Variant audit'
  bar.appendChild(title)

  const btn = document.createElement('button')
  btn.className = 'btn-secondary variant-section__btn'
  btn.type = 'button'
  btn.textContent = 'Run variant audit'
  btn.addEventListener('click', () => {
    btn.disabled = true
    btn.textContent = 'Running…'
    send({ kind: 'run-variant-audit' })
  })
  bar.appendChild(btn)

  wrap.appendChild(bar)

  // Row 2 — short hint, separated from the bar by a hairline.
  const hint = document.createElement('p')
  hint.className = 'variant-section__hint'
  hint.textContent = 'Run only if this component has interactive states to test.'
  wrap.appendChild(hint)

  // Body is populated by renderVariantResult / renderVariantError after the
  // server returns. Stays collapsed (`:empty` → display:none) until then.
  const body = document.createElement('div')
  body.className = 'variant-section__body'
  wrap.appendChild(body)

  return wrap
}

/** Hide the hint + its divider line once results land — they served their
 * purpose (telling the user when to run); after the click they're noise. */
function hideVariantHint(section: HTMLElement): void {
  const hint = section.querySelector('.variant-section__hint') as HTMLElement | null
  if (hint) hint.hidden = true
}

/** Re-enable the run button + reset its label once results / errors land.
 * Without this the button stays `disabled` and the
 * `.variant-section__btn:disabled { cursor: progress }` rule keeps the
 * loading cursor stuck on hover forever. */
function resetVariantButton(section: HTMLElement): void {
  const btn = section.querySelector('.variant-section__btn') as HTMLButtonElement | null
  if (!btn) return
  btn.disabled = false
  btn.textContent = 'Run variant audit'
}

/** Render a variant finding using the same `.finding-item` shape as the
 * group cards: title row (descriptive text + criterion code) + optional
 * severity dot. Variant findings are component-scope (no per-element name
 * row), have no per-criterion visual, and no numerics — so the item
 * collapses to a single bare row. */
function buildVariantFindingItem(f: Finding): HTMLElement {
  const item = document.createElement('div')
  item.className = 'finding-item finding-item--variant'

  const titleRow = document.createElement('div')
  titleRow.className = 'finding-item__title-row'

  const titleEl = document.createElement('span')
  titleEl.className = 'finding-item__title'
  titleEl.textContent = variantTitle(f)
  titleRow.appendChild(titleEl)

  const codeEl = document.createElement('span')
  codeEl.className = 'finding-item__code'
  codeEl.textContent = variantCode(f)
  titleRow.appendChild(codeEl)

  item.appendChild(titleRow)

  // Variant flags are categorical — no numeric ratio to grade — so we treat
  // every flag as `severe`. Passes and unable-to-test get no dot, matching
  // the group-card convention.
  if (f.status === 'flag') {
    const dotRow = document.createElement('div')
    dotRow.className = 'finding-item__numerics finding-item__numerics--bare'
    dotRow.appendChild(buildSeverityDot('severe'))
    item.appendChild(dotRow)
  }

  return item
}

/** Variant items don't carry the same shape as the group findings, so
 * `headlineFor` only returns useful text for `flag` and unable-to-test rows
 * whose messages match the registered patterns (e.g. "no error variant
 * designed", "no focus variant designed"). For passes the runner emits
 * prose like "2.4.7 — focus variant present"; we strip the leading code
 * and capitalize so it reads like a title. */
function variantTitle(f: Finding): string {
  if (f.status === 'flag' || f.status === 'unable-to-test') {
    const headline = headlineFor(f)
    // headlineFor falls back to f.message when no pattern matches — only
    // accept it when it's a real headline (i.e. distinct from the message).
    if (headline !== f.message) return headline
  }
  const stripped = f.message.replace(/^\d+(?:\.\d+)+\s*[—-]\s*/, '').trim()
  if (!stripped) return f.message
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

/** Some variant findings cover multiple criteria in a single row — e.g. the
 * "No error variant" unable-to-test collapses 1.4.1, 3.3.1, and 3.3.3 into
 * one finding (the runner's message text spells them out). Show all of them
 * on the right of the title row so the user sees what's affected. */
function variantCode(f: Finding): string {
  const matches = f.message.match(/\d+\.\d+\.\d+/g) ?? []
  const seen = new Set<string>()
  const codes: string[] = []
  for (const c of [f.criterion, ...matches]) {
    if (seen.has(c)) continue
    seen.add(c)
    codes.push(c)
  }
  return codes.join(', ')
}

function renderVariantResult(
  passes: Finding[],
  flags: Finding[],
  unableToTest: Finding[]
): void {
  const section = resultsBody.querySelector(
    'section[data-section="variant"]'
  ) as HTMLElement | null
  if (!section) return
  const body = section.querySelector('.variant-section__body') as HTMLElement
  if (!body) return

  hideVariantHint(section)
  resetVariantButton(section)
  body.innerHTML = ''

  const total = passes.length + flags.length + unableToTest.length
  if (total === 0) {
    const empty = document.createElement('p')
    empty.className = 'variant-section__empty'
    empty.textContent = 'No findings.'
    body.appendChild(empty)
    return
  }

  // Order mirrors the group-card convention: flagged + unable expanded as
  // finding-items (the eye lands on what matters), passes collapsed into the
  // shared pass-disclosure pattern (consistent with every other section).
  const list = document.createElement('div')
  list.className = 'variant-section__list'
  for (const f of flags) list.appendChild(buildVariantFindingItem(f))
  for (const f of unableToTest) list.appendChild(buildVariantFindingItem(f))
  if (passes.length > 0) {
    list.appendChild(buildVariantPassDisclosure(passes))
  }
  body.appendChild(list)
}

/** Variant-scope pass disclosure. Mirrors `pass-disclosure` in
 * findings-render.ts but renders one row per criterion (no element-name
 * list — variant findings are component-scope, the component name is
 * already the audit's subject). */
function buildVariantPassDisclosure(passes: Finding[]): HTMLElement {
  const details = document.createElement('details')
  details.className = 'pass-disclosure'

  const summary = document.createElement('summary')
  summary.className = 'pass-disclosure__summary'
  buildSectionLabel(summary, passes.length, 'passed', 'check')
  details.appendChild(summary)

  const list = document.createElement('div')
  list.className = 'pass-disclosure__list'

  // Dedupe by criterion — passes are categorical for the variant audit.
  const seen = new Set<string>()
  for (const p of passes) {
    if (seen.has(p.criterion)) continue
    seen.add(p.criterion)
    const row = document.createElement('div')
    row.className = 'pass-disclosure__row'
    const label = document.createElement('span')
    label.className = 'pass-disclosure__label'
    label.textContent = variantPassLabel(p.criterion)
    row.appendChild(label)
    list.appendChild(row)
  }
  details.appendChild(list)
  return details
}

function variantPassLabel(criterion: string): string {
  switch (criterion) {
    case '1.4.1': return 'Use of color'
    case '2.4.7': return 'Focus visible'
    case '3.3.1': return 'Error identification'
    case '3.3.3': return 'Error suggestion'
    default: return criterion
  }
}

function renderVariantError(message: string): void {
  const section = resultsBody.querySelector(
    'section[data-section="variant"]'
  ) as HTMLElement | null
  if (!section) return
  const body = section.querySelector('.variant-section__body') as HTMLElement
  if (!body) return
  hideVariantHint(section)
  resetVariantButton(section)
  body.innerHTML = ''
  const err = document.createElement('div')
  err.className = 'results__mock results__mock--error'
  err.textContent = `variant audit failed — ${message}`
  body.appendChild(err)
}

// ── AI sections — collapsible, with per-section override ───────────
// Both Image-of-text and Visual Review share the same state machine:
//   AI master ON  → <details open>, auto-fetch on render
//   AI master OFF → closed bar with title + "AI off" tag + "Run with AI" button
//                   Clicking the button replaces the bar with the open form
//                   and triggers the fetch (overriding the master toggle for
//                   that section only — the toggle state itself is unchanged)

interface AiSectionRefs {
  body: HTMLElement
  count: HTMLElement
}

function buildAiSectionShell(opts: {
  sectionKey: string
  title: string
  className: string
  /** Called when the AI fetch should run (auto on AI-on, on click on AI-off). */
  trigger: (refs: AiSectionRefs) => void
}): HTMLElement {
  const section = document.createElement('section')
  section.className = `ai-section ${opts.className}`
  section.dataset.section = opts.sectionKey

  // Three states based on settings:
  //   no key       → "needs setup" closed bar with "Open settings" button
  //   key + off    → "AI off" closed bar with "Run with AI" button (override)
  //   key + on     → open <details>, auto-fetch
  const s = getSettings()
  if (!s.apiKey) {
    renderNeedsSetup()
  } else if (s.aiEnabled) {
    renderOpen()
  } else {
    renderClosed()
  }
  return section

  function renderOpen(): void {
    section.classList.remove('ai-section--off')
    section.innerHTML = ''

    const details = document.createElement('details')
    details.className = 'ai-section__details'
    details.open = true

    const summary = document.createElement('summary')
    summary.className = 'ai-section__summary'
    const title = document.createElement('span')
    title.className = 'ai-section__title'
    title.textContent = opts.title
    const count = document.createElement('span')
    count.className = 'ai-section__count'
    count.textContent = '…'
    summary.appendChild(title)
    summary.appendChild(count)
    details.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'ai-section__body'
    details.appendChild(body)

    section.appendChild(details)
    opts.trigger({ body, count })
  }

  function renderClosed(): void {
    section.classList.add('ai-section--off')
    section.innerHTML = ''

    const bar = document.createElement('div')
    bar.className = 'ai-section__bar'

    const title = document.createElement('span')
    title.className = 'ai-section__title'
    title.textContent = opts.title
    bar.appendChild(title)

    const tag = document.createElement('span')
    tag.className = 'ai-section__off-tag'
    tag.textContent = 'AI off'
    bar.appendChild(tag)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-secondary ai-section__run-btn'
    btn.textContent = 'Run with AI'
    btn.addEventListener('click', () => {
      // Re-check settings on click — user may have cleared the key in another
      // panel since we rendered. If they have, escalate to the needs-setup
      // state and open the settings page so they can fix it in one step.
      if (!getSettings().apiKey) {
        renderNeedsSetup()
        showSettingsPage()
        return
      }
      // Switch to the open form and start the fetch. The master toggle stays
      // wherever the user has it; this is a per-section override only.
      renderOpen()
    })
    bar.appendChild(btn)

    section.appendChild(bar)
  }

  function renderNeedsSetup(): void {
    section.classList.add('ai-section--off')
    section.innerHTML = ''

    const bar = document.createElement('div')
    bar.className = 'ai-section__bar'

    const title = document.createElement('span')
    title.className = 'ai-section__title'
    title.textContent = opts.title
    bar.appendChild(title)

    const tag = document.createElement('span')
    tag.className = 'ai-section__off-tag'
    tag.textContent = 'AI not set up'
    bar.appendChild(tag)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn-secondary ai-section__run-btn'
    btn.textContent = 'Open settings'
    btn.addEventListener('click', () => showSettingsPage())
    bar.appendChild(btn)

    section.appendChild(bar)
  }
}

// ── Image-of-text (Bug 7 — AI-backed) ───────────────────────────────

interface ImageOfTextVerdict {
  id: string
  hasUIText?: boolean
  reason?: string
  error?: string
}

function buildImageOfTextSection(
  candidates: ImageCandidate[],
  cb: RenderCallbacks
): HTMLElement {
  return buildAiSectionShell({
    sectionKey: 'image-of-text',
    title: 'Image of text',
    className: 'ai-section--image-of-text',
    trigger: ({ body, count }) => {
      body.textContent = 'evaluating…'
      void executeImageOfText(candidates, body, count, cb)
    },
  })
}

async function executeImageOfText(
  candidates: ImageCandidate[],
  body: HTMLElement,
  count: HTMLElement,
  cb: RenderCallbacks
): Promise<void> {
  try {
    const verdicts = await postImageOfTextToProvider(candidates)
    renderImageOfTextVerdicts(candidates, verdicts, body, count, cb)
  } catch (e) {
    count.textContent = '—'
    body.innerHTML = ''
    body.className = 'ai-section__body ai-section__body--error'
    body.textContent = describeProviderError(e, getSettings().provider)
  }
}

/**
 * Render image-of-text verdicts using the same `.finding-item` template as the
 * group cards: title row + criterion code + severity dot, clickable element
 * name on row 2, AI reason on row 3. Passes collapse into the shared
 * `pass-disclosure`; per-image AI errors collapse into the shared
 * `unable-disclosure`. Section reads identically to a normal group card.
 */
function renderImageOfTextVerdicts(
  candidates: ImageCandidate[],
  verdicts: ImageOfTextVerdict[],
  body: HTMLElement,
  count: HTMLElement,
  cb: RenderCallbacks
): void {
  const byId = new Map(verdicts.map(v => [v.id, v]))
  body.innerHTML = ''
  body.className = 'ai-section__body'

  type Row = { id: string; name: string; status: 'flag' | 'pass' | 'error'; reason: string }
  const rows: Row[] = candidates.map(c => {
    const v = byId.get(c.id)
    if (!v) return { id: c.id, name: c.name, status: 'error', reason: 'no verdict returned' }
    if (v.error) return { id: c.id, name: c.name, status: 'error', reason: v.error }
    return {
      id: c.id,
      name: c.name,
      status: v.hasUIText ? 'flag' : 'pass',
      reason: v.reason ?? '',
    }
  })

  const flagged = rows.filter(r => r.status === 'flag')
  const passed = rows.filter(r => r.status === 'pass')
  const errored = rows.filter(r => r.status === 'error')

  count.textContent = String(flagged.length)

  // Section label above the flag items — matches group-card pattern.
  if (flagged.length > 0) {
    const flaggedHeader = document.createElement('div')
    flaggedHeader.className = 'flagged-header'
    buildSectionLabel(flaggedHeader, flagged.length, 'flagged', 'warning')
    body.appendChild(flaggedHeader)
    for (const r of flagged) body.appendChild(buildImageOfTextItem(r, cb))
  }

  // Pass disclosure — synthesise a Finding per passing image so we can reuse
  // `buildPassDisclosure`. Renders as: "▸ N passed (✓) in this group" → expand
  // to "Image of text — name1, name2, name3" with each name clickable.
  if (passed.length > 0) {
    body.appendChild(buildPassDisclosure(passed.map(r => ({
      criterion: '1.4.5',
      status: 'pass' as const,
      scope: 'element' as const,
      nodeId: r.id,
      nodeName: r.name,
      message: r.reason,
    })), cb))
  }

  // Unable disclosure — per-image AI errors. Reason becomes the bucket label
  // via `details.reason`, so two images that failed for the same reason
  // collapse into one row.
  if (errored.length > 0) {
    body.appendChild(buildUnableDisclosure(errored.map(r => ({
      criterion: '1.4.5',
      status: 'unable-to-test' as const,
      scope: 'element' as const,
      nodeId: r.id,
      nodeName: r.name,
      message: r.reason,
      details: { reason: r.reason },
    })), cb))
  }

  // Edge case: every image came back unanimously pass, no flags / no errors —
  // make the empty state explicit so the body isn't just a single disclosure.
  if (flagged.length === 0 && errored.length === 0) {
    const note = document.createElement('div')
    note.className = 'flagged-header'
    note.textContent = 'No image-of-text concerns.'
    body.insertBefore(note, body.firstChild)
  }
}

/** Single row of the image-of-text list, rendered with the same DOM shape as
 *  `buildFindingItem` in findings-render.ts so it inherits the same hairlines,
 *  spacing, click targets, and severity-dot treatment. */
function buildImageOfTextItem(
  row: { id: string; name: string; status: 'flag' | 'pass' | 'error'; reason: string },
  cb: RenderCallbacks
): HTMLElement {
  const item = document.createElement('div')
  item.className = 'finding-item finding-item--image-of-text'

  const titleRow = document.createElement('div')
  titleRow.className = 'finding-item__title-row'
  const titleEl = document.createElement('span')
  titleEl.className = 'finding-item__title'
  titleEl.textContent = imageOfTextTitle(row.status)
  titleRow.appendChild(titleEl)
  const codeEl = document.createElement('span')
  codeEl.className = 'finding-item__code'
  codeEl.textContent = '1.4.5'
  titleRow.appendChild(codeEl)
  item.appendChild(titleRow)

  // Row 2: clickable element name (jumps to canvas via the shared callback).
  const nameRow = document.createElement('div')
  nameRow.className = 'finding-item__names'
  nameRow.appendChild(buildNodeLink(row.id, row.name, cb))
  item.appendChild(nameRow)

  // Row 3: AI reason on the left, severity dot pinned to the right edge —
  // matches the spacing / label visuals where `.finding-item__numerics` is a
  // flex row with `flex:1` on the text, keeping the dot at the same right-side
  // anchor regardless of how long the reason wraps to.
  if (row.reason || row.status === 'flag') {
    const num = document.createElement('div')
    num.className = 'finding-item__numerics'
    const reasonText = document.createElement('span')
    reasonText.className = 'finding-item__numerics-text'
    reasonText.textContent = row.reason
    num.appendChild(reasonText)
    if (row.status === 'flag') num.appendChild(buildSeverityDot('severe'))
    item.appendChild(num)
  }

  return item
}

function imageOfTextTitle(status: 'flag' | 'pass' | 'error'): string {
  switch (status) {
    case 'flag': return 'Image contains UI text'
    case 'pass': return 'No UI text detected'
    case 'error': return 'AI check failed'
  }
}

async function postImageOfTextToProvider(
  candidates: ImageCandidate[]
): Promise<ImageOfTextVerdict[]> {
  const s = getSettings()
  if (!s.apiKey || !s.aiEnabled) {
    throw new ProviderError('auth', 0, 'no api key configured')
  }
  const provider = PROVIDERS[s.provider]
  const model = s.model || provider.defaultModel

  // Resize each asset to ≤720px longest side before sending. Stock-photo
  // raw bytes can be 2–5MB each — vision providers handle big payloads but
  // resize keeps per-call latency + token usage in check.
  const shrunk = await Promise.all(
    candidates.map(async c => {
      const out = await shrinkImageForServer(c.bytes, c.mimeType, MAX_IMAGE_SIDE_PX)
      return { id: c.id, name: c.name, base64: out.base64, mimeType: out.mimeType }
    })
  )

  // Fan out one provider call per image; one bad image shouldn't sink the
  // others. Mirror the previous server's Promise.allSettled behaviour so the
  // UI render path stays identical (per-image error rows).
  const settled = await Promise.allSettled(
    shrunk.map(img =>
      runImageOfTextCheck({
        provider,
        apiKey: s.apiKey,
        model,
        id: img.id,
        layerName: img.name,
        base64: img.base64,
        mimeType: img.mimeType,
        timeoutMs: AI_FETCH_TIMEOUT_MS,
      })
    )
  )
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const reason = r.reason instanceof Error
      ? describeProviderError(r.reason, s.provider)
      : String(r.reason)
    return { id: shrunk[i].id, error: reason }
  })
}

// ── Visual Review (server-backed) ───────────────────────────────────

function buildVisualReviewSection(
  screenshot: Uint8Array | null,
  dto: unknown,
  findings: FindingsReport
): HTMLElement {
  return buildAiSectionShell({
    sectionKey: 'visual-review',
    title: 'Visual Review',
    className: 'ai-section--visual-review',
    trigger: ({ body, count }) => {
      // Visual Review keeps its disclaimer line — it tells the user this is
      // subjective AI commentary, not a measured WCAG result.
      const disclaimer = document.createElement('p')
      disclaimer.className = 'ai-section__disclaimer'
      disclaimer.textContent = 'subjective observations — not measured WCAG results'
      body.appendChild(disclaimer)

      const inner = document.createElement('div')
      inner.className = 'ai-section__inner'
      inner.textContent = 'reviewing screenshot…'
      body.appendChild(inner)

      void executeVisualReview(screenshot, dto, findings, inner, count)
    },
  })
}

async function executeVisualReview(
  screenshot: Uint8Array | null,
  dto: unknown,
  findings: FindingsReport,
  inner: HTMLElement,
  count: HTMLElement
): Promise<void> {
  if (!screenshot) {
    count.textContent = '—'
    inner.textContent = 'screenshot export failed; visual review skipped'
    inner.className = 'ai-section__inner ai-section__inner--error'
    return
  }

  const context = buildAuditContext(dto, findings)

  try {
    const observations = await postAuditToProvider(screenshot, context)
    count.textContent = String(observations.length)
    inner.innerHTML = ''
    inner.className = 'ai-section__inner'
    if (observations.length === 0) {
      inner.textContent = 'No visual concerns observed.'
      inner.classList.add('ai-section__inner--quiet')
      return
    }
    const list = document.createElement('ul')
    list.className = 'visual-review__list'
    for (const obs of observations) {
      const li = document.createElement('li')
      li.className = 'visual-review__item'
      li.textContent = obs
      list.appendChild(li)
    }
    inner.appendChild(list)
  } catch (e) {
    count.textContent = '—'
    inner.textContent = describeProviderError(e, getSettings().provider)
    inner.className = 'ai-section__inner ai-section__inner--error'
  }
}

// Lightweight context the server forwards to the LLM. Keeps the model oriented
// (component name / scale / what the math already cleared or flagged) without
// dumping the full DTO. Fields are best-effort — the server tolerates absence.
type AuditContextPayload = {
  component?: { name?: string; type?: string; width?: number; height?: number }
  counts?: { texts?: number; nonTextContrast?: number; images?: number; formInputs?: number }
  passed?: string[]
  flagged?: string[]
}

function buildAuditContext(dto: unknown, findings: FindingsReport): AuditContextPayload {
  const d = dto as {
    component?: { name?: string; type?: string; width?: number; height?: number }
    texts?: unknown[]
    nonTextContrast?: unknown[]
    images?: unknown[]
    formInputs?: unknown[]
  }
  const passed = uniqueCriteria(findings.passes)
  const flagged = uniqueCriteria(findings.flags)
  return {
    component: d.component
      ? {
          name: d.component.name,
          type: d.component.type,
          width: d.component.width,
          height: d.component.height,
        }
      : undefined,
    counts: {
      texts: d.texts?.length ?? 0,
      nonTextContrast: d.nonTextContrast?.length ?? 0,
      images: d.images?.length ?? 0,
      formInputs: d.formInputs?.length ?? 0,
    },
    passed,
    flagged,
  }
}

function uniqueCriteria(items: { criterion: string }[]): string[] {
  const set = new Set<string>()
  for (const i of items) set.add(i.criterion)
  return [...set].sort()
}

async function postAuditToProvider(
  screenshot: Uint8Array,
  context: AuditContextPayload
): Promise<string[]> {
  const s = getSettings()
  if (!s.apiKey || !s.aiEnabled) {
    throw new ProviderError('auth', 0, 'no api key configured')
  }
  const provider = PROVIDERS[s.provider]
  const model = s.model || provider.defaultModel
  const b64 = bytesToBase64(screenshot)

  const result = await runVisualReview({
    provider,
    apiKey: s.apiKey,
    model,
    screenshotBase64: b64,
    context,
    timeoutMs: AI_FETCH_TIMEOUT_MS,
  })
  return result.observations
}

/** Map a `ProviderError` to a human-readable, action-suggesting string for
 *  the AI section bodies. Uses the provider label from the registry so the
 *  message names the actual service the user sees in settings. */
function describeProviderError(e: unknown, providerId: ProviderId): string {
  const label = PROVIDER_LABELS[providerId]
  if (e instanceof ProviderError) {
    switch (e.code) {
      case 'auth':
        return `AI key rejected by ${label}. Open settings to update.`
      case 'rate-limit':
        return `${label} rate-limited the request. Wait a moment and retry.`
      case 'cors':
        return `${label} blocked the request from this browser context. Try a different provider in settings.`
      case 'timeout':
        return `timed out waiting for ${label} (>${Math.round(AI_FETCH_TIMEOUT_MS / 1000)}s)`
      case 'network':
        return `network error reaching ${label}. Check your connection and retry.`
      case 'bad-output':
        return `${label} returned an unexpected response shape.`
      case 'http':
        return `${label} returned HTTP ${e.status}: ${e.detail}`
    }
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return `timed out waiting for ${label} (>${Math.round(AI_FETCH_TIMEOUT_MS / 1000)}s)`
  }
  return `${label} call failed: ${e instanceof Error ? e.message : String(e)}`
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid String.fromCharCode(...big-array) call-stack blow-ups for large PNGs.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ── Image resize for the AI image-of-text payload ────────────────────
// Raw asset bytes from Figma are the original upload — typically 2–5MB
// stock photos. Six of those plus base64 inflation blow past the server's
// 10mb body cap. The UI iframe is the only context with Canvas APIs, so we
// shrink here, just-in-time, before the fetch. Output is always JPEG @ 0.85
// quality — small for photos and the vision LLM doesn't need pixel-perfect
// fidelity to judge whether UI text is baked in.
const MAX_IMAGE_SIDE_PX = 720
const RESIZE_OUTPUT_QUALITY = 0.85

async function shrinkImageForServer(
  bytes: Uint8Array,
  mimeType: 'png' | 'jpeg' | 'webp' | 'gif',
  maxSide: number
): Promise<{ base64: string; mimeType: 'png' | 'jpeg' | 'webp' | 'gif' }> {
  // Fast path: original is already small enough — skip decode/encode entirely.
  // Most design-system assets fit comfortably (icons, ui screenshots, small
  // photos), so this avoids a needless round-trip through canvas.
  if (bytes.byteLength < 250_000) {
    return { base64: bytesToBase64(bytes), mimeType }
  }

  let bitmap: ImageBitmap
  try {
    // Slice to a fresh ArrayBuffer — TS narrows Uint8Array's `buffer` to
    // ArrayBufferLike (which includes SharedArrayBuffer) and Blob refuses
    // shared buffers in its constructor's typings. .slice().buffer is a
    // plain ArrayBuffer.
    const ab = bytes.slice().buffer
    const blob = new Blob([ab], { type: `image/${mimeType}` })
    bitmap = await createImageBitmap(blob)
  } catch {
    // createImageBitmap can fail on exotic formats (animated WEBP variants,
    // truncated GIFs, etc). Send the raw bytes anyway and let the server
    // decide — payload may still fit, and a 413 surfaces a clearer error
    // than swallowing the asset silently.
    return { base64: bytesToBase64(bytes), mimeType }
  }

  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest <= maxSide) {
    bitmap.close()
    return { base64: bytesToBase64(bytes), mimeType }
  }

  const scale = maxSide / longest
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return { base64: bytesToBase64(bytes), mimeType }
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: RESIZE_OUTPUT_QUALITY })
  const buf = await out.arrayBuffer()
  return { base64: bytesToBase64(new Uint8Array(buf)), mimeType: 'jpeg' }
}

// (buildHeader removed — type+dims now live inline in the section title meta;
// the stats cluster is populated directly into #results-stats inside the
// section header. See the renderAuditResult body for both writes.)

// ── Grouped findings renderer ───────────────────────────────────────
// 6 designer-readable groups with progressive disclosure on WCAG codes.
// Each group renders Passed / Flagged / To verify subsections; empty
// subsections and empty groups don't render.

function buildGroupedFindings(dto: AuditDTO, report: FindingsReport): HTMLElement {
  // Card-based render lives in findings-render.ts. We pass an onSelectNode
  // callback that posts a select-node message to main, providing
  // jump-to-canvas behavior on the finding-item rows.
  const wrap = document.createElement('div')
  wrap.className = 'findings-groups'
  renderFindingsCards(wrap, dto, report, renderCallbacks)
  if (wrap.children.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'findings-groups__empty'
    empty.textContent = 'No findings.'
    wrap.appendChild(empty)
  }
  return wrap
}

function buildWarnings(warnings: string[]): HTMLElement {
  const wrap = document.createElement('section')
  wrap.className = 'findings findings--warnings'
  const header = document.createElement('div')
  header.className = 'findings__header'
  const titleEl = document.createElement('span')
  titleEl.className = 'findings__title'
  titleEl.textContent = 'Warnings'
  const count = document.createElement('span')
  count.className = 'findings__count'
  count.textContent = String(warnings.length)
  header.appendChild(titleEl)
  header.appendChild(count)
  wrap.appendChild(header)
  const list = document.createElement('ul')
  list.className = 'findings__list'
  for (const w of warnings) {
    const li = document.createElement('li')
    li.className = 'findings__item findings__item--warn'
    li.textContent = w
    list.appendChild(li)
  }
  wrap.appendChild(list)
  return wrap
}

function buildDtoInspector(dto: unknown): HTMLElement {
  const details = document.createElement('details')
  details.className = 'results__details'

  // Summary acts as the card's title bar — title left, Copy debug button
  // right, always visible regardless of whether the JSON body is open.
  // Mirrors the variant-section / AI-section bar pattern so all section
  // headers read the same way.
  const summaryEl = document.createElement('summary')
  const titleEl = document.createElement('span')
  titleEl.className = 'results__details__title'
  titleEl.textContent = 'Inspect raw DTO'
  summaryEl.appendChild(titleEl)

  // Relocate the existing Copy debug button into the summary bar. The button
  // lives in the HTML template (id="copy-debug-btn") so the original click
  // handler stays intact. stopPropagation prevents the click from also
  // toggling the <details> open/closed.
  copyDebugBtn.hidden = false
  copyDebugBtn.addEventListener('click', stopBubble, { once: false })
  summaryEl.appendChild(copyDebugBtn)

  details.appendChild(summaryEl)

  const pre = document.createElement('pre')
  pre.className = 'results__json'
  pre.textContent = JSON.stringify(dto, null, 2)
  details.appendChild(pre)
  return details
}

function stopBubble(e: Event): void {
  e.stopPropagation()
}

function renderAuditError(message: string): void {
  resultsBody.innerHTML = ''
  lastResult = null
  auditedNode = null
  copyDebugBtn.hidden = true
  resultsTitleMetaEl.textContent = ''
  resultsTitleMetaEl.hidden = true
  resultsStatsEl.innerHTML = ''
  resultsStatsEl.hidden = true
  const block = document.createElement('div')
  block.className = 'results__mock results__mock--error'
  block.textContent = `audit failed — ${message}`
  resultsBody.appendChild(block)
  updateRunCtaForState()
}


function clearResults(): void {
  resultsBody.innerHTML =
    '<p class="results__empty">Run an audit to see findings.</p>'
  lastResult = null
  auditedNode = null
  copyDebugBtn.hidden = true
  resultsTitleMetaEl.textContent = ''
  resultsTitleMetaEl.hidden = true
  resultsStatsEl.innerHTML = ''
  resultsStatsEl.hidden = true
  updateRunCtaForState()
}

/**
 * CTA copy is selection-agnostic — only two strings, never the component name:
 *
 *   - running                                      → "Running…" disabled
 *   - selection invalid (none/multiple/unsupported)→ "Run audit" disabled
 *   - selection ok, no prior audit                 → "Run audit"
 *   - selection ok, prior audit on same node       → "Re-run audit" + warning
 *   - selection ok, prior audit on a different one → "Run audit" + warning
 *
 * The button width stays stable across selections so the layout doesn't reflow.
 */
function updateRunCtaForState(): void {
  if (runState === 'running') {
    runBtnLabel.textContent = 'Running…'
    runBtn.disabled = true
    selectedWarningEl.hidden = true
    return
  }

  const sel = currentSelection
  if (sel.kind !== 'ok') {
    runBtnLabel.textContent = 'Run audit'
    runBtn.disabled = true
    selectedWarningEl.hidden = true
    return
  }

  if (auditedNode && auditedNode.id === sel.id) {
    runBtnLabel.textContent = 'Re-run audit'
  } else {
    runBtnLabel.textContent = 'Run audit'
  }
  runBtn.disabled = false
  selectedWarningEl.hidden = !auditedNode
}

// ── Debug copy ──────────────────────────────────────────────────────

let toastTimer: number | null = null

function showToast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer)
    toastTimer = null
  }
  toastEl.textContent = message
  toastEl.className = `toast toast--${kind}`
  toastEl.hidden = false
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true
    toastTimer = null
  }, TOAST_VISIBLE_MS)
}

async function copyDebugReportToClipboard(): Promise<void> {
  if (!lastResult) {
    showToast('nothing to copy — run an audit first', 'error')
    return
  }
  const markdown = formatDebugReport(lastResult.dto, lastResult.findings, {
    pluginVersion: PLUGIN_VERSION,
    generatedAt: new Date().toISOString(),
  })

  // Modern Clipboard API isn't reliably available inside the Figma plugin
  // iframe — its secure-context / user-activation requirements aren't always
  // met. We try it first when it exists, then fall back to the legacy
  // execCommand('copy') trick which works in restrictive iframes.
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(markdown)
      showToast('debug report copied', 'ok')
      return
    }
  } catch {
    // Fall through to the textarea fallback below.
  }

  if (copyViaExecCommand(markdown)) {
    showToast('debug report copied', 'ok')
    return
  }

  showToast('copy failed — clipboard blocked', 'error')
}

function copyViaExecCommand(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  // Take it out of the layout but keep it focusable. `position: fixed` + zero
  // opacity avoids any visible flash without breaking selection.
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '1px'
  ta.style.height = '1px'
  ta.style.opacity = '0'
  ta.style.pointerEvents = 'none'
  document.body.appendChild(ta)
  const previouslyFocused = document.activeElement as HTMLElement | null
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
    previouslyFocused.focus()
  }
  return ok
}

copyDebugBtn.addEventListener('click', () => {
  void copyDebugReportToClipboard()
})

// Single delegated handler for findings-row interactions:
//   - (i) info-icon → toggle the next-sibling `.findings-row__criterion` reveal
//   - clickable name → post select-node so main can select + scroll into view
resultsBody.addEventListener('click', (e: MouseEvent) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return

  const infoBtn = target.closest('.findings-row__info')
  if (infoBtn instanceof HTMLButtonElement) {
    const reveal = infoBtn.nextElementSibling
    if (!(reveal instanceof HTMLElement) || !reveal.classList.contains('findings-row__criterion')) return
    const expanded = infoBtn.getAttribute('aria-expanded') === 'true'
    infoBtn.setAttribute('aria-expanded', expanded ? 'false' : 'true')
    reveal.hidden = expanded
    return
  }

  const nameBtn = target.closest('.findings-row__name--clickable')
  if (nameBtn instanceof HTMLButtonElement) {
    const id = nameBtn.dataset.nodeId
    if (id) send({ kind: 'select-node', nodeId: id })
    return
  }
})

function formatType(t: string): string {
  return t.replace(/_/g, ' ').toLowerCase()
}

function setRunning(running: boolean): void {
  runState = running ? 'running' : 'idle'
  updateRunCtaForState()
}

runBtn.addEventListener('click', () => {
  if (currentSelection.kind !== 'ok' || runState === 'running') return
  setRunning(true)
  clearResults()
  send({ kind: 'run-audit' })
})

// Auto-resize the plugin window to match content. ResizeObserver fires whenever
// the body's measured height changes (selection state copy length, results
// rendered, etc.). Throttled by rAF + a small debounce to avoid jitter.
let resizeFrame = 0
let lastSentHeight = -1
function sendHeight(): void {
  const h = Math.ceil(document.documentElement.getBoundingClientRect().height)
  if (h === lastSentHeight) return
  lastSentHeight = h
  send({ kind: 'resize', height: h })
}
function scheduleHeightSend(): void {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    sendHeight()
  })
}
new ResizeObserver(scheduleHeightSend).observe(document.documentElement)

window.addEventListener('message', (event: MessageEvent) => {
  const msg = (event.data && (event.data as { pluginMessage?: MainToUI }).pluginMessage) || null
  if (!msg) return
  switch (msg.kind) {
    case 'state':
      renderSelection(msg.selection)
      return
    case 'audit-result':
      setRunning(false)
      renderAuditResult(msg.dto, msg.findings, msg.screenshot, msg.imageCandidates)
      return
    case 'audit-error':
      setRunning(false)
      renderAuditError(msg.error)
      return
    case 'variant-result':
      renderVariantResult(msg.passes, msg.flags, msg.unableToTest)
      return
    case 'variant-error':
      renderVariantError(msg.error)
      return
  }
})

send({ kind: 'init' })
