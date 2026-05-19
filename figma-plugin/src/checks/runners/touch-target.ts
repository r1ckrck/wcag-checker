// SC 2.5.8 Target Size (Minimum). Pure DTO consumer.
//
// Strategy: every classified clickable and every form input must have a
// bounding box at least 24 px wide AND 24 px tall. This is a strict threshold:
// any dimension below 24 fails, regardless of total area.

import type { AuditDTO, BBox, ClickableElement, FormInputElement } from '../../shared/dtos'
import type { Finding } from '../findings.ts'

const MIN_TARGET_SIZE = 24

type Target = Pick<
  ClickableElement | FormInputElement,
  'id' | 'name' | 'nodeType' | 'cornerRadius' | 'bbox'
>

export function runTouchTargetCheck(dto: AuditDTO): Finding[] {
  const targets: Target[] = [...dto.clickables, ...dto.formInputs]
  return targets.map(auditTarget)
}

function auditTarget(target: Target): Finding {
  const { width, height } = target.bbox
  if (width >= MIN_TARGET_SIZE && height >= MIN_TARGET_SIZE) {
    return {
      criterion: '2.5.8',
      status: 'pass',
      scope: 'element',
      nodeId: target.id,
      nodeName: target.name,
      message: '2.5.8 — target size is at least 24 × 24 px.',
    }
  }

  return {
    criterion: '2.5.8',
    status: 'flag',
    scope: 'element',
    nodeId: target.id,
    nodeName: target.name,
    message: `Target is ${formatSize(target.bbox)} px; needs at least ${MIN_TARGET_SIZE} × ${MIN_TARGET_SIZE} px.`,
    details: {
      width,
      height,
      required: MIN_TARGET_SIZE,
      nodeType: target.nodeType,
      cornerRadius: target.cornerRadius,
    },
  }
}

function formatSize(bbox: BBox): string {
  return `${formatNumber(bbox.width)} × ${formatNumber(bbox.height)}`
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '')
}
