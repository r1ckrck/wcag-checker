// Alpha compositing helpers used by the color resolver to flatten multi-fill
// stacks. Pure — no Figma globals, no DOM, no async.
//
// Error-handling policy: pure math, no failure modes. Inputs that produce
// degenerate output (transparent stack, zero alpha) return well-defined
// transparent results; never throws.

import type { RGB, RGBA } from '../shared/dtos'
import { blendOnBackground } from '../checks/contrast.ts'

/** Single "over" operator. Re-exported from checks/contrast.ts to keep one source of truth. */
export const over = blendOnBackground

/**
 * Composite a stack of paints (top-first) over an opaque background. Empty
 * stacks return the background unchanged.
 */
export function compositeFills(stack: ReadonlyArray<RGBA>, bg: RGB): RGB {
  if (stack.length === 0) return bg
  // Iterate bottom-up, so each layer is composited "over" the running result.
  let result: RGB = bg
  for (let i = stack.length - 1; i >= 0; i--) {
    result = over(stack[i], result)
  }
  return result
}

/** Straight-alpha "A over B" where both carry their own alpha. */
function straightOver(top: RGBA, bottom: RGBA): RGBA {
  const aT = top[3]
  const aB = bottom[3]
  const aOut = aT + aB * (1 - aT)
  if (aOut === 0) return [0, 0, 0, 0] as const
  const r = (top[0] * aT + bottom[0] * aB * (1 - aT)) / aOut
  const g = (top[1] * aT + bottom[1] * aB * (1 - aT)) / aOut
  const b = (top[2] * aT + bottom[2] * aB * (1 - aT)) / aOut
  return [r, g, b, aOut] as const
}

/**
 * Flatten a stack of straight-alpha paints into a single straight-alpha RGBA,
 * preserving the stack's combined alpha so the result can be composited over
 * the real substrate downstream.
 *
 * `stack` is in Figma fills order — bottom-to-top — so the LAST entry is the
 * topmost paint. An opaque topmost paint yields exactly that paint's color
 * (everything beneath it is occluded), which is the common case.
 */
export function flattenFillStack(stack: ReadonlyArray<RGBA>): RGBA {
  if (stack.length === 0) return [0, 0, 0, 0] as const
  let acc: RGBA = stack[0]
  for (let i = 1; i < stack.length; i++) {
    acc = straightOver(stack[i], acc)
  }
  return acc
}
