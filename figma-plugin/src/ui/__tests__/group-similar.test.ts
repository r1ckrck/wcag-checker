import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSimilar } from '../group-similar.ts'
import type { Finding } from '../../checks/findings.ts'

const flag = (
  criterion: string,
  nodeId: string,
  nodeName: string,
  details: Record<string, unknown> = {}
): Finding => ({
  criterion,
  status: 'flag',
  scope: 'element',
  nodeId,
  nodeName,
  message: 'm',
  details,
})

test('1.4.3 — identical actual+required collapses', () => {
  const findings = [
    flag('1.4.3', 'a', 'Forgot password?', { actual: 2.1, required: 4.5 }),
    flag('1.4.3', 'b', 'Submit',           { actual: 2.1, required: 4.5 }),
    flag('1.4.3', 'c', 'Other',            { actual: 3.0, required: 4.5 }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
  assert.deepEqual(
    groups[0].nodes.map(n => n.name),
    ['Forgot password?', 'Submit']
  )
  assert.equal(groups[1].members.length, 1)
})

test('1.4.11 — same numeric tuple collapses across nodes', () => {
  const findings = [
    flag('1.4.11', 'a', 'Btn 1', { actual: 2.4, required: 3 }),
    flag('1.4.11', 'b', 'Btn 2', { actual: 2.4, required: 3 }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].nodes.length, 2)
})

test('typography — same property+actual+required collapses', () => {
  const findings = [
    flag('typography', 'a', 'Body', { property: 'line-height', actual: '60%', required: '≥75%' }),
    flag('typography', 'b', 'Caption', { property: 'line-height', actual: '60%', required: '≥75%' }),
    flag('typography', 'c', 'Other', { property: 'letter-spacing', actual: '-10%', required: '≥-6%' }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
})

test('3.3.2 — same flag message collapses', () => {
  const findings = [
    flag('3.3.2', 'a', 'Email', {}),
    flag('3.3.2', 'b', 'Password', {}),
  ]
  // Both have identical message "m" → collapse.
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 1)
})

test('text-reflow — same resize mode collapses', () => {
  const findings = [
    flag('text-reflow', 'a', 'Body', { textAutoResize: 'NONE' }),
    flag('text-reflow', 'b', 'Caption', { textAutoResize: 'NONE' }),
    flag('text-reflow', 'c', 'Deprecated', { textAutoResize: 'TRUNCATE' }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
})

test('2.4.6 — same offending text collapses (case-insensitive)', () => {
  const findings = [
    flag('2.4.6', 'a', 'Btn 1', { text: 'Button', source: 'clickable' }),
    flag('2.4.6', 'b', 'Btn 2', { text: 'button', source: 'clickable' }),
    flag('2.4.6', 'c', 'Other', { text: 'Text 1', source: 'clickable' }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
  assert.deepEqual(groups[0].nodes.map(n => n.name), ['Btn 1', 'Btn 2'])
  assert.equal(groups[1].members.length, 1)
})

test('2.4.6 — missing text stays singleton', () => {
  const findings = [
    flag('2.4.6', 'a', 'A', {}),
    flag('2.4.6', 'b', 'B', {}),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
})

test('2.5.8 — same target dimensions collapse', () => {
  const findings = [
    flag('2.5.8', 'a', 'Icon 1', { width: 16, height: 16, required: 24 }),
    flag('2.5.8', 'b', 'Icon 2', { width: 16, height: 16, required: 24 }),
    flag('2.5.8', 'c', 'Short button', { width: 48, height: 16, required: 24 }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
  assert.deepEqual(groups[0].nodes.map(n => n.name), ['Icon 1', 'Icon 2'])
})

test('Variant findings always stay singleton', () => {
  const findings = [
    flag('1.4.1', null as unknown as string, 'C', {}),
    flag('1.4.1', null as unknown as string, 'C', {}),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
})

test('Order of groups follows first appearance', () => {
  const findings = [
    flag('1.4.3', 'a', 'A', { actual: 1, required: 4.5 }),
    flag('1.4.3', 'b', 'B', { actual: 2, required: 4.5 }),
    flag('1.4.3', 'c', 'C', { actual: 1, required: 4.5 }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].members.map(m => m.nodeName), ['A', 'C'])
  assert.deepEqual(groups[1].members.map(m => m.nodeName), ['B'])
})

test('Findings with non-numeric actual/required stay singleton (key returns null)', () => {
  const findings = [
    flag('1.4.3', 'a', 'A', { actual: 'unknown' }),
    flag('1.4.3', 'b', 'B', { actual: 'unknown' }),
  ]
  const groups = groupSimilar(findings)
  assert.equal(groups.length, 2)
})
