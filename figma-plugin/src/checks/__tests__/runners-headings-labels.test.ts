import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isRejected,
  matchesPlaceholder,
  runHeadingsLabelsCheck,
} from '../runners/headings-labels.ts'
import type {
  AuditDTO,
  ClickableElement,
  FormInputElement,
  FormInputChildText,
  TextElement,
} from '../../shared/dtos.ts'

// ── Fixtures ────────────────────────────────────────────────────────

const baseDTO = (
  over: Partial<Pick<AuditDTO, 'clickables' | 'formInputs' | 'texts'>> = {}
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
  texts: over.texts ?? [],
  nonTextContrast: [],
  images: [],
  formInputs: over.formInputs ?? [],
  clickables: over.clickables ?? [],
  variants: null,
  warnings: [],
})

const text = (over: Partial<TextElement> = {}): TextElement => ({
  kind: 'text',
  id: over.id ?? 't:1',
  name: over.name ?? 'text',
  characters: over.characters ?? '',
  textAutoResize: over.textAutoResize ?? 'WIDTH_AND_HEIGHT',
  isSingleLine: over.isSingleLine ?? true,
  isSingleVisualLine: over.isSingleVisualLine ?? true,
  paragraphSpacingPx: over.paragraphSpacingPx ?? null,
  segments: over.segments ?? [],
  background: over.background ?? { kind: 'unresolvable', reason: 'no-ancestor' },
  bbox: over.bbox ?? { x: 0, y: 0, width: 100, height: 20 },
  parentChain: over.parentChain ?? [],
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

const childText = (over: Partial<FormInputChildText> = {}): FormInputChildText => ({
  id: over.id ?? 't:1',
  text: over.text ?? '',
  isInsideInput: over.isInsideInput ?? false,
  isLabel: over.isLabel ?? true,
})

const formInput = (over: Partial<FormInputElement> = {}): FormInputElement => ({
  kind: 'form-input',
  id: over.id ?? 'fi:1',
  name: over.name ?? 'Input',
  nodeType: over.nodeType ?? 'INSTANCE',
  cornerRadius: over.cornerRadius ?? 4,
  mainComponentName: over.mainComponentName ?? 'Input',
  childTextNodes: over.childTextNodes ?? [],
  hasExternalLabel: over.hasExternalLabel ?? false,
  bbox: over.bbox ?? { x: 0, y: 0, width: 300, height: 40 },
})

// ── matchesPlaceholder — pattern coverage ───────────────────────────

test('pattern 1 — empty / whitespace flags', () => {
  assert.equal(matchesPlaceholder('').matched, true)
  assert.equal(matchesPlaceholder('   ').matched, true)
})

test('pattern 2 — single letter flags, single symbol does not', () => {
  assert.equal(matchesPlaceholder('A').matched, true)
  assert.equal(matchesPlaceholder('x').matched, true)
  assert.equal(matchesPlaceholder('→').matched, false)
  assert.equal(matchesPlaceholder('&').matched, false)
  assert.equal(matchesPlaceholder('7').matched, false)
})

test('pattern 3 — pure punctuation (2+ chars) flags', () => {
  assert.equal(matchesPlaceholder('---').matched, true)
  assert.equal(matchesPlaceholder('...').matched, true)
  assert.equal(matchesPlaceholder('___').matched, true)
  assert.equal(matchesPlaceholder('OK!').matched, false)
})

test('pattern 4 — generic UI nouns flag with or without trailing number', () => {
  for (const s of ['Button', 'Btn', 'Link', 'Label', 'Field', 'Input', 'Text', 'Heading', 'Title', 'Placeholder', 'Untitled']) {
    assert.equal(matchesPlaceholder(s).matched, true, s)
  }
  assert.equal(matchesPlaceholder('Text 1').matched, true)
  assert.equal(matchesPlaceholder('Text 12').matched, true)
  assert.equal(matchesPlaceholder('Buttons').matched, false) // extra 's'
  assert.equal(matchesPlaceholder('Text field').matched, false)
})

test('pattern 4 — expanded keywords flag', () => {
  for (const s of [
    'Subheading',
    'Subhead',
    'Subtitle',
    'Header',
    'Footer',
    'Caption',
    'Body',
    'Paragraph',
    'Description',
    'Copy',
    'Content',
  ]) {
    assert.equal(matchesPlaceholder(s).matched, true, s)
  }
})

test('pattern 4 — "Heading 2024" flags (digit suffix allowed any length)', () => {
  const m = matchesPlaceholder('Heading 2024')
  assert.equal(m.matched, true)
  assert.equal(m.pattern, 'generic-ui-noun')
})

test('pattern 5 — H1–H6 heading shorthand flags', () => {
  for (const s of ['H1', 'h2', 'H3', 'h4', 'H5', 'h6']) {
    assert.equal(matchesPlaceholder(s).matched, true, s)
  }
  assert.equal(matchesPlaceholder('H7').matched, false)
  assert.equal(matchesPlaceholder('H1 hero').matched, false)
})

test('pattern 6 — Lorem anywhere (word-boundary substring) flags', () => {
  assert.equal(matchesPlaceholder('Lorem').matched, true)
  assert.equal(matchesPlaceholder('lorem').matched, true)
  assert.equal(matchesPlaceholder('Lorem ipsum dolor sit amet').matched, true)
  assert.equal(matchesPlaceholder('Welcome to lorem section').matched, true)
  assert.equal(matchesPlaceholder('<lorem placeholder>').matched, true)
})

test('pattern 6 — "florem" / "loremly" do NOT match (word boundary protects)', () => {
  assert.equal(matchesPlaceholder('florem').matched, false)
  assert.equal(matchesPlaceholder('loremly').matched, false)
})

test('pattern 7 — dummy copy flags', () => {
  for (const s of ['xxx', 'XXXX', 'asdf', 'tbd', 'TODO', 'test', 'Temp', 'dummy', 'sample', 'foo', 'bar', 'baz']) {
    assert.equal(matchesPlaceholder(s).matched, true, s)
  }
})

test('matchedPattern name surfaces in result', () => {
  assert.equal(matchesPlaceholder('Button').pattern, 'generic-ui-noun')
  assert.equal(matchesPlaceholder('Lorem').pattern, 'lorem')
  assert.equal(matchesPlaceholder('A').pattern, 'single-letter')
  assert.equal(matchesPlaceholder('Submit').pattern, null)
})

test('real copy does not match', () => {
  for (const s of ['Submit', 'Forgot password?', 'Continue with Google', 'View calendar', 'Apply for personal loan', 'OK!']) {
    assert.equal(matchesPlaceholder(s).matched, false, s)
  }
})

test('casing variants all flag', () => {
  for (const s of ['BUTTON', 'button', 'Button', 'BuTtOn']) {
    assert.equal(matchesPlaceholder(s).matched, true, s)
  }
})

// ── Runner — clickables ─────────────────────────────────────────────

test('clickable with placeholder text → flag', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ clickables: [clickable({ textRaw: 'Button', textNormalized: 'button' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  assert.equal(findings[0].criterion, '2.4.6')
  const d = findings[0].details as { source?: string; matchedPattern?: string; text?: string; severity?: string }
  assert.equal(d.source, 'clickable')
  assert.equal(d.matchedPattern, 'generic-ui-noun')
  assert.equal(d.text, 'Button')
  assert.equal(d.severity, 'warning')
})

test('clickable with descriptive text → pass', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ clickables: [clickable({ textRaw: 'Submit', textNormalized: 'submit' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'pass')
})

test('clickable "Click here" does NOT trigger 2.4.6 (2.4.4 territory)', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ clickables: [clickable({ textRaw: 'Click here', textNormalized: 'click here' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'pass')
})

test('icon-only clickable (empty textNormalized) → no finding', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ clickables: [clickable({ textRaw: '', textNormalized: '' })] })
  )
  assert.equal(findings.length, 0)
})

test('flag message quotes the trimmed text', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ clickables: [clickable({ textRaw: '  Text 1  ', textNormalized: 'text 1' })] })
  )
  assert.match(findings[0].message, /"Text 1"/)
})

