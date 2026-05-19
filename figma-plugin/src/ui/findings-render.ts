// Card-based findings renderer. Replaces the previous row-by-row dump.
// Pure DOM module — no figma globals, no fetch. Callers wire jump-to-node
// behavior via `onSelectNode`.
//
// Per redesign plan:
//   - One CARD per WCAG group (color-contrast / typography / forms-errors / ...).
//   - Inside the card: flagged items (full detail), pass disclosure (collapsed),
//     unable-to-test footer notes (italic mute).
//   - Items: descriptive title left + criterion code right; clickable element
//     names; per-criterion visual primitive (swatches / bar / thumb pair /
//     currently-needed / quoted text); compact numerics; severity dot.
//   - Identical findings collapse via groupSimilar.
//   - Variant findings (1.4.1 / 2.4.7 / 3.3.1 / 3.3.3) are NOT rendered here —
//     they live under the separate "Variant audit" progressive-disclosure
//     flow. We skip variant criteria in the group cards.

import type { Finding, FindingsReport, ManualCheckItem } from '../checks/findings.ts'
import type { AuditDTO } from '../shared/dtos'
import { buildGroupViews, type GroupView, type ToVerifyEntry } from './findings-groups.ts'
import { headlineFor } from './headlines.ts'
import { severityFromRatio, type SeverityTier } from './severity.ts'
import {
  plainEnglishReason,
  typographyPropertyLabel,
  parsePercent,
  pctToPx,
} from './copy.ts'
import { groupSimilar, type GroupedFinding } from './group-similar.ts'
import { buildStat, buildIcon, type StatIcon } from './icon-stat.ts'

// ── Public entry point ──────────────────────────────────────────────

export interface RenderCallbacks {
  onSelectNode: (nodeId: string) => void
}

/** Variant criteria are surfaced via the separate Variant Audit progressive-
 * disclosure flow, not the group cards. Skip them here so we don't render
 * placeholder "no variant designed" entries on every audit. */
const VARIANT_CRITERIA = new Set(['1.4.1', '2.4.7', '3.3.1', '3.3.3'])

/** True when the criterion string looks like a WCAG SC code (X.Y or X.Y.Z). */
function isWcagCode(criterion: string): boolean {
  return /^\d+\.\d+(\.\d+)?$/.test(criterion)
}

export function displayCodesForCriterion(criterion: string): string[] {
  if (criterion === 'text-reflow') return ['1.4.4', '1.4.10', '1.4.12']
  return isWcagCode(criterion) ? [criterion] : []
}

export interface StandardRef {
  standard: 'WCAG' | 'GIGW 3.0' | 'IS 17802'
  clause: string
}

/**
 * Cross-standard mapping for a finding's criterion. GIGW 3.0 §5.2 and IS 17802
 * (web clause) both adopt WCAG 2.1 AA *by reference*, so every WCAG SC the
 * plugin tests is equally a GIGW and an IS obligation — the by-reference
 * labels are accurate without per-clause research. Non-WCAG criteria
 * (`typography`, AI/visual-review) map to nothing, exactly like
 * `displayCodesForCriterion`.
 */
export function standardsForCriterion(criterion: string): StandardRef[] {
  const wcag = displayCodesForCriterion(criterion)
  if (wcag.length === 0) return []
  return [
    ...wcag.map((c): StandardRef => ({ standard: 'WCAG', clause: c })),
    { standard: 'GIGW 3.0', clause: '§5.2' },
    { standard: 'IS 17802', clause: 'web' },
  ]
}

function standardRefLabel(s: StandardRef): string {
  return `${s.standard} ${s.clause}`
}

export function renderFindingsCards(
  host: HTMLElement,
  dto: AuditDTO,
  findings: FindingsReport,
  cb: RenderCallbacks
): void {
  // Strip variant criteria from each bucket before grouping into cards.
  const filtered: FindingsReport = {
    passes: findings.passes.filter(f => !VARIANT_CRITERIA.has(f.criterion)),
    flags: findings.flags.filter(f => !VARIANT_CRITERIA.has(f.criterion)),
    unableToTest: findings.unableToTest.filter(f => !VARIANT_CRITERIA.has(f.criterion)),
    manual: findings.manual,
    warnings: findings.warnings,
  }
  const groups = buildGroupViews(filtered)

  for (const group of groups) {
    if (group.id === 'inclusive-instructions') continue // rendered separately at bottom
    if (
      group.passed.length === 0 &&
      group.flagged.length === 0 &&
      group.toVerify.length === 0
    ) {
      continue
    }
    host.appendChild(buildGroupCard(group, dto, cb))
  }

  // Manual bottom note (1.3.3 Sensory Characteristics) is rendered separately
  // by index.ts so it always sits at the very bottom of the report — below
  // the Variant Audit, Image-of-Text and Visual Review sections too.
}

// ── Group card ──────────────────────────────────────────────────────

