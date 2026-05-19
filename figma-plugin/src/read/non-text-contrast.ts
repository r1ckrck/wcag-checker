// Build a NonTextContrastElement DTO from a vector / boolean-op / icon-instance.
// These are the drawn, non-text targets SC 1.4.11 cares about — NOT clickables
// (those live in interactivity.ts as ClickableElement).
//
// Error-handling policy: silent fallback. Per-element extraction returns
// `null` on any failure (invisible node, missing bbox, swap target gone) and
// the orchestrator omits the element from the DTO. Per-element failures never
// surface as warnings — one broken icon shouldn't sink the audit.

import type { NonTextContrastElement, ResolvedFill } from '../shared/dtos'
import { resolveNodeFills, resolveFills } from './color.ts'
import { sampleBackground } from './background.ts'
import { isFormInputName } from './regex.ts'
import { toBBox } from './geometry.ts'
import type { ShapeNode } from './traverse.ts'

/** Drawn-shape node types that contribute to 1.4.11 alongside vectors and
 * icon-instances. Mirrored from `ShapeNode` in traverse.ts. */
const SHAPE_NODE_TYPES = new Set<string>([
  'RECTANGLE',
  'ELLIPSE',
  'POLYGON',
  'STAR',
  'LINE',
])

type StrokeBearing = SceneNode & {
  strokes: ReadonlyArray<Paint>
  strokeWeight: number | typeof figma.mixed
}

function hasStrokes(n: SceneNode): n is StrokeBearing {
  return 'strokes' in n && Array.isArray((n as { strokes?: unknown }).strokes)
}

async function resolveStroke(node: SceneNode): Promise<{ stroke: ResolvedFill | null; weight: number | null }> {
  if (!hasStrokes(node)) return { stroke: null, weight: null }
  if (node.strokes.length === 0) return { stroke: null, weight: null }
  // A stroke with weight 0 paints nothing regardless of its color — treat it
  // as no stroke so the contrast probe doesn't pick up a "phantom" colored
  // line that the user can't actually see on the canvas.
  const weight = node.strokeWeight === figma.mixed ? null : (node.strokeWeight as number)
  if (weight === 0) return { stroke: null, weight: 0 }
  const stroke = await resolveFills(node.strokes, node)
  return { stroke, weight }
}

/**
 * Resolve fill + stroke for an icon-shaped container (typically an InstanceNode).
 * Containers usually have no fill of their own — the colored paths live on
 * descendant VECTOR / BOOLEAN_OPERATION nodes. We try the container first, then
 * walk descendants to find the dominant icon color.
 */
async function resolveIconColors(
  node: SceneNode
): Promise<{ fill: ResolvedFill; stroke: ResolvedFill | null; weight: number | null }> {
  let fill = await resolveNodeFills(node as Parameters<typeof resolveNodeFills>[0])
  let strokeRes = await resolveStroke(node)

  const fillResolved = (): boolean => fill.rgba !== null
  const strokeResolved = (): boolean => strokeRes.stroke !== null && strokeRes.stroke.rgba !== null

  if (fillResolved() && strokeResolved()) {
    return { fill, stroke: strokeRes.stroke, weight: strokeRes.weight }
  }
  if (!('findAllWithCriteria' in node)) {
    return { fill, stroke: strokeRes.stroke, weight: strokeRes.weight }
  }

  const candidates = (node as FrameNode).findAllWithCriteria({
    types: ['VECTOR', 'BOOLEAN_OPERATION', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR'],
  })

  for (const c of candidates) {
    if (c.visible === false) continue
    if (!fillResolved()) {
      const f = await resolveNodeFills(c, c)
      if (f.rgba !== null) fill = f
    }
    if (!strokeResolved()) {
      const s = await resolveStroke(c)
      if (s.stroke !== null && s.stroke.rgba !== null) {
        strokeRes = s
      }
    }
    if (fillResolved() && strokeResolved()) break
  }

  return { fill, stroke: strokeRes.stroke, weight: strokeRes.weight }
}

async function buildVectorElement(
  node: VectorNode | BooleanOperationNode,
  rootFallback?: SceneNode
): Promise<NonTextContrastElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null
  // BOOLEAN_OPERATIONs sometimes carry no fill themselves — the color is on the
  // inner vectors. Use the icon-color resolver to walk descendants if needed.
  // Plain VECTORs already have their own fill, so the resolver is a no-op walk.
  const { fill, stroke, weight } = await resolveIconColors(node)
  const background = await sampleBackground(node, { rootFallback })
  return {
    kind: 'non-text-contrast',
    id: node.id,
    name: node.name,
    nodeType: node.type,
    fill,
    stroke,
    strokeWeight: weight,
    background,
    isIconOnly: true,
    bbox: toBBox(node.absoluteBoundingBox),
  }
}

/**
 * Build a NonTextContrastElement from a drawn primitive shape (RECTANGLE,
 * ELLIPSE, POLYGON, STAR, LINE). Resolves the shape's own fill + stroke
 * directly — no descendant walk needed since shapes are leaf-level. Skips
 * shapes with neither a usable fill nor a usable stroke (purely transparent
 * spacers / clipping rects).
 */
