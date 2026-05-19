import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runContrastCheck } from '../runners/contrast.ts'
import type {
  AuditDTO,
  TextElement,
  TextSegment,
  NonTextContrastElement,
  ResolvedFill,
  BackgroundSample,
} from '../../shared/dtos.ts'

const solidBg = (hex: string, rgb: [number, number, number]): BackgroundSample => ({
  kind: 'solid',
  hex,
  rgba: [rgb[0], rgb[1], rgb[2], 1],
  source: { kind: 'raw' },
  ancestorId: 'a:1',
})

const fill = (rgb: [number, number, number], a = 1): ResolvedFill => ({
  hex: '#000000',
  rgba: [rgb[0], rgb[1], rgb[2], a],
  source: { kind: 'raw' },
})

const segment = (over: Partial<TextSegment> = {}): TextSegment => ({
  start: 0,
  end: 5,
  fontFamily: 'Inter',
  fontStyle: 'Regular',
  fontWeight: over.fontWeight ?? 400,
  fontSize: over.fontSize ?? 14,
  lineHeightUnit: 'PIXELS',
  lineHeightPx: 21,
  letterSpacingPx: 0,
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  fill: over.fill ?? fill([0, 0, 0]),
})

const text = (over: Partial<TextElement> = {}): TextElement => ({
  kind: 'text',
  id: over.id ?? 't:1',
  name: over.name ?? 'Body',
  characters: over.characters ?? 'Hello',
  textAutoResize: over.textAutoResize ?? 'HEIGHT',
  isSingleLine: true,
  isSingleVisualLine: true,
  paragraphSpacingPx: null,
  segments: over.segments ?? [segment()],
  background: over.background ?? solidBg('#FFFFFF', [255, 255, 255]),
  bbox: { x: 0, y: 0, width: 100, height: 20 },
  parentChain: [],
})

const ntc = (over: Partial<NonTextContrastElement> = {}): NonTextContrastElement => ({
  kind: 'non-text-contrast',
  id: over.id ?? 'v:1',
  name: over.name ?? 'Icon',
  nodeType: 'VECTOR',
  fill: 'fill' in over ? over.fill ?? null : fill([100, 100, 100]),
  stroke: 'stroke' in over ? over.stroke ?? null : null,
  strokeWeight: null,
  background: over.background ?? solidBg('#FFFFFF', [255, 255, 255]),
  isIconOnly: true,
  bbox: { x: 0, y: 0, width: 24, height: 24 },
})

const dto = (over: Partial<AuditDTO> = {}): AuditDTO => ({
  component: { id: '0:1', name: 'C', type: 'COMPONENT', width: 0, height: 0, pageId: 'p', pageName: 'P', modeName: null },
  texts: over.texts ?? [],
  nonTextContrast: over.nonTextContrast ?? [],
  images: [],
  formInputs: [],
  clickables: [],
  variants: null,
  warnings: [],
})

test('text: black on white passes 1.4.3', () => {
  const f = runContrastCheck(dto({ texts: [text()] }))
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'pass')
})

test('text: gray (#888) on white fails 1.4.3 normal threshold', () => {
  const f = runContrastCheck(dto({ texts: [text({ segments: [segment({ fill: fill([136, 136, 136]) })] })] }))
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'flag')
  assert.match(r?.message ?? '', /needs ≥4\.5/)
})

test('text: large text (24px) at 3:1 threshold passes when normal would fail', () => {
  // 4:1 ratio passes large-text threshold (3:1) but fails normal (4.5:1).
  // #767676 ≈ 4.54:1 actually — use a slightly darker value that lands ~3.5
  const f = runContrastCheck(
    dto({
      texts: [
        text({
          segments: [segment({ fontSize: 24, fill: fill([136, 136, 136]) })], // ~3.55:1
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'pass')
})

test('text: large + bold (18.67px / 700) uses 3:1 threshold', () => {
  const f = runContrastCheck(
    dto({
      texts: [
        text({
          segments: [segment({ fontSize: 18.67, fontWeight: 700, fill: fill([136, 136, 136]) })],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'pass')
})

test('text: gradient background → unable-to-test', () => {
  const f = runContrastCheck(
    dto({
      texts: [
        text({
          background: { kind: 'unresolvable', reason: 'gradient' },
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'unable-to-test')
  assert.match(r?.message ?? '', /gradient/)
})

test('text: fill source unresolvable → unable-to-test', () => {
  const f = runContrastCheck(
    dto({
      texts: [
        text({
          segments: [
            segment({
              fill: {
                hex: null,
                rgba: null,
                source: { kind: 'unresolvable', reason: 'mixed' },
              },
            }),
          ],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === '1.4.3')
  assert.equal(r?.status, 'unable-to-test')
})

test('interactive: stroke takes precedence over fill', () => {
  const f = runContrastCheck(
    dto({
      nonTextContrast: [
        ntc({
          fill: fill([0, 0, 0]),       // would pass alone
          stroke: fill([240, 240, 240]), // pale stroke fails 3:1 vs white bg
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === '1.4.11')
  assert.equal(r?.status, 'flag')
})

test('interactive: no stroke, fill passes', () => {
  const f = runContrastCheck(
    dto({
      nonTextContrast: [ntc({ fill: fill([0, 0, 0]), stroke: null })],
    })
  )
  const r = f.find(x => x.criterion === '1.4.11')
  assert.equal(r?.status, 'pass')
})

test('interactive: neither fill nor stroke determinable → unable-to-test', () => {
  const f = runContrastCheck(
    dto({
      nonTextContrast: [ntc({ fill: null, stroke: null })],
    })
  )
  const r = f.find(x => x.criterion === '1.4.11')
  assert.equal(r?.status, 'unable-to-test')
})

test('multiple text elements: aggregation rule — flag wins, no individual passes', () => {
  // Two texts: one passes, one fails. Findings list contains pass + flag.
  // Aggregation happens later in `aggregate()` — runner emits raw entries.
  const f = runContrastCheck(
    dto({
      texts: [
        text({ id: 't:1', segments: [segment({ fill: fill([0, 0, 0]) })] }),
        text({ id: 't:2', segments: [segment({ fill: fill([180, 180, 180]) })] }),
      ],
    })
  )
  const passes = f.filter(x => x.status === 'pass' && x.criterion === '1.4.3')
  const flags = f.filter(x => x.status === 'flag' && x.criterion === '1.4.3')
  assert.equal(passes.length, 1)
  assert.equal(flags.length, 1)
})
