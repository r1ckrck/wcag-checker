import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildManualChecks } from '../manual.ts'
import type { AuditDTO } from '../../shared/dtos.ts'

const emptyDTO = (over: Partial<AuditDTO> = {}): AuditDTO => ({
  component: {
    id: '0:1',
    name: 'C',
    type: 'COMPONENT',
    width: 100,
    height: 50,
    pageId: '0:0',
    pageName: 'Page',
    modeName: null,
  },
  texts: [],
  nonTextContrast: [],
  images: [],
  formInputs: [],
  clickables: [],
  variants: null,
  warnings: [],
  ...over,
})

test('1.3.3 Sensory Characteristics is always applicable', () => {
  const items = buildManualChecks(emptyDTO())
  const item = items.find(m => m.criterion === '1.3.3')
  assert.ok(item)
  assert.equal(item?.applicable, true)
})

test('2.2.2 Auto-updating content is always applicable', () => {
  const items = buildManualChecks(emptyDTO())
  const item = items.find(m => m.criterion === '2.2.2')
  assert.ok(item)
  assert.equal(item?.applicable, true)
})

test('2.2.1 Timing Adjustable is always applicable', () => {
  const items = buildManualChecks(emptyDTO())
  const item = items.find(m => m.criterion === '2.2.1')
  assert.ok(item)
  assert.equal(item?.applicable, true)
})

test('2.5.1 Gestures & motion is always applicable', () => {
  const items = buildManualChecks(emptyDTO())
  const item = items.find(m => m.criterion === '2.5.1')
  assert.ok(item)
  assert.equal(item?.applicable, true)
})

test('dev-stage and dropped media criteria are not emitted', () => {
  const items = buildManualChecks(emptyDTO())
  for (const c of ['2.1.1', '1.4.13', '1.2.1', '2.3.1', '2.5.4']) {
    assert.equal(
      items.find(m => m.criterion === c),
      undefined,
      `${c} should not be emitted`
    )
  }
})

test('idempotent — same input yields same output', () => {
  const a = buildManualChecks(emptyDTO())
  const b = buildManualChecks(emptyDTO())
  assert.deepEqual(a, b)
})
