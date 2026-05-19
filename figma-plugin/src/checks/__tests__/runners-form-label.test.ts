import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFormLabelCheck } from '../runners/form-label.ts'
import type { AuditDTO, FormInputElement } from '../../shared/dtos.ts'

const baseDTO = (formInputs: FormInputElement[]): AuditDTO => ({
  component: { id: '0:1', name: 'C', type: 'COMPONENT', width: 0, height: 0, pageId: 'p', pageName: 'P', modeName: null },
  texts: [],
  nonTextContrast: [],
  images: [],
  formInputs,
  clickables: [],
  variants: null,
  warnings: [],
})

const input = (over: Partial<FormInputElement>): FormInputElement => ({
  kind: 'form-input',
  id: over.id ?? 'i:1',
  name: over.name ?? 'Email',
  nodeType: over.nodeType ?? 'INSTANCE',
  cornerRadius: over.cornerRadius ?? 4,
  mainComponentName: over.mainComponentName ?? 'TextField',
  childTextNodes: over.childTextNodes ?? [],
  hasExternalLabel: over.hasExternalLabel ?? false,
  bbox: { x: 0, y: 0, width: 100, height: 40 },
})

test('hasExternalLabel: true → pass', () => {
  const f = runFormLabelCheck(baseDTO([input({ hasExternalLabel: true })]))
  assert.equal(f.length, 1)
  assert.equal(f[0].status, 'pass')
})

test('no text and no external label → flag "No label or placeholder"', () => {
  const f = runFormLabelCheck(baseDTO([input({ hasExternalLabel: false, childTextNodes: [] })]))
  assert.equal(f[0].status, 'flag')
  assert.match(f[0].message, /No label or placeholder/)
})

test('placeholder only (text inside input, no external label, no nested label) → flag', () => {
  const f = runFormLabelCheck(
    baseDTO([
      input({
        hasExternalLabel: false,
        childTextNodes: [{ id: 't:1', text: 'Email', isInsideInput: true, isLabel: false }],
      }),
    ])
  )
  assert.equal(f[0].status, 'flag')
  assert.match(f[0].message, /Placeholder only/)
})

test('text outside input even without external label → pass', () => {
  // Edge case: child text exists but isInsideInput=false (treated as associated label).
  const f = runFormLabelCheck(
    baseDTO([
      input({
        hasExternalLabel: false,
        childTextNodes: [{ id: 't:1', text: 'Email', isInsideInput: false, isLabel: false }],
      }),
    ])
  )
  assert.equal(f[0].status, 'pass')
})

test('nested label (isLabel=true) inside input → pass even without external sibling', () => {
  // Real-world pattern: form-input component bundles a "Title" text node
  // inside a "title container" frame. Geometrically inside the input but
  // semantically the label.
  const f = runFormLabelCheck(
    baseDTO([
      input({
        hasExternalLabel: false,
        childTextNodes: [
          { id: 't:1', text: 'Loan Amount', isInsideInput: true, isLabel: true },
          { id: 't:2', text: '2,00,000', isInsideInput: true, isLabel: false },
        ],
      }),
    ])
  )
  assert.equal(f[0].status, 'pass')
})

test('one finding per form input', () => {
  const f = runFormLabelCheck(
    baseDTO([
      input({ id: 'i:1', hasExternalLabel: true }),
      input({ id: 'i:2', hasExternalLabel: false, childTextNodes: [] }),
    ])
  )
  assert.equal(f.length, 2)
})

test('empty formInputs → no findings', () => {
  const f = runFormLabelCheck(baseDTO([]))
  assert.equal(f.length, 0)
})
