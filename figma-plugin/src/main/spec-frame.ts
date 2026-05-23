// Draws the Accessibility Spec frame onto the canvas. Main-thread glue —
// figma.* node creation; not unit-tested (manual QA). The data is a pure
// SpecModel built by src/checks/metadata-model.ts; this only renders it.
//
// Option C: every call creates a NEW frame. Nothing existing is read or
// mutated except counting same-named frames for the cascade offset.

import type { SpecModel, SpecElement, SpecFieldValue } from '../checks/metadata-model.ts'

// Plain neutral spec-sheet palette — independent of the plugin UI tokens.
const C = {
  bg: { r: 1, g: 1, b: 1 },
  title: hex(0x111827),
  section: hex(0x6b7280),
  label: hex(0x6b7280),
  value: hex(0x1f2937),
  muted: hex(0x9ca3af),
  rule: hex(0xe5e7eb),
}

function hex(n: number): RGB {
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

const INTER = {
  regular: { family: 'Inter', style: 'Regular' },
  medium: { family: 'Inter', style: 'Medium' },
  semibold: { family: 'Inter', style: 'Semi Bold' },
  italic: { family: 'Inter', style: 'Italic' },
} as const

async function loadFonts(): Promise<void> {
  try {
    await Promise.all([
      figma.loadFontAsync(INTER.regular),
      figma.loadFontAsync(INTER.medium),
      figma.loadFontAsync(INTER.semibold),
      figma.loadFontAsync(INTER.italic),
    ])
  } catch {
    throw new Error('Inter font unavailable — cannot render the metadata frame.')
  }
}

function solid(color: RGB): SolidPaint {
  return { type: 'SOLID', color }
}

function text(
  chars: string,
  font: FontName,
  size: number,
  color: RGB,
  opts: { upper?: boolean } = {}
): TextNode {
  const t = figma.createText()
  t.fontName = font
  t.fontSize = size
  t.characters = chars
  t.fills = [solid(color)]
  if (opts.upper) {
    t.textCase = 'UPPER'
    t.letterSpacing = { unit: 'PERCENT', value: 6 }
  }
  t.textAutoResize = 'HEIGHT'
  t.layoutAlign = 'STRETCH'
  return t
}

function column(spacing: number): FrameNode {
  const f = figma.createFrame()
  f.layoutMode = 'VERTICAL'
  f.primaryAxisSizingMode = 'AUTO'
  f.counterAxisSizingMode = 'FIXED'
  f.itemSpacing = spacing
  f.fills = []
  f.layoutAlign = 'STRETCH'
  return f
}

function divider(): RectangleNode {
  const r = figma.createRectangle()
  r.resize(100, 1)
  r.fills = [solid(C.rule)]
  r.layoutAlign = 'STRETCH'
  return r
}

function fieldValueNode(v: SpecFieldValue): TextNode {
  if (v.kind === 'value') return text(v.text, INTER.regular, 14, C.value)
  // slot | ai-image (unfilled) — both carry a placeholder string.
  return text(v.placeholder, INTER.italic, 14, C.muted)
}

function elementCard(el: SpecElement): FrameNode {
  const card = column(8)

  const heading = figma.createFrame()
  heading.layoutMode = 'HORIZONTAL'
  heading.primaryAxisSizingMode = 'AUTO'
  heading.counterAxisSizingMode = 'AUTO'
  heading.itemSpacing = 6
  heading.fills = []
  heading.layoutAlign = 'STRETCH'
  const name = text(el.ref, INTER.medium, 14, C.title)
  name.layoutAlign = 'INHERIT'
  name.textAutoResize = 'WIDTH_AND_HEIGHT'
  const kind = text(`(${el.kind})`, INTER.medium, 14, C.muted)
  kind.layoutAlign = 'INHERIT'
  kind.textAutoResize = 'WIDTH_AND_HEIGHT'
  heading.appendChild(name)
  heading.appendChild(kind)
  card.appendChild(heading)

  for (const f of el.fields) {
    const row = column(2)
    row.itemSpacing = 2
    row.appendChild(text(f.label, INTER.medium, 12, C.label))
    row.appendChild(fieldValueNode(f.value))
    card.appendChild(row)
  }
  return card
}

/**
 * Build and place a new `<Component> — Metadata` frame beside `node`.
 * Throws on font-load or any write failure (e.g. Dev Mode read-only) — the
 * caller maps the thrown message to a `metadata-error`.
 */
export async function drawSpecFrame(model: SpecModel, node: SceneNode): Promise<void> {
  await loadFonts()

  const WIDTH = 560
  const frame = figma.createFrame()
  frame.name = `${model.componentName} — Metadata`
  frame.layoutMode = 'VERTICAL'
  frame.counterAxisSizingMode = 'FIXED'
  frame.primaryAxisSizingMode = 'AUTO'
  frame.resize(WIDTH, 100)
  frame.paddingLeft = frame.paddingRight = frame.paddingTop = frame.paddingBottom = 32
  frame.itemSpacing = 24
  frame.fills = [solid(C.bg)]

  // Title
  frame.appendChild(text(`${model.componentName} — Metadata`, INTER.semibold, 20, C.title))

  // Reading / focus order
  const focusSection = column(8)
  focusSection.appendChild(
    text('Reading / focus order', INTER.semibold, 12, C.section, { upper: true })
  )
  const orderText =
    model.focusOrder.length > 0
      ? model.focusOrder.map((ref, i) => `${i + 1}. ${ref}`).join('\n')
      : '⟨ no focusable elements detected ⟩'
  focusSection.appendChild(
    model.focusOrder.length > 0
      ? text(orderText, INTER.regular, 14, C.value)
      : text(orderText, INTER.italic, 14, C.muted)
  )
  frame.appendChild(focusSection)

  // Elements
  const elementsSection = column(16)
  elementsSection.appendChild(
    text('Elements', INTER.semibold, 12, C.section, { upper: true })
  )
  model.elements.forEach((el, i) => {
    if (i > 0) elementsSection.appendChild(divider())
    elementsSection.appendChild(elementCard(el))
  })
  if (model.elements.length === 0) {
    elementsSection.appendChild(text('⟨ no elements detected ⟩', INTER.italic, 14, C.muted))
  }
  frame.appendChild(elementsSection)

  // Placement: right of the component + 80px gap, cascading +40·n for repeats.
  const box =
    node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height }
  const sameName = figma.currentPage.children.filter(c => c.name === frame.name).length - 1
  const n = sameName < 0 ? 0 : sameName
  frame.x = box.x + box.width + 80 + n * 40
  frame.y = box.y + n * 40

  figma.currentPage.appendChild(frame)
  figma.currentPage.selection = [frame]
}
