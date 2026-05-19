// Group findings with identical key tuples so the renderer can render
//   "Forgot password", "Submit button" — Low text contrast  current = 2.1:1
// instead of two near-identical entries one above the other.
//
// Pure — no DOM, no figma globals.

import type { Finding } from '../checks/findings.ts'

export interface GroupedFinding {
  /** All originals that collapsed into this group. */
  members: Finding[]
  /** Convenience: all member nodeIds + names, in original order. */
  nodes: Array<{ id: string | null; name: string | null }>
  /** First member, used as the canonical source of details/headline. */
  representative: Finding
}

/**
 * Bucket a list of findings by their criterion-specific identity key.
 * Findings with identical key strings collapse into one GroupedFinding;
 * findings whose key returns null stay as singletons (treated as unique).
 *
 * Order of buckets matches first appearance of each key in `findings`.
 */
export function groupSimilar(findings: Finding[]): GroupedFinding[] {
  const order: string[] = []
  const buckets = new Map<string, Finding[]>()
  // Singletons get a synthetic per-finding key so they stay separate.
  let singletonCounter = 0

  for (const f of findings) {
    let key = identityKey(f)
    if (key === null) {
      key = `__singleton__${singletonCounter++}`
    }
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    buckets.get(key)!.push(f)
  }

  return order.map(k => {
    const members = buckets.get(k)!
    return {
      members,
      nodes: members.map(m => ({ id: m.nodeId, name: m.nodeName })),
      representative: members[0],
    }
  })
}

/**
 * Per-criterion identity key. Two findings with the same key collapse together.
 * Returning null means "always unique — never collapse with anything".
 */
function identityKey(f: Finding): string | null {
  const d = (f.details ?? {}) as Record<string, unknown>
  switch (f.criterion) {
    case '1.4.3':
    case '1.4.11': {
      // Same fg+bg+ratio+threshold collapses. We use the runner's `actual`
      // and `required` (rounded to 2dp) — when the same color pair appears
      // on multiple elements they'll naturally produce identical numbers.
      const actual = numStr(d.actual)
      const required = numStr(d.required)
      if (actual == null || required == null) return null
      return `${f.criterion}|${actual}|${required}`
    }
    case 'typography': {
      const property = typeof d.property === 'string' ? d.property : null
      const actual = typeof d.actual === 'string' ? d.actual : numStr(d.actual)
      const required = typeof d.required === 'string' ? d.required : numStr(d.required)
      if (!property) return null
      return `${f.criterion}|${property}|${actual}|${required}`
    }
    case '3.3.2': {
      // Same flag message ("No label or placeholder" / "Placeholder only") collapses.
      return `${f.criterion}|${f.message}`
    }
    case 'text-reflow': {
      const textAutoResize = typeof d.textAutoResize === 'string' ? d.textAutoResize : 'unknown'
      return `${f.criterion}|${textAutoResize}`
    }
    case '2.5.8': {
      const width = numStr(d.width)
      const height = numStr(d.height)
      const required = numStr(d.required)
      if (width == null || height == null || required == null) return null
      return `${f.criterion}|${width}|${height}|${required}`
    }
    case '2.4.6': {
      // Collapse by literal offending text (lowercased) so three buttons all
      // named "Button" merge into one card with three chips, but "Button" +
      // "Text 1" stay separate (each shows the user the exact copy to fix).
      const text = typeof d.text === 'string' ? d.text.toLowerCase() : null
      if (text == null) return null
      return `${f.criterion}|${text}`
    }
    // Variant findings (1.4.1, 2.4.7, 3.3.1, 3.3.3) live at component scope —
    // there's only one per component, no grouping happens. Returning null
    // keeps them as singletons.
    default:
      return null
  }
}

function numStr(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return v.toFixed(2)
}
