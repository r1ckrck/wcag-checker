// Pure markdown formatter for the debug button. Takes the same DTO + findings
// the UI already renders and produces a single string that the user can paste
// into chat for diagnosis. No DOM, no figma globals — easy to unit-test.

import type { AuditDTO, ColorSource, ResolvedFill, BackgroundSample } from '../shared/dtos'
import type { FindingsReport, Finding } from '../checks/findings.ts'

export interface DebugReportMeta {
  pluginVersion: string
  generatedAt: string  // ISO string
}

export function formatDebugReport(
  dto: AuditDTO,
  findings: FindingsReport,
  meta: DebugReportMeta
): string {
  const sections: string[] = [
    section_header(dto, meta),
    section_summary(findings),
    section_findings('Flags', findings.flags),
    section_findings('Unable to test', findings.unableToTest),
    section_findings('Passed', findings.passes),
    section_textsTrace(dto),
    section_nonTextContrastTrace(dto),
    section_imagesTrace(dto),
    section_formInputsTrace(dto),
    section_variantsTrace(dto),
    section_manualChecks(findings),
    section_warnings(dto, findings),
    section_rawJson('AuditDTO', dto),
    section_rawJson('FindingsReport', findings),
  ]
  return sections.join('\n\n').trimEnd() + '\n'
}

// ── Section builders ────────────────────────────────────────────────

function section_header(dto: AuditDTO, meta: DebugReportMeta): string {
  const c = dto.component
  return [
    `# Maanak — Accessibility Checker · debug — ${meta.generatedAt}`,
    `Plugin v${meta.pluginVersion} · Component: ${c.name} (${c.type}) · ${c.id} · ${c.width}×${c.height} · page "${c.pageName}"${c.modeName ? ` · mode "${c.modeName}"` : ''}`,
  ].join('\n')
}

function section_summary(f: FindingsReport): string {
  return [
    `## Summary`,
    `- ${f.passes.length} passed · ${f.flags.length} flagged · ${f.unableToTest.length} unable`,
    `- ${f.warnings.length} warning${f.warnings.length === 1 ? '' : 's'}`,
    `- ${f.manual.filter(m => m.applicable).length} applicable manual check${f.manual.filter(m => m.applicable).length === 1 ? '' : 's'}`,
  ].join('\n')
}

function section_findings(title: string, items: Finding[]): string {
  const lines: string[] = [`## ${title} (${items.length})`]
  if (items.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const f of items) {
    const node = f.nodeName ? `"${escapeInline(f.nodeName)}"` : '—'
    const id = f.nodeId ? ` · ${f.nodeId}` : ''
    lines.push(``)
    lines.push(`### ${f.criterion} — ${node}${id}`)
    lines.push(`- status: ${f.status}`)
    lines.push(`- scope: ${f.scope}`)
    lines.push(`- message: ${escapeInline(f.message)}`)
    if (f.details && Object.keys(f.details).length > 0) {
      lines.push(`- details:`)
      for (const [k, v] of Object.entries(f.details)) {
        lines.push(`  - ${k}: ${formatValue(v)}`)
      }
    }
  }
  return lines.join('\n')
}

function section_textsTrace(dto: AuditDTO): string {
  const lines: string[] = [`## Read trace — Texts (${dto.texts.length})`]
  if (dto.texts.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const t of dto.texts) {
    lines.push(``)
    lines.push(`### "${escapeInline(t.name)}" · ${t.id}`)
    lines.push(`- characters: ${JSON.stringify(t.characters)}`)
    lines.push(`- isSingleLine: ${t.isSingleLine}`)
    lines.push(`- bbox: ${formatBbox(t.bbox)}`)
    lines.push(`- background: ${formatBackground(t.background)}`)
    lines.push(`- segments: ${t.segments.length}`)
    for (let i = 0; i < t.segments.length; i++) {
      const s = t.segments[i]
      lines.push(`  - [${i}] ${s.start}–${s.end} · ${s.fontFamily} ${s.fontStyle} ${s.fontWeight} · ${s.fontSize}px`)
      lines.push(`    - lineHeight: ${s.lineHeightUnit}${s.lineHeightPx === null ? '' : ` ${s.lineHeightPx}px`}`)
      lines.push(`    - letterSpacing: ${s.letterSpacingPx}px`)
      lines.push(`    - textCase: ${s.textCase} · textDecoration: ${s.textDecoration}`)
      lines.push(`    - fill: ${formatFill(s.fill)}`)
    }
  }
  return lines.join('\n')
}

function section_nonTextContrastTrace(dto: AuditDTO): string {
  const lines: string[] = [`## Read trace — Non-text contrast (${dto.nonTextContrast.length})`]
  if (dto.nonTextContrast.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const it of dto.nonTextContrast) {
    lines.push(``)
    lines.push(`### "${escapeInline(it.name)}" · ${it.id} · ${it.nodeType}`)
    lines.push(`- isIconOnly: ${it.isIconOnly}`)
    lines.push(`- bbox: ${formatBbox(it.bbox)}`)
    lines.push(`- fill: ${it.fill ? formatFill(it.fill) : '(null)'}`)
    lines.push(`- stroke: ${it.stroke ? formatFill(it.stroke) : '(none)'}`)
    lines.push(`- strokeWeight: ${it.strokeWeight ?? '(none)'}`)
    lines.push(`- background: ${formatBackground(it.background)}`)
  }
  return lines.join('\n')
}

