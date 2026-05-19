import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLinkPurposeCheck } from '../runners/link-purpose.ts'
import type { AuditDTO, ClickableElement } from '../../shared/dtos.ts'

const baseDTO = (clickables: ClickableElement[]): AuditDTO => ({
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
  formInputs: [],
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
  textRaw: over.textRaw ?? '',
  textNormalized: over.textNormalized ?? '',
  signals: over.signals ?? ['component-name'],
  bbox: over.bbox ?? { x: 0, y: 0, width: 100, height: 40 },
})

// ── Vague-text flags ────────────────────────────────────────────────

test('"Read more" → flag', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Read more', textNormalized: 'read more' })])
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  assert.equal(findings[0].criterion, '2.4.4')
})

test('"Click here" → flag', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Click here', textNormalized: 'click here' })])
  )
  assert.equal(findings[0].status, 'flag')
})

test('"Learn more" → flag', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Learn more', textNormalized: 'learn more' })])
  )
  assert.equal(findings[0].status, 'flag')
})

test('"Here" alone → flag', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Here', textNormalized: 'here' })])
  )
  assert.equal(findings[0].status, 'flag')
})

test('flag carries warning severity in details', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Read more', textNormalized: 'read more' })])
  )
  const d = findings[0].details as { severity?: string }
  assert.equal(d.severity, 'warning')
})

test('flag message quotes the raw text', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'READ MORE →', textNormalized: 'read more' })])
  )
  assert.match(findings[0].message, /READ MORE/)
})

// ── Descriptive text passes ─────────────────────────────────────────

test('"Read more about home loans" → pass', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([
      clickable({
        textRaw: 'Read more about home loans',
        textNormalized: 'read more about home loans',
      }),
    ])
  )
  assert.equal(findings[0].status, 'pass')
})

test('"Submit" → pass (not a vague phrase)', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'Submit', textNormalized: 'submit' })])
  )
  assert.equal(findings[0].status, 'pass')
})

test('"View calendar" → pass', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: 'View calendar', textNormalized: 'view calendar' })])
  )
  assert.equal(findings[0].status, 'pass')
})

// ── Icon-only clickables are skipped ────────────────────────────────

test('empty normalized text → no finding emitted', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([clickable({ textRaw: '', textNormalized: '' })])
  )
  assert.equal(findings.length, 0)
})

// ── Multiple elements ───────────────────────────────────────────────

test('mixed pass + flag in one DTO', () => {
  const findings = runLinkPurposeCheck(
    baseDTO([
      clickable({
        id: 'c:1',
        textRaw: 'Read more',
        textNormalized: 'read more',
      }),
      clickable({
        id: 'c:2',
        textRaw: 'Apply for personal loan',
        textNormalized: 'apply for personal loan',
      }),
    ])
  )
  assert.equal(findings.length, 2)
  const flag = findings.find(f => f.status === 'flag')
  const pass = findings.find(f => f.status === 'pass')
  assert.ok(flag)
  assert.ok(pass)
  assert.equal(flag?.nodeId, 'c:1')
  assert.equal(pass?.nodeId, 'c:2')
})

test('empty DTO → no findings', () => {
  const findings = runLinkPurposeCheck(baseDTO([]))
  assert.equal(findings.length, 0)
})