function buildGroupCard(group: GroupView, dto: AuditDTO, cb: RenderCallbacks): HTMLElement {
  const card = document.createElement('section')
  card.className = 'group-card'
  card.dataset.group = group.id

  const header = document.createElement('header')
  header.className = 'group-card__header'
  const title = document.createElement('span')
  title.className = 'group-card__title'
  title.textContent = group.title.toUpperCase()
  header.appendChild(title)

  // Per-group stats cluster (mirrors the top header). Counts come straight
  // from the GroupView buckets so they always match what's rendered below.
  const stats = document.createElement('span')
  stats.className = 'group-card__stats'
  const unableCount = group.toVerify.filter(e => e.kind === 'finding').length
  stats.appendChild(buildStat('check', group.passed.length, 'passed'))
  stats.appendChild(buildStat('warning', group.flagged.length, 'flagged'))
  stats.appendChild(buildStat('prohibit', unableCount, 'unable to test'))
  header.appendChild(stats)

  card.appendChild(header)

  const body = document.createElement('div')
  body.className = 'group-card__body'

  // 1. Flagged items, grouped by identical (fg/bg/ratio) tuple etc.
  // Quiet header above mirrors the pass-disclosure summary's typography so
  // the three sections (flagged / passed / unable) read as siblings — but
  // it's a static label, not a <details>, since flagged items are always
  // expanded (no chevron, no toggle).
  if (group.flagged.length > 0) {
    const flaggedHeader = document.createElement('div')
    flaggedHeader.className = 'flagged-header'
    buildSectionLabel(flaggedHeader, group.flagged.length, 'flagged', 'warning')
    body.appendChild(flaggedHeader)
  }
  const flagGroups = groupSimilar(group.flagged)
  for (const grouped of flagGroups) {
    body.appendChild(buildFindingItem(grouped, dto, cb))
  }

  // 2. Pass disclosure (collapsed by default).
  if (group.passed.length > 0) {
    body.appendChild(buildPassDisclosure(group.passed, cb))
  }

  // 3. Unable-to-test disclosure (collapsed by default, mirrors pass).
  const unableFindings = group.toVerify
    .filter((e): e is { kind: 'finding'; finding: Finding } => e.kind === 'finding')
    .map(e => e.finding)
  if (unableFindings.length > 0) {
    body.appendChild(buildUnableDisclosure(unableFindings, cb))
  }

  card.appendChild(body)
  return card
}

// ── One flagged item (title row + element list + visual + numerics) ─

function buildFindingItem(
  grouped: GroupedFinding,
  dto: AuditDTO,
  cb: RenderCallbacks
): HTMLElement {
  const item = document.createElement('div')
  item.className = 'finding-item'

  // Row 1: title left, criterion code right (only when the criterion is a
  // standard WCAG SC like "1.4.3" or "2.4.7" — non-SC criteria like
  // "typography" are general design opinion, not standards, and shouldn't
  // surface a code in the UI).
  const titleRow = document.createElement('div')
  titleRow.className = 'finding-item__title-row'
  const titleEl = document.createElement('span')
  titleEl.className = 'finding-item__title'
  titleEl.textContent = headlineFor(grouped.representative)
  titleRow.appendChild(titleEl)
  const criterion = grouped.representative.criterion
  const displayCodes = displayCodesForCriterion(criterion)
  if (displayCodes.length > 0) {
    // Collapsed: the WCAG code(s) exactly as before. Expanding reveals the
    // by-reference cross-mapping (GIGW 3.0 §5.2 · IS 17802 web). Native
    // <details> — same zero-JS disclosure idiom as the pass/unable lists.
    const details = document.createElement('details')
    details.className = 'finding-item__standards'

    const summary = document.createElement('summary')
    summary.className = 'finding-item__code'
    summary.textContent = displayCodes.join(' · ')
    details.appendChild(summary)

    // One short line per standard (stacked) rather than one wide joined
    // line. Combined with the absolute-positioned panel CSS, this keeps the
    // expansion to 2–3 narrow lines and stops the title row from reflowing.
    const list = document.createElement('div')
    list.className = 'finding-item__standards-list'
    for (const ref of standardsForCriterion(criterion)) {
      const line = document.createElement('span')
      line.className = 'finding-item__standards-line'
      line.textContent = standardRefLabel(ref)
      list.appendChild(line)
    }
    details.appendChild(list)

    titleRow.appendChild(details)
  }
  item.appendChild(titleRow)

  // Row 2: clickable element names. Skip when scope is component-level
  // (variant findings) since the name is the component itself.
  if (grouped.representative.scope === 'element') {
    const nameRow = document.createElement('div')
    nameRow.className = 'finding-item__names'
    const seen = new Set<string>()
    grouped.nodes.forEach((n, i) => {
      if (!n.name) return
      const key = `${n.id ?? ''}|${n.name}`
      if (seen.has(key)) return
      seen.add(key)
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'finding-item__name-sep'
        sep.textContent = ', '
        nameRow.appendChild(sep)
      }
      nameRow.appendChild(buildNodeLink(n.id, n.name, cb))
    })
    item.appendChild(nameRow)
  }

  // Row 3+: per-criterion visual primitive + numerics.
  const visualRow = buildVisualForCriterion(grouped, dto, cb)
  if (visualRow) item.appendChild(visualRow)

  return item
}

