// Paint → ResolvedFill resolution. Handles raw colors, paint-style references,
// and variable bindings (mode-aware via Variable.resolveForConsumer).
//
// Error-handling policy: silent fallback. When a paint can't be resolved
// (variable lookup throws, paint kind is non-color, opacity is zero), we
// return a `ResolvedFill` carrying a `kind: 'unresolvable'` source with a
// reason — never throws. The runner downstream uses the reason to decide
// whether to surface as `unable-to-test` or skip the element.

import type {
  ColorSource,
  ColorSourceUnresolvableReason,
  ResolvedFill,
  RGB,
  RGBA,
} from '../shared/dtos'
import { flattenFillStack } from './compositing.ts'

const NON_SOLID_REASON: Record<string, ColorSourceUnresolvableReason> = {
  GRADIENT_LINEAR: 'gradient',
  GRADIENT_RADIAL: 'gradient',
  GRADIENT_ANGULAR: 'gradient',
  GRADIENT_DIAMOND: 'gradient',
  IMAGE: 'image',
  VIDEO: 'video',
  PATTERN: 'pattern',
}

function rgbToHex(rgb: RGB): string {
  const toHex = (v: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(v)))
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
}

function paintColorToRGBA(paint: SolidPaint): RGBA {
  const { r, g, b } = paint.color
  const opacity = paint.opacity ?? 1
  const visible = paint.visible ?? true
  const alpha = visible ? opacity : 0
  return [r * 255, g * 255, b * 255, alpha] as const
}

/** Look up a variable and resolve it from the perspective of the given consumer node. */
async function resolveVariableSource(
  variableId: string,
  consumerNode: SceneNode
): Promise<{ source: ColorSource; rgba: RGBA | null }> {
  const variable = await figma.variables.getVariableByIdAsync(variableId)
  if (!variable) {
    return {
      source: { kind: 'unresolvable', reason: 'unknown' },
      rgba: null,
    }
  }
  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId
  )
  const resolved = variable.resolveForConsumer(consumerNode)
  // Resolved value for a COLOR variable is { r, g, b, a? } (object, each 0..1).
  let rgba: RGBA | null = null
  if (
    resolved &&
    resolved.value &&
    typeof resolved.value === 'object' &&
    'r' in resolved.value &&
    'g' in resolved.value &&
    'b' in resolved.value
  ) {
    const v = resolved.value as { r: number; g: number; b: number; a?: number }
    const r = v.r * 255
    const g = v.g * 255
    const b = v.b * 255
    const a = typeof v.a === 'number' ? v.a : 1
    rgba = [r, g, b, a] as const
  }
  // Best-effort active mode lookup: we don't know which mode is "active" at the
  // consumer except by reading what resolveForConsumer chose. The Plugin API
  // doesn't expose the resolved modeId directly; we surface the variable's
  // primary collection and the default mode name as a sane label. If the file
  // has explicit modes set on ancestors, the resolved color is still correct —
  // we just label the source with the default mode name.
  const modeId = collection?.defaultModeId ?? ''
  const modeName =
    collection?.modes.find(m => m.modeId === modeId)?.name ?? 'default'
  const source: ColorSource = {
    kind: 'variable',
    variableId: variable.id,
    variableName: variable.name,
    modeId,
    modeName,
    collectionId: collection?.id ?? '',
    collectionName: collection?.name ?? '',
  }
  return { source, rgba }
}

/** Resolve a single paint into either a concrete RGBA + source, or a non-solid marker. */
async function resolvePaint(
  paint: Paint,
  consumerNode: SceneNode
): Promise<{ source: ColorSource; rgba: RGBA | null }> {
  if (paint.visible === false) {
    return { source: { kind: 'unresolvable', reason: 'invisible' }, rgba: null }
  }
  if (paint.type !== 'SOLID') {
    const reason = NON_SOLID_REASON[paint.type] ?? 'unknown'
    return { source: { kind: 'unresolvable', reason }, rgba: null }
  }
  const colorBinding = paint.boundVariables?.color
  if (colorBinding && colorBinding.id) {
    const resolved = await resolveVariableSource(colorBinding.id, consumerNode)
    if (resolved.rgba) {
      // Apply paint-level opacity on top of the variable's alpha.
      const [r, g, b, a] = resolved.rgba
      const visible = paint.visible ?? true
      const opacity = paint.opacity ?? 1
      const finalA = visible ? a * opacity : 0
      return { source: resolved.source, rgba: [r, g, b, finalA] as const }
    }
    return resolved
  }
  return { source: { kind: 'raw' }, rgba: paintColorToRGBA(paint) }
}

