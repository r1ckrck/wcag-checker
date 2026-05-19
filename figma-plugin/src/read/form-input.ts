// Identify form inputs by main-component name regex; collect child text nodes
// and detect external labels.
//
// Error-handling policy: silent fallback. Returns `null` for any non-input
// instance, geometry-failure case, or main-component lookup failure. Per-
// element failures don't surface as warnings — the input simply doesn't appear
// in the DTO and 3.3.2 won't complain about it.

import type { BBox, FormInputChildText, FormInputElement } from '../shared/dtos'
import { boxContains, toBBox } from './geometry.ts'
import { isFormInputName } from './regex.ts'
import { shapeMeta } from './shape.ts'

async function getMainComponentName(instance: InstanceNode): Promise<string | null> {
  try {
    const main = await instance.getMainComponentAsync()
    if (!main) return null
    // Variants live inside a ComponentSet — its name is what designers usually
    // think of as the component's name.
    if (main.parent && main.parent.type === 'COMPONENT_SET') {
      return main.parent.name
    }
    return main.name
  } catch {
    return null
  }
}

// Bug 9 — Aspect-ratio guard. Real text-entry fields are wider than they are
// tall: search bars, single-line inputs, multi-line text areas. Chips, cards,
// and selection radios are squarish or tall — those should NOT be treated as
// form inputs even if their main component name passes the regex.
const MIN_INPUT_ASPECT_RATIO = 2.0

// Bug 9 — Child-count guard. Text-entry fields typically have at most a few
// child texts (label + placeholder + helper). Selection cards like
// `input/product_variant` carry many child texts (title, value, tenure,
// description) — those are not form inputs.
const MAX_INPUT_CHILD_TEXTS = 4

// Detect labels nested inside a form-input component. Common patterns:
//   - text node named "Title" / "Label" / "Caption"
//   - text inside a frame named "title container", "label-wrapper", etc.
// Word-boundary matching avoids false positives on names like "Subtitle"
// (which contains "title" but not as a whole word).
const LABEL_NAME_RE = /\b(title|label|caption)\b/i

function hasLabelishContext(text: TextNode, inputRoot: SceneNode): boolean {
  if (LABEL_NAME_RE.test(text.name)) return true
  let p: BaseNode | null = text.parent
  while (p && p.id !== inputRoot.id && p.type !== 'PAGE' && p.type !== 'DOCUMENT') {
    if (LABEL_NAME_RE.test(p.name)) return true
    p = p.parent
  }
  return false
}

// Inner-input-box detection. A real text-entry field has a drawn surface — a
// frame/rect with a fill or visible stroke — that bounds the entry zone.
// Labels and helper text sit outside that surface but inside the form-input
// wrapper. Finding it lets us classify each child text as "inside the entry
// zone" (placeholder/value) vs "outside" (label/helper) by geometry alone,
// without depending on layer naming.
const INNER_BOX_MIN_WIDTH_RATIO = 0.6
const INNER_BOX_MIN_HEIGHT_PX = 16

function hasVisibleSurface(n: SceneNode): boolean {
  if ('fills' in n) {
    const fills = (n as { fills: ReadonlyArray<Paint> | typeof figma.mixed }).fills
    if (Array.isArray(fills) && fills.some(p => p.visible !== false && (p.opacity ?? 1) > 0)) {
      return true
    }
  }
  if ('strokes' in n && 'strokeWeight' in n) {
    const sw = (n as { strokeWeight: number | typeof figma.mixed }).strokeWeight
    if (sw !== figma.mixed && sw > 0) {
      const strokes = (n as { strokes: ReadonlyArray<Paint> }).strokes
      if (Array.isArray(strokes) && strokes.some(p => p.visible !== false && (p.opacity ?? 1) > 0)) {
        return true
      }
    }
  }
  return false
}