// ── Per-criterion visual builders ───────────────────────────────────

function buildVisualForCriterion(
  grouped: GroupedFinding,
  dto: AuditDTO,
  _cb: RenderCallbacks
): HTMLElement | null {
  const f = grouped.representative
  switch (f.criterion) {
    case '1.4.3':
      return buildContrastVisual(f, dto, 'text')
    case '1.4.11':
      return buildContrastVisual(f, dto, 'element')
    case 'typography':
      return buildSpacingVisual(f, dto)
    case 'text-reflow':
      return buildTextReflowVisual(f)
    case '3.3.2':
      return buildLabelVisual(grouped, dto)
    case '1.4.5':
      return buildImageOfTextRowVisual(f)
    case '2.4.4':
      return buildLinkPurposeVisual(f)
    case '2.4.6':
      return buildHeadingsLabelsVisual(f)
    case '2.5.8':
      return buildTouchTargetVisual(f)
    default:
      return null
  }
}

// ── 1.4.3 / 1.4.11 — swatches + ratio numerics ──────────────────────

function buildContrastVisual(f: Finding, dto: AuditDTO, kind: 'text' | 'element'): HTMLElement {
  const row = document.createElement('div')
  row.className = 'finding-item__visual finding-item__visual--contrast'

  const d = (f.details ?? {}) as { actual?: number; required?: number }
  const colors = lookupContrastColors(f, dto, kind)

  // Left column: 3-column grid laid out as
  //   row 1:  [fg swatch] [on] [bg swatch]
  //   row 2:  [fg hex   ]      [bg hex   ]
  // Each hex block sits directly under its swatch. The fg swatch paints
  // fg-rgba over the bg color so a translucent foreground (e.g. white @ 30%)
  // renders the same muddy result the user sees on canvas — matching the
  // contrast math, which already composited the fg over the bg. Opacity, when
  // present, drops to a second line inside the hex block so it doesn't widen
  // the column and push the right-side numerics out of position.
  const left = document.createElement('div')
  left.className = 'contrast-left'

  left.appendChild(
    buildSwatch(colors.fgHex, colors.fgAlpha, colors.bgHex, kind === 'text' ? 'Aa' : null, 'fg')
  )
  const onLabel = document.createElement('span')
  onLabel.className = 'contrast-on'
  onLabel.textContent = 'on'
  left.appendChild(onLabel)
  left.appendChild(buildSwatch(colors.bgHex, colors.bgAlpha, null, null, 'bg'))

  left.appendChild(buildHexBlock(colors.fgHex, colors.fgAlpha, 'fg'))
  // Empty cell under the "on" label keeps the grid aligned without rendering.
  const spacer = document.createElement('span')
  spacer.className = 'contrast-on-spacer'
  spacer.setAttribute('aria-hidden', 'true')
  left.appendChild(spacer)
  left.appendChild(buildHexBlock(colors.bgHex, colors.bgAlpha, 'bg'))

  row.appendChild(left)

  // Right column: current / needs stacked vertically, severity dot at far right.
  const right = document.createElement('div')
  right.className = 'contrast-right'
  if (typeof d.actual === 'number' && typeof d.required === 'number') {
    const numerics = document.createElement('div')
    numerics.className = 'contrast-numerics'
    numerics.appendChild(buildNumericLine('current', `${d.actual.toFixed(2)} : 1`))
    numerics.appendChild(buildNumericLine('needs', `≥ ${d.required} : 1`))
    right.appendChild(numerics)
    right.appendChild(buildSeverityDot(severityFromRatio(d.actual, d.required)))
  } else {
    right.appendChild(buildSeverityDot('severe'))
  }
  row.appendChild(right)

  return row
}

function buildNumericLine(label: string, value: string): HTMLElement {
  const line = document.createElement('div')
  line.className = 'contrast-numerics__line'
  const lbl = document.createElement('span')
  lbl.className = 'contrast-numerics__label'
  lbl.textContent = label
  const val = document.createElement('span')
  val.className = 'contrast-numerics__value'
  val.textContent = value
  line.appendChild(lbl)
  line.appendChild(val)
  return line
}

interface ContrastColors {
  fgHex: string | null
  fgAlpha: number       // 0–1; 1 when the source paint is fully opaque
  bgHex: string | null
  bgAlpha: number
}