// ── Runner — form inputs ────────────────────────────────────────────

test('form input label with placeholder text → flag', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      formInputs: [
        formInput({
          childTextNodes: [childText({ text: 'Label', isLabel: true })],
        }),
      ],
    })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  const d = findings[0].details as { source?: string }
  assert.equal(d.source, 'form-label')
})

test('form input label with real text → pass', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      formInputs: [
        formInput({
          childTextNodes: [childText({ text: 'Email address', isLabel: true })],
        }),
      ],
    })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'pass')
})

test('non-label child text nodes are ignored', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      formInputs: [
        formInput({
          childTextNodes: [
            childText({ id: 't:1', text: 'Button', isLabel: false }), // placeholder text but not a label
          ],
        }),
      ],
    })
  )
  assert.equal(findings.length, 0)
})

test('empty form input label → flag (empty pattern)', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      formInputs: [
        formInput({
          childTextNodes: [childText({ text: '   ', isLabel: true })],
        }),
      ],
    })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  const d = findings[0].details as { matchedPattern?: string }
  assert.equal(d.matchedPattern, 'empty')
})

// ── Mixed / aggregate behavior ──────────────────────────────────────

test('mixed clickables + form inputs produce findings from both', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      clickables: [
        clickable({ id: 'c:1', textRaw: 'Button', textNormalized: 'button' }),
        clickable({ id: 'c:2', textRaw: 'Submit', textNormalized: 'submit' }),
      ],
      formInputs: [
        formInput({
          id: 'fi:1',
          childTextNodes: [childText({ id: 't:1', text: 'Lorem', isLabel: true })],
        }),
      ],
    })
  )
  // 2 clickable findings (one flag, one pass) + 1 form-label flag = 3 total
  assert.equal(findings.length, 3)
  const flags = findings.filter(f => f.status === 'flag')
  const passes = findings.filter(f => f.status === 'pass')
  assert.equal(flags.length, 2)
  assert.equal(passes.length, 1)
})