function findInnerInputBox(root: SceneNode, rootBox: BBox): BBox | null {
  if (!('findAllWithCriteria' in root)) return null
  const candidates = (root as FrameNode).findAllWithCriteria({
    types: ['FRAME', 'RECTANGLE', 'COMPONENT', 'INSTANCE'],
  })
  let best: { box: BBox; area: number } | null = null
  for (const c of candidates) {
    if (c.id === root.id) continue
    if (c.visible === false) continue
    if (!c.absoluteBoundingBox) continue
    const cb = toBBox(c.absoluteBoundingBox)
    if (!boxContains(rootBox, cb)) continue
    // Don't accept the root itself even via type-coercion edge cases.
    if (cb.width >= rootBox.width && cb.height >= rootBox.height) continue
    if (cb.width < rootBox.width * INNER_BOX_MIN_WIDTH_RATIO) continue
    if (cb.height < INNER_BOX_MIN_HEIGHT_PX) continue
    if (!hasVisibleSurface(c)) continue
    const area = cb.width * cb.height
    if (!best || area > best.area) best = { box: cb, area }
  }
  return best ? best.box : null
}

export async function buildFormInputElement(
  node: InstanceNode
): Promise<FormInputElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null
  const mainName = await getMainComponentName(node)
  if (!mainName || !isFormInputName(mainName)) return null

  const inputBox = toBBox(node.absoluteBoundingBox)
  const shape = shapeMeta(node)

  // Bug 9 — aspect-ratio guard. Drop chips and cards before doing the more
  // expensive descendant traversal.
  if (inputBox.height === 0) return null
  const aspectRatio = inputBox.width / inputBox.height
  if (aspectRatio < MIN_INPUT_ASPECT_RATIO) return null

  // Find the actual entry zone — a drawn inner box (frame/rect with a fill
  // or visible stroke). When present, classify texts against THAT box rather
  // than the form-input wrapper: a text outside the entry zone but inside the
  // wrapper is then naturally identifiable as a label or helper.
  const innerBox = findInnerInputBox(node, inputBox)
  const placeholderZone = innerBox ?? inputBox

  // Collect all visible TEXT descendants — classify by bbox containment.
  const texts = node.findAllWithCriteria({ types: ['TEXT'] })
  const childTextNodes: FormInputChildText[] = []
  for (const t of texts) {
    if (t.visible === false) continue
    if (!t.absoluteBoundingBox) continue
    const tb = toBBox(t.absoluteBoundingBox)
    childTextNodes.push({
      id: t.id,
      text: t.characters.slice(0, 60),
      isInsideInput: boxContains(placeholderZone, tb),
      isLabel: hasLabelishContext(t, node),
    })
  }

  // Bug 9 — child-count guard. Selection cards present many texts at once;
  // text-entry fields are leaner.
  if (childTextNodes.length > MAX_INPUT_CHILD_TEXTS) return null

  // External label: a TEXT sibling in the parent whose bbox is positioned above
  // or to the left of the input AND not contained inside the input.
  let hasExternalLabel = false
  const parent = node.parent
  if (parent && 'children' in parent) {
    for (const sibling of parent.children) {
      if (sibling.id === node.id) continue
      if (sibling.type !== 'TEXT') continue
      if (sibling.visible === false) continue
      if (!sibling.absoluteBoundingBox) continue
      const sb = toBBox(sibling.absoluteBoundingBox)
      const above = sb.y + sb.height <= inputBox.y
      const leftOf = sb.x + sb.width <= inputBox.x
      if (above || leftOf) {
        hasExternalLabel = true
        break
      }
    }
  }

  return {
    kind: 'form-input',
    id: node.id,
    name: node.name,
    nodeType: shape.nodeType,
    cornerRadius: shape.cornerRadius,
    mainComponentName: mainName,
    childTextNodes,
    hasExternalLabel,
    bbox: inputBox,
  }
}

export async function buildFormInputElements(
  instances: InstanceNode[]
): Promise<FormInputElement[]> {
  const out = await Promise.all(instances.map(buildFormInputElement))
  return out.filter((e): e is FormInputElement => e !== null)
}
