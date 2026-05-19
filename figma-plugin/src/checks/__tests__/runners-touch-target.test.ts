import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTouchTargetCheck } from '../runners/touch-target.ts'
import type { AuditDTO, ClickableElement, FormInputElement } from '../../shared/dtos.ts'

const baseDTO = (
  clickables: ClickableElement[] = [],
  formInputs: FormInputElement[] = []
): AuditDTO => ({
  component: {
    id: '0:1',
    name: 'C',
    type: 'COMPONENT',
    width: 0,
    height: 0,
    pageId: 'p',
    pageName: 'P',
    modeName: null,
  },
  texts: [],
  nonTextContrast: [],
  images: [],
  formInputs,
  clickables,
  variants: null,
  warnings: [],
})

const clickable = (over: Partial<ClickableElement> = {}): ClickableElement => ({
  kind: 'clickable',
  id: over.id ?? 'c:1',
  name: over.name ?? 'Button',
  nodeType: over.nodeType ?? 'INSTANCE',
  cornerRadius: over.cornerRadius ?? 4,
  componentName: over.componentName ?? 'Button',
  textRaw: over.textRaw ?? 'Submit',
  textNormalized: over.textNormalized ?? 'submit',
  signals: over.signals ?? ['component-name'],
  bbox: over.bbox ?? { x: 0, y: 0, width: 24, height: 24 },
})

const input = (over: Partial<FormInputElement> = {}): FormInputElement => ({
  kind: 'form-input',
  id: over.id ?? 'i:1',
  name: over.name ?? 'Email',
  nodeType: over.nodeType ?? 'INSTANCE',
  cornerRadius: over.cornerRadius ?? 4,
  mainComponentName: over.mainComponentName ?? 'TextField',
  childTextNodes: over.childTextNodes ?? [],
  hasExternalLabel: over.hasExternalLabel ?? true,
  bbox: over.bbox ?? { x: 0, y: 0, width: 120, height: 40 },
})

test('24 × 24 clickable passes at the boundary', () => {
  const findings = runTouchTargetCheck(baseDTO([clickable()]))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].criterion, '2.5.8')
  assert.equal(findings[0].status, 'pass')
})

test('clickable above threshold passes', () => {
  const findings = runTouchTargetCheck(
    baseDTO([clickable({ bbox: { x: 0, y: 0, width: 32, height: 48 } })])
  )
  assert.equal(findings[0].status, 'pass')
})

test('16 × 24 fails because width is too small', () => {
  const findings = runTouchTargetCheck(
    baseDTO([clickable({ bbox: { x: 0, y: 0, width: 16, height: 24 } })])
  )
  assert.equal(findings[0].status, 'flag')
  assert.match(findings[0].message, /16 × 24/)
  const d = findings[0].details as { width?: number; height?: number; required?: number }
  assert.equal(d.width, 16)
  assert.equal(d.height, 24)
  assert.equal(d.required, 24)
})

test('24 × 16 fails because height is too small', () => {
  const findings = runTouchTargetCheck(
    baseDTO([clickable({ bbox: { x: 0, y: 0, width: 24, height: 16 } })])
  )
  assert.equal(findings[0].status, 'flag')
  const d = findings[0].details as { width?: number; height?: number }
  assert.equal(d.width, 24)
  assert.equal(d.height, 16)
})

test('16 × 16 fails both dimensions', () => {
  const findings = runTouchTargetCheck(
    baseDTO([clickable({ bbox: { x: 0, y: 0, width: 16, height: 16 } })])
  )
  assert.equal(findings[0].status, 'flag')
})

test('fractional size below 24 fails strictly', () => {
  const findings = runTouchTargetCheck(
    baseDTO([clickable({ bbox: { x: 0, y: 0, width: 23.99, height: 24 } })])
  )
  assert.equal(findings[0].status, 'flag')
  assert.match(findings[0].message, /23.99 × 24/)
})

test('form inputs are tested directly', () => {
  const findings = runTouchTargetCheck(
    baseDTO([], [input({ bbox: { x: 0, y: 0, width: 120, height: 20 } })])
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].nodeId, 'i:1')
  assert.equal(findings[0].status, 'flag')
})

test('mixed pass and flag findings are both emitted', () => {
  const findings = runTouchTargetCheck(
    baseDTO([
      clickable({ id: 'c:1', bbox: { x: 0, y: 0, width: 24, height: 24 } }),
      clickable({ id: 'c:2', bbox: { x: 0, y: 0, width: 20, height: 24 } }),
    ])
  )
  assert.equal(findings.length, 2)
  assert.ok(findings.find(f => f.nodeId === 'c:1' && f.status === 'pass'))
  assert.ok(findings.find(f => f.nodeId === 'c:2' && f.status === 'flag'))
})

test('flag details carry shape metadata for the visual', () => {
  const findings = runTouchTargetCheck(
    baseDTO([
      clickable({
        nodeType: 'FRAME',
        cornerRadius: 999,
        bbox: { x: 0, y: 0, width: 20, height: 20 },
      }),
    ])
  )
  const d = findings[0].details as { nodeType?: string; cornerRadius?: number }
  assert.equal(d.nodeType, 'FRAME')
  assert.equal(d.cornerRadius, 999)
})
