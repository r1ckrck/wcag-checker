import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTextReflowCheck } from '../runners/text-reflow.ts'
import type { AuditDTO, TextElement, TextSegment, ResolvedFill } from '../../shared/dtos.ts'

const fill = (): ResolvedFill => ({
  hex: '#000000',
  rgba: [0, 0, 0, 1],
  source: { kind: 'raw' },
})

const segment = (): TextSegment => ({
  start: 0,
  end: 5,
  fontFamily: 'Inter',
  fontStyle: 'Regular',
  fontWeight: 400,
  fontSize: 14,
  lineHeightUnit: 'PIXELS',
  lineHeightPx: 21,
  letterSpacingPx: 0,
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  fill: fill(),
})

const text = (over: Partial<TextElement> = {}): TextElement => ({
  kind: 'text',
  id: over.id ?? 't:1',
  name: over.name ?? 'Body',
  characters: over.characters ?? 'Hello',
  textAutoResize: over.textAutoResize ?? 'HEIGHT',
  isSingleLine: over.isSingleLine ?? true,
  isSingleVisualLine: over.isSingleVisualLine ?? true,
  paragraphSpacingPx: over.paragraphSpacingPx ?? 16,
  segments: over.segments ?? [segment()],
  background: { kind: 'unresolvable', reason: 'no-ancestor' },
  bbox: over.bbox ?? { x: 0, y: 0, width: 100, height: 20 },
  parentChain: over.parentChain ?? [],
})

const dto = (texts: TextElement[]): AuditDTO => ({
  component: { id: '0:1', name: 'C', type: 'COMPONENT', width: 0, height: 0, pageId: 'p', pageName: 'P', modeName: null },
  texts,
  nonTextContrast: [],
  images: [],
  formInputs: [],
  clickables: [],
  variants: null,
  warnings: [],
})

test('NONE flags as fixed-height text', () => {
  const findings = runTextReflowCheck(dto([text({ textAutoResize: 'NONE' })]))
  assert.equal(findings[0].criterion, 'text-reflow')
  assert.equal(findings[0].status, 'flag')
})

test('TRUNCATE flags as fixed-height text', () => {
  const findings = runTextReflowCheck(dto([text({ textAutoResize: 'TRUNCATE' })]))
  assert.equal(findings[0].status, 'flag')
})

test('HEIGHT passes because height can grow', () => {
  const findings = runTextReflowCheck(dto([text({ textAutoResize: 'HEIGHT' })]))
  assert.equal(findings[0].status, 'pass')
})

test('WIDTH_AND_HEIGHT passes because height can grow', () => {
  const findings = runTextReflowCheck(dto([text({ textAutoResize: 'WIDTH_AND_HEIGHT' })]))
  assert.equal(findings[0].status, 'pass')
})

test('mixed pass and flag findings are both emitted', () => {
  const findings = runTextReflowCheck(dto([
    text({ id: 't:1', textAutoResize: 'HEIGHT' }),
    text({ id: 't:2', textAutoResize: 'NONE' }),
  ]))
  assert.ok(findings.find(f => f.nodeId === 't:1' && f.status === 'pass'))
  assert.ok(findings.find(f => f.nodeId === 't:2' && f.status === 'flag'))
})