function lookupContrastColors(f: Finding, dto: AuditDTO, kind: 'text' | 'element'): ContrastColors {
  // Prefer the runner's structured details. For text findings this carries the
  // colors of the FAILING segment — important for mixed-color runs (e.g. an
  // inline orange link inside a black paragraph), where segments[0] would
  // otherwise mislead the swatch. Alpha lives on the DTO's ResolvedFill.rgba[3]
  // (the runner only stamps hex into details), so we still walk the DTO when
  // we need to report opacity.
  const d = (f.details ?? {}) as { fgHex?: unknown; bgHex?: unknown }
  const detailsFg = typeof d.fgHex === 'string' ? d.fgHex : null
  const detailsBg = typeof d.bgHex === 'string' ? d.bgHex : null

  let fgHex = detailsFg
  let bgHex = detailsBg
  let fgAlpha = 1
  let bgAlpha = 1

  if (f.nodeId) {
    if (kind === 'text') {
      const el = dto.texts.find(t => t.id === f.nodeId)
      if (el) {
        const seg = el.segments[0]
        fgHex = fgHex ?? seg?.fill?.hex ?? null
        fgAlpha = seg?.fill?.rgba?.[3] ?? 1
        bgHex = bgHex ?? (el.background.kind === 'solid' ? el.background.hex : null)
        bgAlpha = el.background.kind === 'solid' ? (el.background.rgba?.[3] ?? 1) : 1
      }
    } else {
      const el = dto.nonTextContrast.find(i => i.id === f.nodeId)
      if (el) {
        const fg = el.stroke ?? el.fill
        fgHex = fgHex ?? fg?.hex ?? null
        fgAlpha = fg?.rgba?.[3] ?? 1
        bgHex = bgHex ?? (el.background.kind === 'solid' ? el.background.hex : null)
        bgAlpha = el.background.kind === 'solid' ? (el.background.rgba?.[3] ?? 1) : 1
      }
    }
  }

  return { fgHex, fgAlpha, bgHex, bgAlpha }
}

/** Vertical hex block that sits directly under a swatch.
 *  - Line 1: hex value (or em-dash when unresolved)
 *  - Line 2: opacity percentage, only when alpha is fractional
 *
 * Keeping the percentage on its own line stops the row from widening and
 * pushing the right-side numerics out of place when a paint is translucent. */
function buildHexBlock(hex: string | null, alpha: number, role: 'fg' | 'bg'): HTMLElement {
  const block = document.createElement('div')
  block.className = `contrast-hex contrast-hex--${role}`

  const hexLine = document.createElement('span')
  hexLine.className = 'contrast-hex__hex'
  hexLine.textContent = hex ?? '—'
  block.appendChild(hexLine)

  if (hex && alpha < 0.999) {
    const alphaLine = document.createElement('span')
    alphaLine.className = 'contrast-hex__alpha'
    alphaLine.textContent = `${Math.round(alpha * 100)}%`
    block.appendChild(alphaLine)
  }
  return block
}

function buildSwatch(
  hex: string | null,
  alpha: number,
  underlay: string | null,
  label: string | null,
  role: 'fg' | 'bg'
): HTMLElement {
  const sw = document.createElement('span')
  sw.className = `swatch swatch--${role}`
  if (!hex) {
    sw.classList.add('swatch--empty')
  } else if (alpha < 0.999 && underlay) {
    // Translucent foreground over the actual background — the swatch shows
    // exactly what the user sees on canvas (and what the contrast math used),
    // so a low-opacity fill no longer reads as the source color.
    sw.style.backgroundColor = underlay
    sw.style.backgroundImage = `linear-gradient(${rgbaCss(hex, alpha)}, ${rgbaCss(hex, alpha)})`
  } else if (alpha < 0.999) {
    // Translucent over the panel — fall back to the rgba so the swatch at
    // least registers as transparent rather than miscolored.
    sw.style.background = rgbaCss(hex, alpha)
  } else {
    sw.style.background = hex
  }
  if (label) {
    const t = document.createElement('span')
    t.className = 'swatch__label'
    t.textContent = label
    // Auto-pick label color from the *visually composited* color (fg blended
    // over underlay if present), so the "Aa" stays legible on a translucent
    // swatch that looks nothing like the source hex.
    if (hex) {
      const visualHex = alpha < 0.999 && underlay ? compositeHex(hex, alpha, underlay) : hex
      if (visualHex) t.style.color = pickReadableForeground(visualHex)
    }
    sw.appendChild(t)
  }
  return sw
}

function rgbaCss(hex: string, alpha: number): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return hex
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`
}

/** Straight-alpha composite of `fg @ alpha` over solid `bg`. Returns the
 * resulting hex. Only used to pick a readable label color for the "Aa"
 * glyph — the contrast runner does its own (more careful) compositing. */
function compositeHex(fgHex: string, alpha: number, bgHex: string): string | null {
  const fm = fgHex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  const bm = bgHex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!fm || !bm) return null
  const out = (fIdx: number): number => {
    const fv = parseInt(fm[fIdx], 16)
    const bv = parseInt(bm[fIdx], 16)
    return Math.round(fv * alpha + bv * (1 - alpha))
  }
  const toHex = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${toHex(out(1))}${toHex(out(2))}${toHex(out(3))}`
}

function pickReadableForeground(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return '#111111'
  const r = parseInt(m[1], 16) / 255
  const g = parseInt(m[2], 16) / 255
  const b = parseInt(m[3], 16) / 255
  // Quick perceived luminance check.
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.5 ? '#111111' : '#f2eee3'
}

// ── 1.4.12 — spacing bar ────────────────────────────────────────────

