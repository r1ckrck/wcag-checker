import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  displayCodesForCriterion,
  standardsForCriterion,
} from '../findings-render.ts'

test('text-reflow displays multiple WCAG codes in the title row', () => {
  assert.deepEqual(displayCodesForCriterion('text-reflow'), ['1.4.4', '1.4.10', '1.4.12'])
})

test('standard WCAG criteria display their own code', () => {
  assert.deepEqual(displayCodesForCriterion('2.5.8'), ['2.5.8'])
})

test('non-WCAG typography criterion displays no code', () => {
  assert.deepEqual(displayCodesForCriterion('typography'), [])
})

// ── standardsForCriterion — by-reference cross-mapping (Rec A) ───────

test('a standard WCAG SC maps to WCAG + GIGW 3.0 §5.2 + IS 17802 web', () => {
  assert.deepEqual(standardsForCriterion('2.4.4'), [
    { standard: 'WCAG', clause: '2.4.4' },
    { standard: 'GIGW 3.0', clause: '§5.2' },
    { standard: 'IS 17802', clause: 'web' },
  ])
})

test('text-reflow maps its three WCAG SCs then GIGW + IS once', () => {
  assert.deepEqual(standardsForCriterion('text-reflow'), [
    { standard: 'WCAG', clause: '1.4.4' },
    { standard: 'WCAG', clause: '1.4.10' },
    { standard: 'WCAG', clause: '1.4.12' },
    { standard: 'GIGW 3.0', clause: '§5.2' },
    { standard: 'IS 17802', clause: 'web' },
  ])
})

test('non-WCAG criteria map to no standards', () => {
  assert.deepEqual(standardsForCriterion('typography'), [])
  assert.deepEqual(standardsForCriterion('visual-review'), [])
})
