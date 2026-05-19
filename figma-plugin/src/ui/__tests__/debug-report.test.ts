import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDebugReport } from '../debug-report.ts'
import type { AuditDTO, BackgroundSample, ResolvedFill, TextElement } from '../../shared/dtos.ts'
import type { FindingsReport } from '../../checks/findings.ts'

const META = { pluginVersion: '0.0.1', generatedAt: '2026-05-08T12:00:00Z' }

const emptyDTO = (over: Partial<AuditDTO> = {}): AuditDTO => ({
  component: {
    id: '0:1',
    name: 'Test',
    type: 'COMPONENT',
    width: 100,
    height: 50,
    pageId: '0:0',
    pageName: 'Page 1',
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

const emptyFindings = (over: Partial<FindingsReport> = {}): FindingsReport => ({
  passes: [],
  flags: [],
  unableToTest: [],
  manual: [
    { criterion: '1.3.3', name: 'Sensory Characteristics', applicable: true, hint: 'Verify…' },
  ],
  warnings: [],
  ...over,
})

const fill = (hex: string): ResolvedFill => ({
  hex,
  rgba: [0, 0, 0, 1],
  source: { kind: 'raw' },
})

const solidBg = (hex: string): BackgroundSample => ({
  kind: 'solid',
  hex,
  rgba: [255, 255, 255, 1],
  source: { kind: 'raw' },
  ancestorId: 'a:1',
})

const textEl = (over: Partial<TextElement>): TextElement => ({
  kind: 'text',
  id: over.id ?? 't:1',
  name: over.name ?? 'Body',
  characters: over.characters ?? 'Hello',
  textAutoResize: over.textAutoResize ?? 'HEIGHT',
  isSingleLine: over.isSingleLine ?? true,
  isSingleVisualLine: over.isSingleVisualLine ?? true,
  paragraphSpacingPx: over.paragraphSpacingPx ?? null,
  segments: over.segments ?? [
    {
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
      fill: fill('#111111'),
    },
  ],
  background: over.background ?? solidBg('#FFFFFF'),
  bbox: over.bbox ?? { x: 0, y: 0, width: 100, height: 20 },
  parentChain: over.parentChain ?? [],
})

test('produces valid markdown with all required headings on empty input', () => {
  const md = formatDebugReport(emptyDTO(), emptyFindings(), META)
  assert.match(md, /^# Maanak — Accessibility Checker · debug — 2026-05-08T12:00:00Z/)
  assert.match(md, /## Summary/)
  assert.match(md, /## Flags \(0\)/)
  assert.match(md, /## Unable to test \(0\)/)
  assert.match(md, /## Passed \(0\)/)
  assert.match(md, /## Read trace — Texts \(0\)/)
  assert.match(md, /## Read trace — Non-text contrast \(0\)/)
  assert.match(md, /## Read trace — Images \(0\)/)
  assert.match(md, /## Read trace — Form inputs \(0\)/)
  assert.match(md, /## Read trace — Variants/)
  assert.match(md, /## Manual checks/)
  assert.match(md, /## Warnings \(0\)/)
  assert.match(md, /## Raw AuditDTO/)
  assert.match(md, /## Raw FindingsReport/)
})

test('JSON code blocks contain valid JSON that round-trips', () => {
  const dto = emptyDTO({
    texts: [textEl({ name: 'Title' })],
    warnings: ['extraction warning'],
  })
  const findings = emptyFindings({
    flags: [{
      criterion: '1.4.3',
      status: 'flag',
      scope: 'element',
      nodeId: 't:1',
      nodeName: 'Title',
      message: 'Contrast too low',
      details: { actual: 2.1, required: 4.5 },
    }],
  })
  const md = formatDebugReport(dto, findings, META)

  // Extract DTO JSON.
  const dtoMatch = md.match(/## Raw AuditDTO\n````json\n([\s\S]*?)\n````/)
  assert.ok(dtoMatch, 'DTO JSON block present')
  const parsedDto = JSON.parse(dtoMatch![1])
  assert.equal(parsedDto.component.name, 'Test')

  // Extract Findings JSON.
  const findingsMatch = md.match(/## Raw FindingsReport\n````json\n([\s\S]*?)\n````/)
  assert.ok(findingsMatch, 'FindingsReport JSON block present')
  const parsedFindings = JSON.parse(findingsMatch![1])
  assert.equal(parsedFindings.flags[0].criterion, '1.4.3')
})

test('renders findings details inline', () => {
  const findings = emptyFindings({
    flags: [
      {
        criterion: '1.4.3',
        status: 'flag',
        scope: 'element',
        nodeId: 't:1',
        nodeName: 'Title',
        message: 'Contrast 2.1:1 — needs ≥4.5:1',
        details: { actual: 2.1, required: 4.5, fontSize: 14 },
      },
    ],
  })
  const md = formatDebugReport(emptyDTO(), findings, META)
  assert.match(md, /### 1\.4\.3 — "Title"/)
  assert.match(md, /- status: flag/)
  assert.match(md, /- actual: 2\.1/)
  assert.match(md, /- required: 4\.5/)
  assert.match(md, /- fontSize: 14/)
})

test('renders text segment trace with resolved fill source', () => {
  const dto = emptyDTO({
    texts: [
      textEl({
        id: 't:42',
        name: 'Heading',
        segments: [
          {
            start: 0,
            end: 7,
            fontFamily: 'Inter',
            fontStyle: 'Bold',
            fontWeight: 700,
            fontSize: 24,
            lineHeightUnit: 'PERCENT',
            lineHeightPx: 36,
            letterSpacingPx: 0,
            textCase: 'ORIGINAL',
            textDecoration: 'NONE',
            fill: {
              hex: '#1F2937',
              rgba: [31, 41, 55, 1],
              source: {
                kind: 'variable',
                variableId: 'v:1',
                variableName: 'text/primary',
                modeId: 'm:1',
                modeName: 'Light',
                collectionId: 'c:1',
                collectionName: 'Theme',
              },
            },
          },
        ],
      }),
    ],
  })
  const md = formatDebugReport(dto, emptyFindings(), META)
  assert.match(md, /### "Heading" · t:42/)
  assert.match(md, /Inter Bold 700/)
  assert.match(md, /24px/)
  assert.match(md, /variable "text\/primary" mode "Light"/)
})

test('handles weird unicode and special characters in node names without breaking', () => {
  const dto = emptyDTO({
    component: {
      id: '0:1',
      name: 'navigation/profile · 🎨 «icon»',
      type: 'INSTANCE',
      width: 24,
      height: 24,
      pageId: '0:0',
      pageName: 'Page',
      modeName: null,
    },
    texts: [textEl({ name: 'Name with `backticks` and | pipes' })],
  })
  const md = formatDebugReport(dto, emptyFindings(), META)
  assert.ok(md.includes('navigation/profile'))
  // The inline trace renders the escaped form (backticks neutralized).
  assert.match(md, /### "Name with ˋbacktickˋ?s?ˋ and ǀ pipes"/)
  // Raw JSON section preserves the original characters — that's expected;
  // the four-backtick fence absorbs them safely.
  assert.match(md, /^# Maanak — Accessibility Checker · debug/)
})

test('marks variants section explicitly when no variants present', () => {
  const md = formatDebugReport(emptyDTO(), emptyFindings(), META)
  assert.match(md, /\(no component set \/ no variants\)/)
})

test('lists variants when present', () => {
  const dto = emptyDTO({
    variants: {
      componentSetId: 'cs:1',
      componentSetName: 'Button',
      defaultVariantId: 'v:default',
      variants: [
        { id: 'v:default', name: 'state=default', properties: { state: 'default' } },
        { id: 'v:focus', name: 'state=focus', properties: { state: 'focus' } },
      ],
      focusVariantId: 'v:focus',
      errorVariantId: null,
      otherVariantNames: [],
    },
  })
  const md = formatDebugReport(dto, emptyFindings(), META)
  assert.match(md, /componentSet: "Button"/)
  assert.match(md, /focusVariantId: v:focus/)
  assert.match(md, /errorVariantId: \(none\)/)
  assert.match(md, /state=default/)
})

test('manual checks render with checkbox markers', () => {
  const findings = emptyFindings({
    manual: [
      { criterion: '1.3.3', name: 'Sensory Characteristics', applicable: true },
      { criterion: '2.1.1', name: 'Keyboard', applicable: false },
    ],
  })
  const md = formatDebugReport(emptyDTO(), findings, META)
  assert.match(md, /- \[x\] 1\.3\.3 Sensory Characteristics/)
  assert.match(md, /- \[ \] 2\.1\.1 Keyboard/)
})

test('warnings dedupe between dto.warnings and findings.warnings', () => {
  const md = formatDebugReport(
    emptyDTO({ warnings: ['shared warning'] }),
    emptyFindings({ warnings: ['shared warning', 'finding-only warning'] }),
    META
  )
  // Extract just the Warnings section so we don't count occurrences in the raw
  // JSON code blocks (those legitimately repeat the warning in both arrays).
  const warningsSection = md.match(/## Warnings \(\d+\)\n([\s\S]*?)\n##/)?.[1] ?? ''
  const sharedHits = warningsSection.match(/shared warning/g) ?? []
  assert.equal(sharedHits.length, 1)
  assert.match(warningsSection, /finding-only warning/)
  // Header count matches deduped count (2: shared + finding-only).
  assert.match(md, /## Warnings \(2\)/)
})

test('output ends with a single trailing newline', () => {
  const md = formatDebugReport(emptyDTO(), emptyFindings(), META)
  assert.equal(md.endsWith('\n'), true)
  assert.equal(md.endsWith('\n\n'), false)
})