function buildSpacingVisual(f: Finding, dto: AuditDTO): HTMLElement {
  const row = document.createElement('div')
  row.className = 'finding-item__visual finding-item__visual--spacing'

  const d = (f.details ?? {}) as { property?: string; actual?: string; required?: string }
  const property = typeof d.property === 'string' ? d.property : '—'
  const propertyLabel = typographyPropertyLabel(property)

  const labelEl = document.createElement('div')
  labelEl.className = 'spacing__label'
  labelEl.textContent = propertyLabel
  row.appendChild(labelEl)

  const actualPct = parsePercent(d.actual)
  const requiredPct = parsePercent(d.required)

  // Look up the source text element so we can render px translations.
  const text = f.nodeId ? dto.texts.find(t => t.id === f.nodeId) : null
  const fontSize =
    text?.segments.reduce((m, s) => Math.max(m, s.fontSize), 0) ?? 0

  const bar = buildSpacingBar(actualPct, requiredPct)
  row.appendChild(bar)

  // Numerics: 120% (19 px)   needs ≥ 150% (24 px)
  const num = document.createElement('div')
  num.className = 'finding-item__numerics'
  const numText = document.createElement('span')
  numText.className = 'finding-item__numerics-text'
  const actualStr = formatSpacingValue(actualPct, fontSize, d.actual)
  const requiredStr = formatSpacingValue(requiredPct, fontSize, d.required, true)
  numText.textContent = `${actualStr}   needs ≥ ${requiredStr}`
  num.appendChild(numText)

  if (typeof actualPct === 'number' && typeof requiredPct === 'number') {
    num.appendChild(buildSeverityDot(severityFromRatio(actualPct, requiredPct)))
  } else {
    num.appendChild(buildSeverityDot('severe'))
  }
  row.appendChild(num)

  return row
}

function formatSpacingValue(
  pct: number | null,
  fontSize: number,
  raw: string | undefined,
  _isRequired = false
): string {
  if (typeof pct !== 'number') return raw ?? '—'
  const px = pctToPx(pct, fontSize)
  return px ? `${pct}% (${px})` : `${pct}%`
}

function buildSpacingBar(actual: number | null, required: number | null): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'spacing-bar'
  if (typeof actual !== 'number' || typeof required !== 'number') {
    wrap.classList.add('spacing-bar--empty')
    return wrap
  }
  // Build a visual range where the threshold sits at ~67% of the bar. Works
  // for positive thresholds (e.g. line-height ≥ 75%) AND negative thresholds
  // (e.g. letter-spacing ≥ -6%) by using `|required|` as the visual unit and
  // shifting the origin so the threshold lands at the same place either way.
  //
  //   scaleMin = required - |required|      (one full step below threshold)
  //   scaleMax = required + |required|/2    (half step above for headroom)
  //   threshold position  = 67% on the bar (consistent across signs)
  const span = Math.abs(required)
  if (span === 0) {
    wrap.classList.add('spacing-bar--empty')
    return wrap
  }
  const scaleMin = required - span
  const scaleMax = required + span * 0.5
  const range = scaleMax - scaleMin

  const norm = (v: number): number =>
    Math.min(100, Math.max(0, ((v - scaleMin) / range) * 100))

  const actualPct = norm(actual)
  const reqPct = norm(required)

  const fill = document.createElement('span')
  fill.className = 'spacing-bar__fill'
  fill.style.width = `${actualPct}%`
  wrap.appendChild(fill)

  const tick = document.createElement('span')
  tick.className = 'spacing-bar__tick'
  tick.style.left = `${reqPct}%`
  tick.title = `required ≥ ${required}%`
  wrap.appendChild(tick)

  return wrap
}

// ── 3.3.2 — Currently / Needed two-line block ───────────────────────

function buildLabelVisual(grouped: GroupedFinding, dto: AuditDTO): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'finding-item__visual finding-item__visual--label'

  // Find the placeholder text from the first member's source FormInputElement.
  const firstId = grouped.representative.nodeId
  const input = firstId ? dto.formInputs.find(i => i.id === firstId) : null
  const placeholderText = input?.childTextNodes.find(t => t.isInsideInput)?.text ?? null

  const currentRow = document.createElement('div')
  currentRow.className = 'label-row label-row--current'
  const currentLabel = document.createElement('span')
  currentLabel.className = 'label-row__label'
  currentLabel.textContent = 'Currently:'
  currentRow.appendChild(currentLabel)
  const currentValue = document.createElement('span')
  currentValue.className = 'label-row__value'
  currentValue.textContent = placeholderText ? `"${placeholderText}"` : 'nothing visible'
  currentRow.appendChild(currentValue)
  wrap.appendChild(currentRow)

  const neededRow = document.createElement('div')
  neededRow.className = 'label-row label-row--needed'
  const neededLabel = document.createElement('span')
  neededLabel.className = 'label-row__label'
  neededLabel.textContent = 'Needed:'
  neededRow.appendChild(neededLabel)
  const neededValue = document.createElement('span')
  neededValue.className = 'label-row__value'
  neededValue.textContent = 'a separate label above the input'
  neededRow.appendChild(neededValue)
  wrap.appendChild(neededRow)

  // Severity dot — labels missing is always severe.
  const dotRow = document.createElement('div')
  dotRow.className = 'finding-item__numerics finding-item__numerics--bare'
  dotRow.appendChild(buildSeverityDot('severe'))
  wrap.appendChild(dotRow)

  return wrap
}

