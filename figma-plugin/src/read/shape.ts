// Small, defensive shape metadata shared by target-size consumers.
// Figma exposes cornerRadius only on some node types and may return `mixed`;
// DTO consumers only need a single numeric value when it is safe to use.

export interface ShapeMeta {
  nodeType: string
  cornerRadius: number | null
}

export function shapeMeta(node: SceneNode): ShapeMeta {
  return {
    nodeType: node.type,
    cornerRadius: readCornerRadius(node),
  }
}

function readCornerRadius(node: SceneNode): number | null {
  if (!('cornerRadius' in node)) return null
  const radius = (node as { cornerRadius: number | typeof figma.mixed }).cornerRadius
  return typeof radius === 'number' && Number.isFinite(radius) ? radius : null
}
