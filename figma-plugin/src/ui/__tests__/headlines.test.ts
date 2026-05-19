import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headlineFor } from '../headlines.ts'
import type { Finding } from '../../checks/findings.ts'

const flag = (criterion: string, message: string, details?: Record<string, unknown>): Finding => ({
  criterion,
  status: 'flag',
  scope: 'element',
  nodeId: 'n',
  nodeName: 'Test',
  message,
  details,
})

test('1.4.3 / 1.4.11 → static headlines', () => {
  assert.equal(headlineFor(flag('1.4.3', 'Contrast 2.1:1 — needs ≥4.5:1 (font 14px, weight 500).')), 'Low text contrast')
  assert.equal(headlineFor(flag('1.4.11', 'Contrast 2.4:1 — needs ≥3:1 (raw).')), 'Low element contrast')
})

test('1.4.5 → static headline', () => {
  assert.equal(headlineFor(flag('1.4.5', 'Image "hero.png" — name suggests text content.')), 'Possible image of text')
})

test('typography → property-aware headline', () => {
  assert.equal(
    headlineFor(flag('typography', 'line-height 60% (needs ≥75%).', { property: 'line-height' })),
    'Tight line height'
  )
  assert.equal(
    headlineFor(flag('typography', 'letter-spacing -10% (needs ≥-6%).', { property: 'letter-spacing' })),
    'Tight letter spacing'
  )
  assert.equal(
    headlineFor(flag('typography', 'paragraph-spacing 40% (needs ≥80%).', { property: 'paragraph-spacing' })),
    'Tight paragraph spacing'
  )
})

test('3.3.2 → label/placeholder discriminator', () => {
  assert.equal(headlineFor(flag('3.3.2', 'No label or placeholder.')), 'No label or placeholder')
  assert.equal(headlineFor(flag('3.3.2', 'Placeholder only — no visible label.')), 'Placeholder used as label')
})

test('2.5.8 → static headline', () => {
  assert.equal(headlineFor(flag('2.5.8', 'Target is 16 × 24 px.')), 'Small touch target')
})

test('2.4.6 → source-based discriminator', () => {
  assert.equal(
    headlineFor(flag('2.4.6', 'Label "Text 1" looks like a placeholder.', { source: 'form-label' })),
    'Label looks like a placeholder'
  )
  assert.equal(
    headlineFor(flag('2.4.6', 'Link text "Button" looks like a placeholder.', { source: 'clickable' })),
    'Link text looks like a placeholder'
  )
})

test('1.4.1 → use-of-color discriminator', () => {
  assert.equal(
    headlineFor(flag('1.4.1', 'No error variant designed.')),
    'No error variant found'
  )
  assert.equal(
    headlineFor(flag('1.4.1', 'Error state uses color alone — add a non-color indicator.')),
    'Color-only error indicator'
  )
})

test('2.4.7 → focus-visible discriminator', () => {
  assert.equal(
    headlineFor(flag('2.4.7', 'No focus variant designed.')),
    'No focus variant found'
  )
  assert.equal(
    headlineFor(flag('2.4.7', 'Focus variant has no visible difference from default.')),
    'Focus state visually identical to default'
  )
})

test('3.3.1 → error-identification discriminator', () => {
  assert.equal(
    headlineFor(flag('3.3.1', 'Error state has no message text.')),
    'No error message text'
  )
  assert.equal(
    headlineFor(flag('3.3.1', 'Error state has text but relies on color alone for visual identification.')),
    'Error relies on color alone'
  )
})

test('3.3.3 → error-suggestion discriminator', () => {
  assert.equal(
    headlineFor(flag('3.3.3', 'No error message text to evaluate.')),
    'No error message text'
  )
  assert.equal(
    headlineFor(flag('3.3.3', 'Error message looks vague — add specific guidance. Found: "Invalid input".')),
    'Vague error message'
  )
})

test('text-reflow → fixed headline', () => {
  assert.equal(headlineFor(flag('text-reflow', 'Text reflow — fixed-height text box may clip resized or spaced text.')), 'Text may not reflow')
})

test('unknown criterion → falls back to message', () => {
  assert.equal(headlineFor(flag('99.99', 'something custom')), 'something custom')
})
