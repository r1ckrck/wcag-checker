// 1.4.3 Contrast (Min) and 1.4.11 Non-Text Contrast.
// Pure consumer of AuditDTO + checkContrast.

import type {
  AuditDTO,
  BackgroundSample,
  ColorSource,
  RGBA,
  ResolvedFill,
  TextElement,
  TextSegment,
  NonTextContrastElement,
} from '../../shared/dtos'
import type { Finding } from '../findings.ts'
import { checkContrast, type RGB } from '../contrast.ts'

const NORMAL_TEXT_THRESHOLD = 4.5
const LARGE_TEXT_THRESHOLD = 3
const NON_TEXT_THRESHOLD = 3

function thresholdFor(segment: TextSegment): number {
  if (segment.fontSize >= 24) return LARGE_TEXT_THRESHOLD
  if (segment.fontSize >= 18.67 && segment.fontWeight >= 700) return LARGE_TEXT_THRESHOLD
  return NORMAL_TEXT_THRESHOLD
}

function fillUnresolvableReason(fill: ResolvedFill | null): string | null {
  if (!fill || fill.source.kind !== 'unresolvable') return null
  return fill.source.reason
}

function bgRGB(bg: BackgroundSample): RGB | null {
  if (bg.kind !== 'solid') return null
  return [bg.rgba[0], bg.rgba[1], bg.rgba[2]]
}

function bgUnresolvableReason(bg: BackgroundSample): string | null {
  return bg.kind === 'unresolvable' ? bg.reason : null
}

function fmtRatio(r: number): string {
  return r.toFixed(2)
}

