// Pure mapping module — bins findings + manual checks into the 6 designer-readable
// groups. No DOM, no figma globals; testable with node:test.

import type { Finding, FindingsReport, ManualCheckItem } from '../checks/findings.ts'

export type GroupId =
  | 'color-contrast'
  | 'typography'
  | 'forms-errors'
  | 'content-links'
  | 'content-labels'
  | 'inclusive-instructions'
  | 'other'

export const GROUP_ORDER: readonly GroupId[] = [
  'color-contrast',
  'typography',
  'forms-errors',
  'content-links',
  'content-labels',
  'inclusive-instructions',
  'other',
] as const

export const GROUP_TITLES: Record<GroupId, string> = {
  'color-contrast': 'Color & contrast',
  typography: 'Typography',
  'forms-errors': 'Forms & errors',
  'content-links': 'Interactive elements',
  'content-labels': 'Content & labels',
  'inclusive-instructions': 'Inclusive instructions',
  other: 'Other',
}

/** Single source of truth: WCAG criterion → group. No criterion appears twice.
 * 2.4.7 (Focus Visible) groups with forms-errors — focus rings are most
 * relevant in form / interactive-control contexts. 1.4.13 and 2.1.1 are
 * intentionally absent (dev-stage scope, dropped from the manual list). */
export const CRITERION_TO_GROUP: Record<string, GroupId> = {
  '1.4.1': 'color-contrast',
  '1.4.3': 'color-contrast',
  '1.4.11': 'color-contrast',

  '1.4.5': 'typography',
  // Non-SC: general readability floors (line-height, letter-spacing,
  // paragraph-spacing). The WCAG SC for spacing (1.4.12) is a user-override
  // resilience test handled separately by the future reflow runner.
  'typography': 'typography',
  'text-reflow': 'typography',

  '2.4.7': 'forms-errors',
  '3.3.1': 'forms-errors',
  '3.3.2': 'forms-errors',
  '3.3.3': 'forms-errors',

  '2.4.4': 'content-links',
  '2.5.8': 'content-links',

  '2.4.6': 'content-labels',

  // Manual-only criteria — surfaced as bullets in the bottom note, never as
  // a group card. Their group assignment exists only so groupForCriterion
  // doesn't fall back to 'other' (and console.warn) when the renderer iterates
  // them. The renderFindingsCards filter explicitly skips these for cards.
  '1.3.3': 'inclusive-instructions',
  '2.2.1': 'inclusive-instructions',
  '2.2.2': 'inclusive-instructions',
  '2.5.1': 'inclusive-instructions',
}

/** Plain-English title for the (i) reveal — `<code> — <name>`. */
export const CRITERION_TITLES: Record<string, string> = {
  '1.3.3': 'Sensory Characteristics',
  '1.4.1': 'Use of Color',
  '1.4.3': 'Contrast (Minimum)',
  '1.4.5': 'Images of Text',
  '1.4.11': 'Non-Text Contrast',
  '2.2.1': 'Timing Adjustable',
  '2.2.2': 'Pause, Stop, Hide',
  '2.4.4': 'Link Purpose (In Context)',
  '2.4.6': 'Headings and Labels',
  '2.4.7': 'Focus Visible',
  '2.5.1': 'Pointer Gestures',
  '2.5.8': 'Target Size (Minimum)',
  '3.3.1': 'Error Identification',
  '3.3.2': 'Labels or Instructions',
  '3.3.3': 'Error Suggestion',
  'text-reflow': 'Text Reflow',
  // 'typography' is intentionally absent — it's not a WCAG SC and shouldn't
  // surface a standard reference in the UI.
}

const warnedUnknown = new Set<string>()

export function groupForCriterion(code: string): GroupId {
  const g = CRITERION_TO_GROUP[code]
  if (g) return g
  if (!warnedUnknown.has(code)) {
    warnedUnknown.add(code)
    // eslint-disable-next-line no-console
    console.warn(`[findings-groups] Unknown WCAG criterion "${code}" — falling back to 'other'.`)
  }
  return 'other'
}

export type ToVerifyEntry =
  | { kind: 'finding'; finding: Finding }
  | { kind: 'manual'; item: ManualCheckItem }

export interface GroupView {
  id: GroupId
  title: string
  passed: Finding[]
  flagged: Finding[]
  toVerify: ToVerifyEntry[]
}

interface MutableGroup {
  id: GroupId
  passed: Finding[]
  flagged: Finding[]
  toVerify: ToVerifyEntry[]
}

function emptyGroups(): Record<GroupId, MutableGroup> {
  const out = {} as Record<GroupId, MutableGroup>
  for (const id of GROUP_ORDER) {
    out[id] = { id, passed: [], flagged: [], toVerify: [] }
  }
  return out
}

export function buildGroupViews(report: FindingsReport): GroupView[] {
  const groups = emptyGroups()

  for (const f of report.passes) {
    groups[groupForCriterion(f.criterion)].passed.push(f)
  }
  for (const f of report.flags) {
    groups[groupForCriterion(f.criterion)].flagged.push(f)
  }
  for (const f of report.unableToTest) {
    groups[groupForCriterion(f.criterion)].toVerify.push({ kind: 'finding', finding: f })
  }
  for (const m of report.manual) {
    if (!m.applicable) continue
    groups[groupForCriterion(m.criterion)].toVerify.push({ kind: 'manual', item: m })
  }

  const out: GroupView[] = []
  for (const id of GROUP_ORDER) {
    const g = groups[id]
    if (g.passed.length === 0 && g.flagged.length === 0 && g.toVerify.length === 0) continue
    out.push({
      id,
      title: GROUP_TITLES[id],
      passed: g.passed,
      flagged: g.flagged,
      toVerify: g.toVerify,
    })
  }
  return out
}