interface ResolvedFillsContext {
  /** When the node's fillStyleId is set, surface it as the source. */
  styleSource?: { styleId: string; styleName: string }
}

/**
 * Resolve a node's fills array (or `figma.mixed`) into a single ResolvedFill.
 * Composites multiple solid layers top-down; if any layer is non-solid the
 * result is unresolvable with that layer's reason.
 */
export async function resolveFills(
  fills: ReadonlyArray<Paint> | typeof figma.mixed,
  consumerNode: SceneNode,
  ctx: ResolvedFillsContext = {}
): Promise<ResolvedFill> {
  if (fills === figma.mixed) {
    return {
      hex: null,
      rgba: null,
      source: { kind: 'unresolvable', reason: 'mixed' },
    }
  }
  // A paint counts as "invisible" if its eye-icon is off (visible === false)
  // OR its opacity is 0. Both render nothing on the canvas, so neither should
  // contribute to the audit math — a hidden grey stroke must NOT rescue an
  // otherwise-failing element.
  const visible = fills.filter(p => p.visible !== false && (p.opacity ?? 1) > 0)
  if (visible.length === 0) {
    return {
      hex: null,
      rgba: null,
      source: { kind: 'unresolvable', reason: 'invisible' },
    }
  }
  const resolved = await Promise.all(visible.map(p => resolvePaint(p, consumerNode)))

  // First non-solid wins — a gradient/image fill makes the overall fill unmeasurable.
  const nonSolid = resolved.find(r => r.rgba === null)
  if (nonSolid) {
    return { hex: null, rgba: null, source: nonSolid.source }
  }

  // `resolved` is in Figma fills order — bottom-to-top — so the last entry is
  // the topmost paint. Flatten the stack into a single straight-alpha RGBA that
  // preserves the combined alpha; the contrast calc later composites this over
  // the real ancestor background. When the topmost paint is opaque this yields
  // exactly that paint's color (everything beneath is occluded).
  const stack = resolved.map(r => r.rgba as RGBA)
  const flatRGBA = flattenFillStack(stack)

  // Source: prefer style source if the node had a fillStyleId; otherwise the
  // topmost (last) paint's source — that's the paint that defines the layer's
  // visible color.
  const source: ColorSource =
    ctx.styleSource !== undefined
      ? { kind: 'style', ...ctx.styleSource }
      : resolved[resolved.length - 1].source

  return {
    hex: rgbToHex([flatRGBA[0], flatRGBA[1], flatRGBA[2]]),
    rgba: flatRGBA,
    source,
  }
}

/**
 * Convenience for nodes with a `fills` property and possibly a `fillStyleId`.
 * If the style id resolves to a paint style, that style's paints are used and
 * the source is reported as `style`.
 */
export async function resolveNodeFills(
  node: SceneNode & { fills?: ReadonlyArray<Paint> | typeof figma.mixed; fillStyleId?: string | typeof figma.mixed },
  consumerNode: SceneNode = node
): Promise<ResolvedFill> {
  const styleIdRaw = node.fillStyleId
  if (typeof styleIdRaw === 'string' && styleIdRaw.length > 0) {
    try {
      const style = await figma.getStyleByIdAsync(styleIdRaw)
      if (style && style.type === 'PAINT') {
        const paintStyle = style as PaintStyle
        return resolveFills(paintStyle.paints, consumerNode, {
          styleSource: { styleId: paintStyle.id, styleName: paintStyle.name },
        })
      }
    } catch {
      // Fall through to direct fills resolution.
    }
  }
  const fills = node.fills ?? []
  return resolveFills(fills, consumerNode)
}
