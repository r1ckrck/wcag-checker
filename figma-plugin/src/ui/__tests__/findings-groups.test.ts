import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CRITERION_TO_GROUP,
  CRITERION_TITLES,
  GROUP_ORDER,
  GROUP_TITLES,
  buildGroupViews,
  groupForCriterion,
} from '../findings-groups.ts'
import type { Finding, FindingsReport, ManualCheckItem } from '../../checks/findings.ts'

const ALL_EMITTED_CRITERIA = [
  '1.3.3',
  '1.4.1',
  '1.4.3',
  '1.4.5',
  '1.4.11',
  'text-reflow',
  '2.2.1',
  '2.2.2',
  '2.4.4',
  '2.4.6',
  '2.4.7',
  '2.5.1',
  '2.5.8',
  '3.3.1',
  '3.3.2',
  '3.3.3',
] as const

const emptyReport = (over: Partial<FindingsReport> = {}): FindingsReport => ({
  passes: [],
  flags: [],
  unableToTest: [],
  manual: [],
  warnings: [],
  ...over,
})

const finding = (
  criterion: string,
  status: Finding['status'] = 'pass',
  name = 'Node'
): Finding => ({
  criterion,
  status,
  scope: 'element',
  nodeId: 'n1',
  nodeName: name,
  message: `${criterion} sample`,
})

const manual = (criterion: string, applicable = true): ManualCheckItem => ({
  criterion,
  name: 'Item',
  applicable,
  hint: 'Verify',
})

test('every emitted criterion maps to a non-other group', () => {
  for (const c of ALL_EMITTED_CRITERIA) {
    const g = groupForCriterion(c)
    assert.notEqual(g, 'other', `${c} should not fall into 'other'`)
  }
})

test('every emitted criterion has a plain-English title', () => {
  for (const c of ALL_EMITTED_CRITERIA) {
    assert.ok(CRITERION_TITLES[c], `${c} missing CRITERION_TITLES entry`)
    assert.ok(CRITERION_TITLES[c].length > 0)
  }
})

test('CRITERION_TO_GROUP has each criterion in exactly one group', () => {
  // The shape itself enforces single-group (object, one key per criterion);
  // assert no duplicate keys leaked via the object literal by counting.
  const codes = Object.keys(CRITERION_TO_GROUP)
  assert.equal(codes.length, new Set(codes).size)
})

test('unknown criterion falls back to other', () => {
  const g = groupForCriterion('9.9.9')
  assert.equal(g, 'other')
})

test('GROUP_ORDER includes all 7 group ids exactly once', () => {
  assert.equal(GROUP_ORDER.length, 7)
  assert.equal(new Set(GROUP_ORDER).size, 7)
  for (const id of GROUP_ORDER) {
    assert.ok(GROUP_TITLES[id], `${id} missing title`)
  }
})

test('interaction-states group is gone', () => {
  assert.equal(GROUP_ORDER.includes('interaction-states' as never), false)
  assert.equal(GROUP_TITLES['interaction-states' as never], undefined)
})

test('motion-time-media group is gone', () => {
  assert.equal(GROUP_ORDER.includes('motion-time-media' as never), false)
  assert.equal(GROUP_TITLES['motion-time-media' as never], undefined)
})

test('2.4.7 is now in forms-errors group', () => {
  assert.equal(groupForCriterion('2.4.7'), 'forms-errors')
})

test('2.4.4 and 2.5.8 are in interactive elements group', () => {
  assert.equal(groupForCriterion('2.4.4'), 'content-links')
  assert.equal(groupForCriterion('2.5.8'), 'content-links')
  assert.equal(GROUP_TITLES['content-links'], 'Interactive elements')
})

test('2.4.6 is in content & labels group', () => {
  assert.equal(groupForCriterion('2.4.6'), 'content-labels')
  assert.equal(GROUP_TITLES['content-labels'], 'Content & labels')
  assert.equal(CRITERION_TITLES['2.4.6'], 'Headings and Labels')
})

test('text-reflow is in typography group', () => {
  assert.equal(groupForCriterion('text-reflow'), 'typography')
  assert.equal(CRITERION_TITLES['text-reflow'], 'Text Reflow')
})

test('1.4.13 and 2.1.1 are no longer mapped (fall back to other)', () => {
  assert.equal(groupForCriterion('1.4.13'), 'other')
  assert.equal(groupForCriterion('2.1.1'), 'other')
})

