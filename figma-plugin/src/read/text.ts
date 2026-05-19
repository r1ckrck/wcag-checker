// Build a TextElement DTO from a Figma TextNode.
//
// Error-handling policy: silent fallback. If a single text node can't be
// extracted (visibility off, bounding box missing, etc.) this builder returns
// `null` and the orchestrator omits it from the DTO. Per-element failures
// never surface as warnings — one broken text node shouldn't sink the audit.

import type { TextElement, TextSegment } from '../shared/dtos'
import { resolveFills } from './color.ts'
import { sampleBackground } from './background.ts'
import { toBBox } from './geometry.ts'

function lineHeightToPx(lh: LineHeight, fontSize: number): { unit: TextSegment['lineHeightUnit']; px: number | null } {
  if (lh.unit === 'AUTO') return { unit: 'AUTO', px: null }
  if (lh.unit === 'PIXELS') return { unit: 'PIXELS', px: lh.value }
  return { unit: 'PERCENT', px: (lh.value / 100) * fontSize }
}

function letterSpacingToPx(ls: LetterSpacing, fontSize: number): number {
  if (ls.unit === 'PIXELS') return ls.value
  return (ls.value / 100) * fontSize
}

function fontWeightFromStyle(style: string): number {
  // FontName.style is a string like "Regular", "Bold", "Bold Italic". We make a
  // best-effort numeric mapping for the WCAG bold-text threshold rule.
  const lc = style.toLowerCase()
  if (lc.includes('thin') || lc.includes('hairline')) return 100
  if (lc.includes('extralight') || lc.includes('ultralight')) return 200
  if (lc.includes('light')) return 300
  if (lc.includes('semibold') || lc.includes('demibold')) return 600
  if (lc.includes('extrabold') || lc.includes('ultrabold')) return 800
  if (lc.includes('black') || lc.includes('heavy')) return 900
  if (lc.includes('bold')) return 700
  if (lc.includes('medium')) return 500
  return 400
}

function parentChainIds(node: SceneNode): string[] {
  const ids: string[] = []
  let p: BaseNode | null = node.parent
  while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') {
    ids.unshift(p.id)
    p = p.parent
  }
  return ids
}

export async function buildTextElement(
  node: TextNode,
  rootFallback?: SceneNode
): Promise<TextElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null

  const rawSegments = node.getStyledTextSegments([
    'fontSize',
    'fontName',
    'fontWeight',
    'fills',
    'lineHeight',
    'letterSpacing',
    'textCase',
    'textDecoration',
  ])

  const segments: TextSegment[] = []
  for (const s of rawSegments) {
    const fill = await resolveFills(s.fills, node)
    const lh = lineHeightToPx(s.lineHeight, s.fontSize)
    segments.push({
      start: s.start,
      end: s.end,
      fontFamily: s.fontName.family,
      fontStyle: s.fontName.style,
      fontWeight: typeof s.fontWeight === 'number' ? s.fontWeight : fontWeightFromStyle(s.fontName.style),
      fontSize: s.fontSize,
      lineHeightUnit: lh.unit,
      lineHeightPx: lh.px,
      letterSpacingPx: letterSpacingToPx(s.letterSpacing, s.fontSize),
      textCase: s.textCase,
      textDecoration: s.textDecoration,
      fill,
    })
  }

  const background = await sampleBackground(node, { rootFallback })
  const bbox = toBBox(node.absoluteBoundingBox)

  // Figma exposes paragraphSpacing on the TextNode (not on style segments).
  // It's a plain number; `figma.mixed` happens only when the node is being
  // edited mid-flush, which won't occur during an audit. Guard defensively.
  const rawParagraphSpacing = (node as TextNode).paragraphSpacing
  const paragraphSpacingPx =
    typeof rawParagraphSpacing === 'number' ? rawParagraphSpacing : null

  return {
    kind: 'text',
    id: node.id,
    name: node.name,
    characters: node.characters.slice(0, 60),
    textAutoResize: node.textAutoResize,
    isSingleLine: !node.characters.includes('\n'),
    isSingleVisualLine: detectSingleVisualLine(bbox.height, segments),
    paragraphSpacingPx,
    segments,
    background,
    bbox,
    parentChain: parentChainIds(node),
  }
}

/**
 * Geometric "actually one rendered line" check. Compares the text node's
 * rendered height against the dominant segment's effective line-height —
 * if the bbox is roughly within one line-height tall, the text fits on one
 * visual line regardless of whether the string contains hard breaks.
 *
 * AUTO line-height has no fixed pixel value, so we use a conservative 1.2×
 * fontSize fallback (Figma's typical AUTO range is 1.1×–1.3× depending on
 * the font's metrics).
 */
function detectSingleVisualLine(bboxHeight: number, segments: TextSegment[]): boolean {
  if (segments.length === 0 || bboxHeight <= 0) return false
  // Use the segment with the largest effective line-height as the reference,
  // so a giant header line in a mixed run doesn't get falsely classified as
  // multi-line.
  let maxLineHeight = 0
  for (const s of segments) {
    const lh = s.lineHeightPx ?? s.fontSize * 1.2
    if (lh > maxLineHeight) maxLineHeight = lh
  }
  if (maxLineHeight <= 0) return false
  // 1.5× tolerance accommodates font metrics, descender padding, and rounding.
  return bboxHeight <= maxLineHeight * 1.5
}