function section_imagesTrace(dto: AuditDTO): string {
  const lines: string[] = [`## Read trace — Images (${dto.images.length})`]
  if (dto.images.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const img of dto.images) {
    lines.push(`- "${escapeInline(img.name)}" · ${img.id} · ${img.width}×${img.height} · isExempt=${img.isExempt}`)
  }
  return lines.join('\n')
}

function section_formInputsTrace(dto: AuditDTO): string {
  const lines: string[] = [`## Read trace — Form inputs (${dto.formInputs.length})`]
  if (dto.formInputs.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const f of dto.formInputs) {
    lines.push(``)
    lines.push(`### "${escapeInline(f.name)}" · ${f.id}`)
    lines.push(`- mainComponent: ${escapeInline(f.mainComponentName)}`)
    lines.push(`- hasExternalLabel: ${f.hasExternalLabel}`)
    lines.push(`- bbox: ${formatBbox(f.bbox)}`)
    lines.push(`- childTextNodes: ${f.childTextNodes.length}`)
    for (const c of f.childTextNodes) {
      lines.push(`  - "${escapeInline(c.text)}" · ${c.id} · isInsideInput=${c.isInsideInput} · isLabel=${c.isLabel}`)
    }
  }
  return lines.join('\n')
}

function section_variantsTrace(dto: AuditDTO): string {
  const lines: string[] = [`## Read trace — Variants`]
  const v = dto.variants
  if (!v) {
    lines.push('(no component set / no variants)')
    return lines.join('\n')
  }
  lines.push(`- componentSet: "${escapeInline(v.componentSetName)}" · ${v.componentSetId}`)
  lines.push(`- defaultVariantId: ${v.defaultVariantId}`)
  lines.push(`- focusVariantId: ${v.focusVariantId ?? '(none)'}`)
  lines.push(`- errorVariantId: ${v.errorVariantId ?? '(none)'}`)
  lines.push(`- otherVariantNames: ${v.otherVariantNames.length === 0 ? '(none)' : v.otherVariantNames.map(n => `"${escapeInline(n)}"`).join(', ')}`)
  lines.push(`- variants (${v.variants.length}):`)
  for (const variant of v.variants) {
    const props = Object.entries(variant.properties).map(([k, val]) => `${k}=${val}`).join(', ')
    lines.push(`  - "${escapeInline(variant.name)}" · ${variant.id}${props ? ` · ${props}` : ''}`)
  }
  return lines.join('\n')
}

function section_manualChecks(f: FindingsReport): string {
  const lines: string[] = [`## Manual checks`]
  for (const m of f.manual) {
    const flag = m.applicable ? '[x]' : '[ ]'
    lines.push(`- ${flag} ${m.criterion} ${m.name}${m.hint ? ` — ${m.hint}` : ''}`)
  }
  return lines.join('\n')
}

function section_warnings(dto: AuditDTO, f: FindingsReport): string {
  const all = [...new Set([...dto.warnings, ...f.warnings])]
  const lines: string[] = [`## Warnings (${all.length})`]
  if (all.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const w of all) {
    lines.push(`- ${escapeInline(w)}`)
  }
  return lines.join('\n')
}

function section_rawJson(label: string, value: unknown): string {
  // Use a four-backtick fence so embedded triple-backticks (rare but possible
  // in user-supplied node names) can't break out of the code block.
  return [
    `## Raw ${label}`,
    '````json',
    JSON.stringify(value, null, 2),
    '````',
  ].join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatFill(fill: ResolvedFill): string {
  const hex = fill.hex ?? '(no hex)'
  const rgba = fill.rgba
    ? `rgba(${roundN(fill.rgba[0])},${roundN(fill.rgba[1])},${roundN(fill.rgba[2])},${fill.rgba[3]})`
    : '(no rgba)'
  return `${hex} · ${rgba} · source=${formatColorSource(fill.source)}`
}

function formatBackground(bg: BackgroundSample): string {
  if (bg.kind === 'solid') {
    return `solid ${bg.hex} · ancestor=${bg.ancestorId} · source=${formatColorSource(bg.source)}`
  }
  return `unresolvable (${bg.reason})`
}

function formatColorSource(s: ColorSource): string {
  switch (s.kind) {
    case 'raw':
      return 'raw'
    case 'style':
      return `style "${escapeInline(s.styleName)}" (${s.styleId})`
    case 'variable':
      return `variable "${escapeInline(s.variableName)}" mode "${escapeInline(s.modeName)}" (collection "${escapeInline(s.collectionName)}")`
    case 'unresolvable':
      return `unresolvable (${s.reason})`
  }
}

function formatBbox(b: { x: number; y: number; width: number; height: number }): string {
  return `x=${roundN(b.x)} y=${roundN(b.y)} w=${roundN(b.width)} h=${roundN(b.height)}`
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function roundN(n: number, places = 2): number {
  const factor = Math.pow(10, places)
  return Math.round(n * factor) / factor
}

// Replace characters that would break inline markdown lists. Keep it minimal —
// we only need to neutralize backticks and pipes; other markdown is fine inside
// a list item.
function escapeInline(s: string): string {
  return s.replace(/`/g, 'ˋ').replace(/\|/g, 'ǀ')
}