test('empty DTO → no findings', () => {
  const findings = runHeadingsLabelsCheck(baseDTO())
  assert.equal(findings.length, 0)
})

// ── Reject list (isRejected helper) ─────────────────────────────────

test('reject — numeric-only', () => {
  for (const s of ['42', '1,250', '0.95', '123 456']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — currency / percent', () => {
  for (const s of ['$99', '₹500', '12.5%', '€1.20']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — version / code strings', () => {
  for (const s of ['v1.0', '1.2.3', '#3076', 'vol. 2', 'vol 2']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — URL / email / @handle', () => {
  for (const s of [
    'https://example.com',
    'http://example.com/path',
    'www.example.com',
    'example.com',
    'user@host.com',
    '@username',
  ]) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — date-ish strings', () => {
  for (const s of ['01/01/2025', '2025-01-01', '15-05-2025', 'Jan 2025', 'January 2025', '15 May', '15 Sep']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — time strings', () => {
  for (const s of ['10:30', '10:30 AM', '14:00', '08:15:30']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — common short legitimate words (case-insensitive)', () => {
  for (const s of ['OK', 'ok', 'Yes', 'No', 'Edit', 'Save', 'Done', 'Search', 'Cancel', 'More', 'Top']) {
    assert.equal(isRejected(s), true, s)
  }
})

test('reject — real copy is NOT rejected', () => {
  for (const s of ['Submit', 'Welcome back', 'Apply for personal loan', 'Forgot password?', 'Heading 2024']) {
    assert.equal(isRejected(s), false, s)
  }
})

test('reject — empty / whitespace passes through (no reject, so flag rule decides)', () => {
  assert.equal(isRejected(''), false)
  assert.equal(isRejected('   '), false)
})

// ── Runner — text-node path ─────────────────────────────────────────

test('text node with placeholder content → flag (text-node source)', () => {
  // The user's reproducer: text layer named "title" containing "heading".
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ id: 't:1', name: 'title', characters: 'heading' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  assert.equal(findings[0].criterion, '2.4.6')
  const d = findings[0].details as { source?: string; matchedPattern?: string }
  assert.equal(d.source, 'text-node')
  assert.equal(d.matchedPattern, 'generic-ui-noun')
})

test('text node with Lorem ipsum content → flag', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'Lorem ipsum dolor sit amet' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  const d = findings[0].details as { matchedPattern?: string }
  assert.equal(d.matchedPattern, 'lorem')
})

test('text node containing the word "lorem" anywhere → flag', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'Welcome to lorem section' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
})

test('text node "Heading 2024" → flag', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'Heading 2024' })] })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
})

test('text node with real descriptive copy → NO finding (no per-element pass)', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'Welcome back' })] })
  )
  assert.equal(findings.length, 0)
})

test('text node with rejected content (price) → NO finding', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: '₹500' })] })
  )
  assert.equal(findings.length, 0)
})

test('text node with rejected content (date) → NO finding', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: '01/01/2025' })] })
  )
  assert.equal(findings.length, 0)
})

test('text node with rejected short word "OK" → NO finding', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'OK' })] })
  )
  assert.equal(findings.length, 0)
})

test('text node with "florem" (Lorem substring guard) → NO finding', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({ texts: [text({ characters: 'florem' })] })
  )
  assert.equal(findings.length, 0)
})

test('text-node path emits flags only (no per-element passes)', () => {
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      texts: [
        text({ id: 't:1', characters: 'Welcome back' }), // real copy → no finding
        text({ id: 't:2', characters: 'heading' }), // placeholder → flag
        text({ id: 't:3', characters: 'Apply now' }), // real copy → no finding
      ],
    })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'flag')
  assert.equal(findings[0].nodeId, 't:2')
})

// ── Regression: clickable + form-label paths unaffected by reject list ──

test('clickable with numeric text "42" → NOT pre-rejected (reject list is text-node only)', () => {
  // "42" isn't in the placeholder list anyway, so it should pass (not flag).
  // The point of this test: a clickable named "42" runs the placeholder check
  // and emits a pass — the reject list never short-circuits the clickable path.
  const findings = runHeadingsLabelsCheck(
    baseDTO({
      clickables: [
        {
          kind: 'clickable',
          id: 'c:1',
          name: 'Btn',
          nodeType: 'INSTANCE',
          cornerRadius: 0,
          componentName: 'Button',
          textRaw: '42',
          textNormalized: '42',
          signals: ['component-name'],
          bbox: { x: 0, y: 0, width: 50, height: 50 },
        },
      ],
    })
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'pass') // confirms it ran the placeholder check, didn't short-circuit
})
