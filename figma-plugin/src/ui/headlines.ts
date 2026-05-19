// Descriptive titles for findings. Pure — no DOM, no figma globals.
// Principle (per redesign plan): the title says what's WRONG, not what to do.
//
// Examples:
//   "Low text contrast"                  not  "Increase text contrast"
//   "Tight line height"                  not  "Loosen line height"
//   "Color-only error indicator"         not  "Add a non-color indicator"
//   "Placeholder used as label"          not  "Add a visible label"

import type { Finding } from '../checks/findings.ts'
import { typographyTitleFor } from './copy.ts'

/**
 * Pick a descriptive headline for a flagged or unable-to-test Finding.
 * The renderer falls back to `finding.message` only if no headline is registered.
 */
export function headlineFor(finding: Finding): string {
  const c = finding.criterion
  const d = (finding.details ?? {}) as Record<string, unknown>

  switch (c) {
    case '1.4.3':
      return 'Low text contrast'
    case '1.4.11':
      return 'Low element contrast'
    case '1.4.5':
      return 'Possible image of text'
    case 'typography':
      return typeof d.property === 'string'
        ? typographyTitleFor(d.property)
        : 'Tight text spacing'
    case 'text-reflow':
      return 'Text may not reflow'
    case '3.3.2':
      return formLabelHeadline(finding.message)
    case '2.4.4':
      return 'Vague link text'
    case '2.4.6':
      if (d.source === 'form-label') return 'Label looks like a placeholder'
      if (d.source === 'text-node') return 'Text looks like a placeholder'
      return 'Link text looks like a placeholder'
    case '2.5.8':
      return 'Small touch target'
    case '1.4.1':
      return useOfColorHeadline(d, finding.message)
    case '2.4.7':
      return focusVisibleHeadline(d, finding.message)
    case '3.3.1':
      return errorIdentificationHeadline(d, finding.message)
    case '3.3.3':
      return errorSuggestionHeadline(d, finding.message)
    default:
      return finding.message
  }
}

// ── 3.3.2 Form labels ───────────────────────────────────────────────

function formLabelHeadline(message: string): string {
  if (/no label or placeholder/i.test(message)) return 'No label or placeholder'
  if (/placeholder only/i.test(message)) return 'Placeholder used as label'
  return 'Missing label'
}

// ── 1.4.1 / 2.4.7 / 3.3.1 / 3.3.3 — variant findings ────────────────
//
// The variant runner doesn't (yet) emit a `details.kind` discriminator, so
// these helpers fall back to substring matching on the message. We keep the
// match anchors short and stable — the runner messages are constants in the
// codebase, not user-edited strings.

function useOfColorHeadline(_d: Record<string, unknown>, message: string): string {
  if (/no error variant designed/i.test(message)) return 'No error variant found'
  if (/uses color alone/i.test(message)) return 'Color-only error indicator'
  return 'Use of color issue'
}

function focusVisibleHeadline(_d: Record<string, unknown>, message: string): string {
  if (/no focus variant designed/i.test(message)) return 'No focus variant found'
  if (/no visible difference/i.test(message)) return 'Focus state visually identical to default'
  if (/default variant unavailable/i.test(message)) return 'Default variant unavailable'
  return 'Focus state issue'
}

function errorIdentificationHeadline(_d: Record<string, unknown>, message: string): string {
  if (/no error variant designed/i.test(message)) return 'No error variant found'
  if (/no message text/i.test(message)) return 'No error message text'
  if (/relies on color alone/i.test(message)) return 'Error relies on color alone'
  return 'Error identification issue'
}

function errorSuggestionHeadline(_d: Record<string, unknown>, message: string): string {
  if (/no error variant designed/i.test(message)) return 'No error variant found'
  if (/no error message text to evaluate/i.test(message)) return 'No error message text'
  if (/looks vague/i.test(message)) return 'Vague error message'
  return 'Error suggestion issue'
}