// ── Text reflow — Currently / Needed two-line block ─────────────────

function buildTextReflowVisual(_f: Finding): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'finding-item__visual finding-item__visual--label'

  wrap.appendChild(buildLabelRow('Currently:', 'fixed-height text box', 'current'))
  wrap.appendChild(buildLabelRow('Needed:', 'height can grow when text size or spacing changes', 'needed'))

  const dotRow = document.createElement('div')
  dotRow.className = 'finding-item__numerics finding-item__numerics--bare'
  dotRow.appendChild(buildSeverityDot('severe'))
  wrap.appendChild(dotRow)

  return wrap
}

function buildLabelRow(label: string, value: string, kind: 'current' | 'needed'): HTMLElement {
  const row = document.createElement('div')
  row.className = `label-row label-row--${kind}`
  const labelEl = document.createElement('span')
  labelEl.className = 'label-row__label'
  labelEl.textContent = label
  row.appendChild(labelEl)
  const valueEl = document.createElement('span')
  valueEl.className = 'label-row__value'
  valueEl.textContent = value
  row.appendChild(valueEl)
  return row
}

// ── 2.4.4 / 2.4.6 — quoted offending text + mild severity dot ───────

/**
 * Shared quoted-text visual used by 2.4.4 (vague link text) and 2.4.6
 * (placeholder labels / link text). Both criteria surface the offending
 * `details.text` as a quoted string with a mild severity dot.
 */
function buildQuotedTextVisual(f: Finding, modifier: string, fallback: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `finding-item__visual finding-item__visual--${modifier}`

  // Wrap text + dot in a `.finding-item__numerics` row so the text expands
  // (flex: 1) and pushes the severity dot to the right — mirrors the
  // bottom-row pattern used by the spacing visual.
  const num = document.createElement('div')
  num.className = 'finding-item__numerics'

  const d = (f.details ?? {}) as { text?: string }
  const note = document.createElement('span')
  note.className = 'finding-item__numerics-text'
  note.textContent = d.text ? `"${d.text}"` : fallback
  num.appendChild(note)

  // Warning-severity (workshop intent + 2.4.6 content-quality framing); mild
  // dot reads as "should fix", not "must fix".
  num.appendChild(buildSeverityDot('mild'))

  wrap.appendChild(num)
  return wrap
}

function buildLinkPurposeVisual(f: Finding): HTMLElement {
  return buildQuotedTextVisual(f, 'link-purpose', 'vague phrase')
}

function buildHeadingsLabelsVisual(f: Finding): HTMLElement {
  return buildQuotedTextVisual(f, 'headings-labels', 'placeholder text')
}

// ── 2.5.8 — actual target over fixed 24×24 reference ────────────────

function buildTouchTargetVisual(f: Finding): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'finding-item__visual finding-item__visual--touch-target'

  const d = (f.details ?? {}) as {
    width?: unknown
    height?: unknown
    required?: unknown
    nodeType?: unknown
    cornerRadius?: unknown
  }
  const width = typeof d.width === 'number' && Number.isFinite(d.width) ? d.width : 0
  const height = typeof d.height === 'number' && Number.isFinite(d.height) ? d.height : 0
  const required = typeof d.required === 'number' && Number.isFinite(d.required) ? d.required : 24
  const nodeType = typeof d.nodeType === 'string' ? d.nodeType : ''
  const cornerRadius =
    typeof d.cornerRadius === 'number' && Number.isFinite(d.cornerRadius)
      ? d.cornerRadius
      : null

  const diagram = document.createElement('div')
  diagram.className = 'touch-target-diagram'

  const outer = document.createElement('span')
  outer.className = 'touch-target-shape touch-target-shape--required'

  const inner = document.createElement('span')
  inner.className = 'touch-target-shape touch-target-shape--actual'

  const shapeClass = touchTargetShapeClass(width, height, nodeType, cornerRadius)
  outer.classList.add(shapeClass)
  inner.classList.add(shapeClass)

  const innerWidth = clampVisualSize(width)
  const innerHeight = clampVisualSize(height)
  inner.style.width = `${innerWidth}px`
  inner.style.height = `${innerHeight}px`
  inner.style.marginLeft = `${-innerWidth / 2}px`
  inner.style.marginTop = `${-innerHeight / 2}px`

  outer.style.width = `${required}px`
  outer.style.height = `${required}px`
  outer.style.marginLeft = `${-required / 2}px`
  outer.style.marginTop = `${-required / 2}px`

  diagram.appendChild(outer)
  diagram.appendChild(inner)
  wrap.appendChild(diagram)

  const right = document.createElement('div')
  right.className = 'touch-target-right'
  const numerics = document.createElement('div')
  numerics.className = 'contrast-numerics'
  numerics.appendChild(buildNumericLine('current', `${formatPx(width)} × ${formatPx(height)} px`))
  numerics.appendChild(buildNumericLine('needs', `≥ ${formatPx(required)} × ${formatPx(required)} px`))
  right.appendChild(numerics)
  right.appendChild(buildSeverityDot('severe'))
  wrap.appendChild(right)

  return wrap
}