async function buildShapeElement(
  node: ShapeNode,
  rootFallback?: SceneNode
): Promise<NonTextContrastElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null

  const fill = await resolveNodeFills(node as Parameters<typeof resolveNodeFills>[0])
  const strokeRes = await resolveStroke(node)

  const fillUsable = fill.rgba !== null
  const strokeUsable = strokeRes.stroke !== null && strokeRes.stroke.rgba !== null
  if (!fillUsable && !strokeUsable) return null

  const background = await sampleBackground(node, { rootFallback })
  return {
    kind: 'non-text-contrast',
    id: node.id,
    name: node.name,
    nodeType: node.type,
    fill,
    stroke: strokeRes.stroke,
    strokeWeight: strokeRes.weight,
    background,
    isIconOnly: true,
    bbox: toBBox(node.absoluteBoundingBox),
  }
}

function instanceHasTextDescendants(node: InstanceNode): boolean {
  return node.findOne(n => n.type === 'TEXT' && n.visible !== false) !== null
}

async function buildIconInstance(
  node: InstanceNode,
  rootFallback?: SceneNode
): Promise<NonTextContrastElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null
  // Only treat as icon-only interactive when the instance has no text. Form
  // inputs and other text-bearing instances are handled by their own builders.
  if (instanceHasTextDescendants(node)) return null
  // Also skip instances whose main component is a known form input — even if
  // they currently render no text, they belong to form-input.ts.
  try {
    const main = await node.getMainComponentAsync()
    const name = main?.parent?.type === 'COMPONENT_SET' ? main.parent.name : main?.name
    if (name && isFormInputName(name)) return null
  } catch {
    // Detached / orphan instance — fall through and treat as icon.
  }
  const { fill, stroke, weight } = await resolveIconColors(node)
  const background = await sampleBackground(node, { rootFallback })
  return {
    kind: 'non-text-contrast',
    id: node.id,
    name: node.name,
    nodeType: 'INSTANCE',
    fill,
    stroke,
    strokeWeight: weight,
    background,
    isIconOnly: true,
    bbox: toBBox(node.absoluteBoundingBox),
  }
}

/**
 * Build non-text-contrast elements from a list of candidate vectors, shapes,
 * and instances.
 *
 * Dedup rules:
 *  - A VECTOR whose nearest BOOLEAN_OPERATION ancestor is in the vector list
 *    is dropped (existing rule — composite icons report once).
 *  - A VECTOR / BOOLEAN_OPERATION / SHAPE whose nearest INSTANCE ancestor was
 *    already classified as an icon-only NonTextContrastElement is dropped — icon
 *    components report once instead of once per inner path.
 *  - A SHAPE inside a vector or boolean-op subtree is dropped — vector glyphs
 *    sometimes carry inner rectangles that aren't really separate elements.
 *  - Shapes with neither a usable fill nor a usable stroke are dropped by
 *    `buildShapeElement` itself (transparent spacers, clipping rects).
 *
 * Order: process instances first so we know which become icon-only, then use
 * that set to filter the vectors and shapes before processing them.
 */
export async function buildNonTextContrastElements(
  vectors: Array<VectorNode | BooleanOperationNode>,
  shapes: ShapeNode[],
  instances: InstanceNode[],
  rootFallback?: SceneNode
): Promise<NonTextContrastElement[]> {
  const instanceResults = await Promise.all(
    instances.map(n => buildIconInstance(n, rootFallback))
  )
  const iconInstances = instanceResults.filter(
    (e): e is NonTextContrastElement => e !== null
  )
  const iconInstanceIds = new Set(iconInstances.map(e => e.id))

  const booleanOpIds = new Set(
    vectors.filter(v => v.type === 'BOOLEAN_OPERATION').map(v => v.id)
  )
  const vectorIds = new Set(vectors.map(v => v.id))

  const dedupedVectors = vectors.filter(v => {
    let p: BaseNode | null = v.parent
    while (p && p.type !== 'PAGE') {
      if (p.type === 'INSTANCE' && iconInstanceIds.has(p.id)) return false
      if (v.type === 'VECTOR' && booleanOpIds.has(p.id)) return false
      p = p.parent
    }
    return true
  })

  // Shapes inherit the same dedup rules. Additionally, a shape whose parent
  // chain crosses a vector / boolean-op already in scope is treated as part
  // of that vector (some imported SVGs carry inner rectangles).
  const dedupedShapes = shapes.filter(s => {
    let p: BaseNode | null = s.parent
    while (p && p.type !== 'PAGE') {
      if (p.type === 'INSTANCE' && iconInstanceIds.has(p.id)) return false
      if (vectorIds.has(p.id) || booleanOpIds.has(p.id)) return false
      p = p.parent
    }
    return SHAPE_NODE_TYPES.has(s.type)
  })

  const [fromVectors, fromShapes] = await Promise.all([
    Promise.all(dedupedVectors.map(v => buildVectorElement(v, rootFallback))),
    Promise.all(dedupedShapes.map(s => buildShapeElement(s, rootFallback))),
  ])

  const fromVectorsFiltered = fromVectors.filter((e): e is NonTextContrastElement => e !== null)
  const fromShapesFiltered = fromShapes.filter((e): e is NonTextContrastElement => e !== null)

  return [...iconInstances, ...fromVectorsFiltered, ...fromShapesFiltered]
}
