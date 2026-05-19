// Build the manual-check checklist from a DTO. Pure — no figma globals.
//
// These are WCAG criteria the audit can't verify from a static Figma frame
// (they describe *behavior over time* — pause/stop, gesture alternatives,
// motion actuation, sensory dependencies). Surfaced as a slim bottom note in
// the report so the user knows what to verify manually before shipping.

import type { AuditDTO } from '../shared/dtos'
import type { ManualCheckItem } from './findings.ts'

// `dto` is unused for now — every item below is universally applicable.
// Kept on the signature so the orchestrator's contract doesn't need to know
// whether manual checks are dynamic.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildManualChecks(_dto: AuditDTO): ManualCheckItem[] {
  return [
    {
      criterion: '1.3.3',
      name: 'Sensory Characteristics',
      applicable: true,
      hint: 'Verify instructions don\'t rely solely on shape, size, position, or sound.',
    },
    {
      criterion: '2.2.1',
      name: 'Timing Adjustable',
      applicable: true,
      hint: 'Time limits should be turn-off-able, adjustable, or extendable.',
    },
    {
      criterion: '2.2.2',
      name: 'Auto-updating content',
      applicable: true,
      hint: 'Auto-updating content should be pausable, stoppable, or hideable.',
    },
    {
      criterion: '2.5.1',
      name: 'Gestures & motion',
      applicable: true,
      hint: 'Multi-touch gestures and motion actuation should have button alternatives.',
    },
  ]
}