function touchTargetShapeClass(
  width: number,
  height: number,
  nodeType: string,
  cornerRadius: number | null
): string {
  if (nodeType === 'ELLIPSE') return 'touch-target-shape--round'
  const shorterSide = Math.min(width, height)
  if (cornerRadius !== null && shorterSide > 0 && cornerRadius >= shorterSide / 2) {
    return 'touch-target-shape--round'
  }
  return 'touch-target-shape--rect'
}

function clampVisualSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(72, Math.max(2, n))
}

function formatPx(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')
}

// ── 1.4.5 — short row note (full image scan happens in bottom AI section) ─

function buildImageOfTextRowVisual(_f: Finding): HTMLElement {
  const row = document.createElement('div')
  row.className = 'finding-item__visual finding-item__visual--image-of-text'
  const note = document.createElement('span')
  note.className = 'finding-item__numerics-text'
  note.textContent = 'layer name suggests text'
  row.appendChild(note)
  row.appendChild(buildSeverityDot('severe'))
  return row
}

// ── Severity dot ────────────────────────────────────────────────────

/** Section label used by the flagged header + pass / unable disclosure
 * summaries. Layout: `<count> <verb> (<icon>) in this group`, with the
 * icon wrapped in a parenthesized span so the line keeps a single rhythm
 * regardless of which icon is used. The icon mirrors the same Phosphor
 * glyph the per-card stats chip uses, so designers map between the two. */
export function buildSectionLabel(
  host: HTMLElement,
  count: number,
  verb: 'flagged' | 'passed' | 'not testable',
  icon: StatIcon
): void {
  host.appendChild(document.createTextNode(`${count} ${verb} `))
  const wrap = document.createElement('span')
  wrap.className = `section-label__icon section-label__icon--${icon}`
  wrap.appendChild(document.createTextNode('('))
  wrap.appendChild(buildIcon(icon))
  wrap.appendChild(document.createTextNode(')'))
  host.appendChild(wrap)
  host.appendChild(document.createTextNode(' in this group'))
}

export function buildSeverityDot(tier: SeverityTier): HTMLElement {
  const dot = document.createElement('span')
  dot.className = `severity-dot severity-dot--${tier}`
  dot.setAttribute('aria-hidden', 'true')
  dot.title = `severity: ${tier}`
  return dot
}

// ── Pass disclosure ─────────────────────────────────────────────────

export function buildPassDisclosure(passes: Finding[], cb: RenderCallbacks): HTMLElement {
  const details = document.createElement('details')
  details.className = 'pass-disclosure'

  const summary = document.createElement('summary')
  summary.className = 'pass-disclosure__summary'
  buildSectionLabel(summary, passes.length, 'passed', 'check')
  details.appendChild(summary)

  // Group per-element passes by criterion. Render one row per criterion:
  //   <plain-English label> — <element name>, <element name>, ...
  // Element names are clickable (jump-to-node) just like flag rows.
  const byCriterion = new Map<string, Finding[]>()
  for (const p of passes) {
    const arr = byCriterion.get(p.criterion) ?? []
    arr.push(p)
    byCriterion.set(p.criterion, arr)
  }

  const list = document.createElement('div')
  list.className = 'pass-disclosure__list'
  for (const [criterion, group] of byCriterion) {
    const row = document.createElement('div')
    row.className = 'pass-disclosure__row'

    const label = document.createElement('span')
    label.className = 'pass-disclosure__label'
    label.textContent = passLabel(criterion)
    row.appendChild(label)

    row.appendChild(document.createTextNode(' — '))

    // Dedupe by node id so an element passing the same criterion via two
    // overlapping signals (e.g. two segments of one TextNode) appears once.
    const seen = new Set<string>()
    const elements: Finding[] = []
    for (const f of group) {
      const key = f.nodeId ?? `__${f.nodeName ?? '?'}`
      if (seen.has(key)) continue
      seen.add(key)
      elements.push(f)
    }

    elements.forEach((f, i) => {
      if (i > 0) row.appendChild(document.createTextNode(', '))
      if (f.nodeId && f.nodeName) {
        row.appendChild(buildNodeLink(f.nodeId, f.nodeName, cb))
      } else {
        const span = document.createElement('span')
        span.className = 'pass-disclosure__static-name'
        span.textContent = f.nodeName ?? '—'
        row.appendChild(span)
      }
    })

    list.appendChild(row)
  }
  details.appendChild(list)

  return details
}

/**
 * Plain-English label for a passing criterion. Affirmative framing — describes
 * what was checked and passed, not what's wrong.
 */