test('media criteria are no longer mapped (now bottom-note manual items)', () => {
  // 1.2.1, 2.3.1, 2.5.4 dropped entirely; 2.2.1, 2.2.2 and 2.5.1 are
  // surfaced as manual items in the bottom note (mapped to inclusive-instructions
  // so they have a home in groupForCriterion, but the group card is suppressed).
  assert.equal(groupForCriterion('1.2.1'), 'other')
  assert.equal(groupForCriterion('2.3.1'), 'other')
  assert.equal(groupForCriterion('2.5.4'), 'other')
  assert.equal(groupForCriterion('2.2.1'), 'inclusive-instructions')
  assert.equal(groupForCriterion('2.2.2'), 'inclusive-instructions')
  assert.equal(groupForCriterion('2.5.1'), 'inclusive-instructions')
})

test('buildGroupViews returns groups in fixed order, omits empty', () => {
  const report = emptyReport({
    passes: [finding('1.4.3', 'pass', 'Body text')],
    flags: [finding('3.3.2', 'flag', 'Email field')],
    manual: [manual('1.3.3')],
  })
  const groups = buildGroupViews(report)
  // Three groups: color-contrast, forms-errors, inclusive-instructions
  assert.equal(groups.length, 3)
  assert.deepEqual(
    groups.map(g => g.id),
    ['color-contrast', 'forms-errors', 'inclusive-instructions']
  )
})

test('buildGroupViews bins findings into pass/flag/toVerify correctly', () => {
  const report = emptyReport({
    passes: [finding('typography', 'pass', 'P1')],
    flags: [finding('typography', 'flag', 'F1')],
    unableToTest: [finding('1.4.5', 'unable-to-test', 'U1')],
    manual: [manual('1.3.3')],
  })
  const groups = buildGroupViews(report)
  const typo = groups.find(g => g.id === 'typography')
  assert.ok(typo)
  assert.equal(typo!.passed.length, 1)
  assert.equal(typo!.flagged.length, 1)
  assert.equal(typo!.toVerify.length, 1)
  assert.equal(typo!.toVerify[0].kind, 'finding')

  const incl = groups.find(g => g.id === 'inclusive-instructions')
  assert.ok(incl)
  assert.equal(incl!.toVerify.length, 1)
  assert.equal(incl!.toVerify[0].kind, 'manual')
})

test('non-applicable manual items are omitted', () => {
  const report = emptyReport({
    manual: [manual('1.3.3', false), manual('2.2.2', true)],
  })
  const groups = buildGroupViews(report)
  // 2.2.2 maps to inclusive-instructions (the renderer suppresses that group
  // card; the manual item appears in the bottom note instead). For the pure
  // grouping logic we just confirm it lands in inclusive-instructions.
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'inclusive-instructions')
  assert.equal(groups[0].toVerify.length, 1)
})

test('empty report yields no groups', () => {
  const groups = buildGroupViews(emptyReport())
  assert.equal(groups.length, 0)
})

test('unknown criterion routes to other group view', () => {
  const report = emptyReport({
    flags: [finding('9.9.9', 'flag', 'mystery')],
  })
  const groups = buildGroupViews(report)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].id, 'other')
  assert.equal(groups[0].flagged.length, 1)
})

test('total counts match the input report (no duplication, no loss)', () => {
  const report = emptyReport({
    passes: [finding('1.4.3'), finding('typography'), finding('3.3.2')],
    flags: [finding('1.4.11', 'flag'), finding('2.4.7', 'flag')],
    unableToTest: [finding('1.4.5', 'unable-to-test')],
    manual: [manual('1.3.3'), manual('2.2.2'), manual('2.5.1', false)],
  })
  const groups = buildGroupViews(report)
  const totalPassed = groups.reduce((n, g) => n + g.passed.length, 0)
  const totalFlagged = groups.reduce((n, g) => n + g.flagged.length, 0)
  const totalToVerify = groups.reduce((n, g) => n + g.toVerify.length, 0)
  assert.equal(totalPassed, 3)
  assert.equal(totalFlagged, 2)
  // 1 unable-to-test + 2 applicable manual (the non-applicable item is skipped)
  assert.equal(totalToVerify, 3)
})
