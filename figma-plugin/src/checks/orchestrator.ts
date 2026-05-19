// Run check runners against an AuditDTO and aggregate into a FindingsReport.
//
// Bug 4 — progressive disclosure for variants. The default audit no longer
// runs variant criteria (1.4.1, 2.4.7, 3.3.1, 3.3.3). They produce a lot of
// false positives on layout/container components that don't need focus/error
// states. The user opts in via a separate "Run variant audit" CTA in the UI,
// which calls runVariantChecks() on the stored DTO.

import type { AuditDTO } from '../shared/dtos'
import { aggregate, type Finding, type FindingsReport } from './findings.ts'
import { runContrastCheck } from './runners/contrast.ts'
import { runTypographyCheck } from './runners/typography.ts'
import { runFormLabelCheck } from './runners/form-label.ts'
import { runLinkPurposeCheck } from './runners/link-purpose.ts'
import { runTextReflowCheck } from './runners/text-reflow.ts'
import { runTouchTargetCheck } from './runners/touch-target.ts'
import { runHeadingsLabelsCheck } from './runners/headings-labels.ts'
import { runVariantCheck } from './runners/variant.ts'
import { buildManualChecks } from './manual.ts'

/**
 * Default audit — runs the deterministic, always-applicable checks. Variant
 * criteria are deliberately excluded; the UI surfaces a separate "Run variant
 * audit" action that calls {@link runVariantChecks}.
 */
export async function runChecks(dto: AuditDTO): Promise<FindingsReport> {
  const [contrast, typography, formLabel, linkPurpose, textReflow, touchTarget, headingsLabels] = await Promise.all([
    Promise.resolve(runContrastCheck(dto)),
    Promise.resolve(runTypographyCheck(dto)),
    Promise.resolve(runFormLabelCheck(dto)),
    Promise.resolve(runLinkPurposeCheck(dto)),
    Promise.resolve(runTextReflowCheck(dto)),
    Promise.resolve(runTouchTargetCheck(dto)),
    Promise.resolve(runHeadingsLabelsCheck(dto)),
  ])

  const all = [...contrast, ...typography, ...formLabel, ...linkPurpose, ...textReflow, ...touchTarget, ...headingsLabels]
  const buckets = aggregate(all)

  return {
    passes: buckets.passes,
    flags: buckets.flags,
    unableToTest: buckets.unableToTest,
    manual: buildManualChecks(dto),
    warnings: [...dto.warnings],
  }
}

/**
 * Variant audit — runs only the four variant-state criteria (1.4.1, 2.4.7,
 * 3.3.1, 3.3.3). User-triggered after the default audit completes. Returns the
 * aggregated buckets so the UI can render passes/flags/unable separately.
 */
export async function runVariantChecks(dto: AuditDTO): Promise<{
  passes: Finding[]
  flags: Finding[]
  unableToTest: Finding[]
}> {
  const variant = await runVariantCheck(dto)
  return aggregate(variant)
}