function passLabel(criterion: string): string {
  switch (criterion) {
    case '1.4.3': return 'Text contrast'
    case '1.4.11': return 'Element contrast'
    case '1.4.5': return 'Image of text'
    case 'typography': return 'Typography'
    case 'text-reflow': return 'Text reflow'
    case '3.3.2': return 'Form label'
    case '2.4.4': return 'Link purpose'
    case '2.4.6': return 'Headings & labels'
    case '2.5.8': return 'Target size'
    case '1.4.1': return 'Use of color'
    case '2.4.7': return 'Focus visible'
    case '3.3.1': return 'Error identification'
    case '3.3.3': return 'Error suggestion'
    default: return criterion
  }
}

// ── Unable-to-test disclosure ───────────────────────────────────────
// Mirrors the pass disclosure pattern: collapsed summary "N items not testable
// in this group" + expanded list grouped by REASON. Multiple criteria can
// share a reason ("background is an image" applies to both 1.4.3 and 1.4.11)
// so reason is the right grouping key, not criterion.

export function buildUnableDisclosure(unable: Finding[], cb: RenderCallbacks): HTMLElement {
  const details = document.createElement('details')
  details.className = 'unable-disclosure'

  const summary = document.createElement('summary')
  summary.className = 'unable-disclosure__summary'
  buildSectionLabel(summary, unable.length, 'not testable', 'prohibit')
  details.appendChild(summary)

  // Bucket by human-readable reason. Capitalize first letter so the row label
  // reads as a complete phrase: "Background is an image — Card-1, Card-2".
  const byReason = new Map<string, Finding[]>()
  for (const f of unable) {
    const d = (f.details ?? {}) as { reason?: unknown; property?: unknown }
    let reason: string
    if (typeof d.reason === 'string') {
      reason = capitalize(plainEnglishReason(d.reason))
    } else if (typeof d.property === 'string') {
      reason = `${capitalize(d.property)} could not be measured`
    } else {
      reason = 'Reason unknown'
    }
    const arr = byReason.get(reason) ?? []
    arr.push(f)
    byReason.set(reason, arr)
  }

  const list = document.createElement('div')
  list.className = 'unable-disclosure__list'
  for (const [reason, group] of byReason) {
    const row = document.createElement('div')
    row.className = 'unable-disclosure__row'

    const label = document.createElement('span')
    label.className = 'unable-disclosure__label'
    label.textContent = reason
    row.appendChild(label)

    row.appendChild(document.createTextNode(' — '))

    // Dedupe by node id so repeat findings (one element flagged across two
    // segments) only appear once in the list.
    const seen = new Set<string>()
    const elements: Finding[] = []
    for (const f of group) {
      const key = f.nodeId ?? `__${f.nodeName ?? '?'}`
      if (seen.has(key)) continue
      seen.add(key)
      elements.push(f)
    }

    elements.forEach((f, i) => {
      if (i > 0) row.appendChild(document.createTextNode(', '))
      if (f.nodeId && f.nodeName) {
        row.appendChild(buildNodeLink(f.nodeId, f.nodeName, cb))
      } else {
        const span = document.createElement('span')
        span.className = 'unable-disclosure__static-name'
        span.textContent = f.nodeName ?? '—'
        row.appendChild(span)
      }
    })

    list.appendChild(row)
  }
  details.appendChild(list)

  return details
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// ── Manual bottom note (always-on bullet list) ──────────────────────
// Renders every applicable manual item as a slim italic line with a leading
// `*` marker. The set lives in src/checks/manual.ts and is currently:
//   1.3.3 — sensory characteristics
//   2.2.2 — auto-updating content
//   2.5.1 — gestures & motion actuation

export function buildManualBottomNote(items: ManualCheckItem[]): HTMLElement | null {
  const applicable = items.filter(m => m.applicable && (m.hint ?? m.name))
  if (applicable.length === 0) return null

  const wrap = document.createElement('aside')
  wrap.className = 'manual-bottom-note'

  for (const m of applicable) {
    const line = document.createElement('p')
    line.className = 'manual-bottom-note__line'

    const star = document.createElement('span')
    star.className = 'manual-bottom-note__star'
    star.setAttribute('aria-hidden', 'true')
    star.textContent = '*'
    line.appendChild(star)

    const text = document.createElement('span')
    text.className = 'manual-bottom-note__text'
    text.textContent = m.hint ?? m.name
    line.appendChild(text)

    wrap.appendChild(line)
  }

  return wrap
}

// ── Clickable element name ──────────────────────────────────────────

export function buildNodeLink(
  id: string | null,
  name: string,
  cb: RenderCallbacks
): HTMLElement {
  if (id) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'node-link'
    btn.dataset.nodeId = id
    btn.textContent = name
    btn.title = `Select "${name}" in Figma`
    btn.addEventListener('click', () => cb.onSelectNode(id))
    return btn
  }
  const span = document.createElement('span')
  span.className = 'node-link node-link--inert'
  span.textContent = name
  return span
}

// Re-export so the host can build to-verify lists for non-finding entries.
export type { ToVerifyEntry }