function truncateSnippet(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

export function runContrastCheck(dto: AuditDTO): Finding[] {
  const findings: Finding[] = []

  for (const text of dto.texts) {
    findings.push(...auditTextContrast(text))
  }
  for (const it of dto.nonTextContrast) {
    findings.push(auditInteractiveContrast(it))
  }

  return findings
}

function auditTextContrast(text: TextElement): Finding[] {
  const out: Finding[] = []
  const bgReason = bgUnresolvableReason(text.background)
  if (bgReason) {
    out.push({
      criterion: '1.4.3',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: `Unable to test — background ${bgReason}.`,
      details: { reason: bgReason },
    })
    return out
  }
  const bg = bgRGB(text.background)
  if (!bg) {
    out.push({
      criterion: '1.4.3',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: 'Unable to test — no resolved background color.',
    })
    return out
  }

  let worst: { ratio: number; threshold: number; segment: TextSegment } | null = null
  let segmentResolveFailures: string[] = []
  let segmentsTested = 0

  for (const seg of text.segments) {
    const reason = fillUnresolvableReason(seg.fill)
    if (reason) {
      segmentResolveFailures.push(reason)
      continue
    }
    if (!seg.fill.rgba) {
      segmentResolveFailures.push('no-rgba')
      continue
    }
    segmentsTested++
    const threshold = thresholdFor(seg)
    const result = checkContrast({
      fg: seg.fill.rgba as RGBA,
      bg: bg as RGB,
      threshold,
    })
    if (!result.pass) {
      if (!worst || result.ratio < worst.ratio) {
        worst = { ratio: result.ratio, threshold, segment: seg }
      }
    }
  }

  if (segmentsTested === 0) {
    const r = segmentResolveFailures[0] ?? 'unknown'
    out.push({
      criterion: '1.4.3',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: `Unable to test — text fill ${r}.`,
      details: { reason: r },
    })
    return out
  }

  if (worst) {
    const fgHex = worst.segment.fill.hex ?? '?'
    const bgHex = text.background.kind === 'solid' ? text.background.hex : '?'
    const snippet = text.characters
      .slice(worst.segment.start, worst.segment.end)
      .trim()
    const snippetPart = snippet.length > 0 ? ` "${truncateSnippet(snippet, 40)}"` : ''
    out.push({
      criterion: '1.4.3',
      status: 'flag',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: `Contrast ${fmtRatio(worst.ratio)}:1 — needs ≥${worst.threshold}:1 (${fgHex} on ${bgHex},${snippetPart} ${worst.segment.fontSize}px/${worst.segment.fontWeight}).`,
      details: {
        actual: worst.ratio,
        required: worst.threshold,
        fontSize: worst.segment.fontSize,
        fontWeight: worst.segment.fontWeight,
        segmentRange: [worst.segment.start, worst.segment.end],
        fgHex,
        bgHex,
        snippet,
      },
    })
  } else {
    out.push({
      criterion: '1.4.3',
      status: 'pass',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: '1.4.3 — text contrast meets minimum.',
    })
  }
  return out
}

/**
 * Choose the foreground we'll measure for an interactive element. Stroke wins
 * over fill, but only when the stroke actually carries a usable color. A
 * stroke that's present-but-unresolvable (rgba=null, source=unresolvable) is
 * skipped so we fall through to the fill. A zero-alpha probe (paint with
 * opacity 0, or a fully-transparent stack) is also skipped — it paints
 * nothing on the canvas, so it shouldn't influence the audit math.
 */
function pickProbe(it: NonTextContrastElement): ResolvedFill | null {
  if (isUsableProbe(it.stroke)) return it.stroke
  if (isUsableProbe(it.fill)) return it.fill
  return null
}

function isUsableProbe(probe: ResolvedFill | null): probe is ResolvedFill {
  if (!probe || probe.rgba === null) return false
  if (probe.source.kind === 'unresolvable') return false
  // rgba is [r, g, b, alpha]; alpha 0 means the paint is fully transparent
  // and contributes nothing visually. Defensive guard for any path that
  // produced a zero-alpha probe despite the read-pipeline filters.
  if (probe.rgba[3] === 0) return false
  return true
}

function describeColorSource(s: ColorSource): string {
  switch (s.kind) {
    case 'raw': return 'raw'
    case 'style': return `style "${s.styleName}"`
    case 'variable': return `variable "${s.variableName}" (${s.modeName})`
    case 'unresolvable': return s.reason
  }
}

function auditInteractiveContrast(it: NonTextContrastElement): Finding {
  const bgReason = bgUnresolvableReason(it.background)
  if (bgReason) {
    return {
      criterion: '1.4.11',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: it.id,
      nodeName: it.name,
      message: `Unable to test — background ${bgReason}.`,
      details: { reason: bgReason },
    }
  }
  const bg = bgRGB(it.background)
  if (!bg) {
    return {
      criterion: '1.4.11',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: it.id,
      nodeName: it.name,
      message: 'Unable to test — no resolved background color.',
    }
  }
  // Bug 1 fix — stroke takes precedence over fill ONLY when the stroke is
  // actually usable. Vectors imported from SVG often have an invisible-but-
  // present stroke definition (a `strokes` array with `visible: false` paints)
  // which the read pipeline correctly captures as a ResolvedFill with
  // rgba: null. The old `stroke ?? fill` pattern picked that unusable stroke
  // and bailed to "unable to test" even when a perfectly good fill existed.
  const probe = pickProbe(it)
  if (!probe) {
    return {
      criterion: '1.4.11',
      status: 'unable-to-test',
      scope: 'element',
      nodeId: it.id,
      nodeName: it.name,
      message: 'Unable to determine element color — verify ≥3:1 manually.',
    }
  }
  const result = checkContrast({
    fg: probe.rgba as RGBA,
    bg: bg as RGB,
    threshold: NON_TEXT_THRESHOLD,
  })
  if (!result.pass) {
    return {
      criterion: '1.4.11',
      status: 'flag',
      scope: 'element',
      nodeId: it.id,
      nodeName: it.name,
      message: `Contrast ${fmtRatio(result.ratio)}:1 — needs ≥${NON_TEXT_THRESHOLD}:1 (${describeColorSource(probe.source)}).`,
      details: { actual: result.ratio, required: NON_TEXT_THRESHOLD },
    }
  }
  return {
    criterion: '1.4.11',
    status: 'pass',
    scope: 'element',
    nodeId: it.id,
    nodeName: it.name,
    message: '1.4.11 — non-text contrast meets minimum.',
  }
}
