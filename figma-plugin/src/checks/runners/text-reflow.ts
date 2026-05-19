import type { AuditDTO, TextElement } from '../../shared/dtos'
import type { Finding } from '../findings.ts'

export const TEXT_REFLOW_CRITERION = 'text-reflow'

export function runTextReflowCheck(dto: AuditDTO): Finding[] {
  return dto.texts.map(auditTextReflow)
}

function auditTextReflow(text: TextElement): Finding {
  if (text.textAutoResize === 'HEIGHT' || text.textAutoResize === 'WIDTH_AND_HEIGHT') {
    return {
      criterion: TEXT_REFLOW_CRITERION,
      status: 'pass',
      scope: 'element',
      nodeId: text.id,
      nodeName: text.name,
      message: 'Text reflow — text box height can grow.',
      details: { textAutoResize: text.textAutoResize },
    }
  }

  return {
    criterion: TEXT_REFLOW_CRITERION,
    status: 'flag',
    scope: 'element',
    nodeId: text.id,
    nodeName: text.name,
    message: 'Text reflow — fixed-height text box may clip resized or spaced text.',
    details: { textAutoResize: text.textAutoResize },
  }
}
