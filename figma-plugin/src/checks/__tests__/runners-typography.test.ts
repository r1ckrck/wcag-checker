import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTypographyCheck } from '../runners/typography.ts'
import type {
  AuditDTO,
  ImageElement,
  TextElement,
  TextSegment,
  ResolvedFill,
} from '../../shared/dtos.ts'

const fill = (): ResolvedFill => ({
  hex: '#000000',
  rgba: [0, 0, 0, 1],
  source: { kind: 'raw' },
})

const segment = (over: Partial<TextSegment> = {}): TextSegment => ({
  start: 0,
  end: 5,
  fontFamily: 'Inter',
  fontStyle: 'Regular',
  fontWeight: 400,
  fontSize: 14,
  lineHeightUnit: 'PIXELS',
  lineHeightPx: 21,
  // Default letter-spacing 2px = ~14% of 14px font — comfortably above the
  // new -6% floor. Tests that need a failing fixture override explicitly.
  letterSpacingPx: 2,
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  fill: fill(),
  ...over,
})

const text = (over: Partial<TextElement> = {}): TextElement => ({
  kind: 'text',
  id: over.id ?? 't:1',
  name: over.name ?? 'Body',
  characters: 'Hello',
  textAutoResize: over.textAutoResize ?? 'HEIGHT',
  isSingleLine: over.isSingleLine ?? true,
  isSingleVisualLine: over.isSingleVisualLine ?? true,
  // Default paragraphSpacing 16px ≈ 76% of the default 21px line-height —
  // comfortably above the 70% floor. Tests that need a failing fixture
  // override explicitly.
  paragraphSpacingPx: over.paragraphSpacingPx ?? 16,
  segments: over.segments ?? [segment()],
  background: { kind: 'unresolvable', reason: 'no-ancestor' },
  bbox: { x: 0, y: 0, width: 100, height: 20 },
  parentChain: [],
})

const image = (over: Partial<ImageElement>): ImageElement => ({
  kind: 'image',
  id: over.id ?? 'i:1',
  name: over.name ?? 'photo',
  width: over.width ?? 100,
  height: over.height ?? 80,
  isExempt: over.isExempt ?? false,
  imageHash: over.imageHash ?? null,
})

const dto = (over: Partial<AuditDTO> = {}): AuditDTO => ({
  component: { id: '0:1', name: 'C', type: 'COMPONENT', width: 0, height: 0, pageId: 'p', pageName: 'P', modeName: null },
  texts: over.texts ?? [],
  nonTextContrast: [],
  images: over.images ?? [],
  formInputs: [],
  clickables: [],
  variants: null,
  warnings: [],
})

test('typography: defaults pass (lh=150%, ls=14%, ps=81% of lh)', () => {
  const f = runTypographyCheck(dto({ texts: [text()] }))
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'pass')
})

test('typography: multi-visual-line text with line-height below 75% → flag', () => {
  // fontSize 14, lineHeightPx 10 → 71% (below the 75% floor)
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          isSingleLine: false,
          isSingleVisualLine: false,
          segments: [segment({ lineHeightPx: 10 })],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'flag')
})

test('typography: soft-wrapped paragraph (no \\n but multi visual lines) still flags low line-height', () => {
  // Long text with no hard breaks but bbox tall enough to wrap visually.
  // fontSize 14, lineHeightPx 10 → 71% (below the 75% floor)
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          isSingleLine: true,
          isSingleVisualLine: false,
          segments: [segment({ lineHeightPx: 10 })],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'flag')
})

test('typography: truly single-visual-line text auto-passes line-height', () => {
  // Single rendered line — line-height has no rendered effect, so even a
  // value below the floor shouldn't surface as a flag.
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          isSingleLine: true,
          isSingleVisualLine: true,
          segments: [segment({ lineHeightPx: 8 })],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'pass')
})

test('typography: AUTO line-height passes (no fixed constraint)', () => {
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          segments: [segment({ lineHeightUnit: 'AUTO', lineHeightPx: null })],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'pass')
})

test('typography: negative letter-spacing within -6% floor passes', () => {
  // fontSize 14, letterSpacing -0.84 → -6% (boundary)
  const f = runTypographyCheck(
    dto({
      texts: [text({ segments: [segment({ letterSpacingPx: -0.84 })] })],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'pass')
})

test('typography: letter-spacing tighter than -6% → flag', () => {
  // fontSize 14, letterSpacing -1.5 → -10.7% (below -6%)
  const f = runTypographyCheck(
    dto({
      texts: [text({ segments: [segment({ letterSpacingPx: -1.5 })] })],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'flag')
})

test('typography: paragraph-spacing below 70% of line-height → flag', () => {
  // lineHeight 21, paragraphSpacing 10 → 47.6% (below 70%)
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          isSingleLine: false,
          isSingleVisualLine: false,
          paragraphSpacingPx: 10,
        }),
      ],
    })
  )
  const flags = f.filter(x => x.status === 'flag')
  const paragraphFlag = flags.find(
    x => (x.details as { property?: string } | undefined)?.property === 'paragraph-spacing'
  )
  assert.ok(paragraphFlag)
})

test('typography: single-line skips paragraph spacing requirement', () => {
  const f = runTypographyCheck(
    dto({
      texts: [text({ isSingleLine: true, paragraphSpacingPx: 0 })],
    })
  )
  const paragraphFlag = f.find(
    x => x.status === 'flag' && (x.details as { property?: string } | undefined)?.property === 'paragraph-spacing'
  )
  assert.equal(paragraphFlag, undefined)
})

test('typography: dominant segment chosen by largest fontSize', () => {
  // small segment passes; big segment fails — if dominant = big, expect flag.
  const small = segment({ fontSize: 12, lineHeightPx: 14, start: 0, end: 5 })   // 116% → pass
  const big = segment({ fontSize: 32, lineHeightPx: 20, start: 5, end: 12 })    // 62.5% → fail
  const f = runTypographyCheck(
    dto({
      texts: [
        text({
          isSingleVisualLine: false,
          isSingleLine: false,
          segments: [small, big],
        }),
      ],
    })
  )
  const r = f.find(x => x.criterion === 'typography')
  assert.equal(r?.status, 'flag') // dominant = big segment which fails
})

test('1.4.5: exempt logo passes', () => {
  const f = runTypographyCheck(dto({ images: [image({ name: 'Brand Logo', isExempt: true })] }))
  const r = f.find(x => x.criterion === '1.4.5')
  assert.equal(r?.status, 'pass')
})

test('1.4.5: name with "title" flags', () => {
  const f = runTypographyCheck(dto({ images: [image({ name: 'page-title', width: 30, height: 10 })] }))
  const r = f.find(x => x.criterion === '1.4.5')
  assert.equal(r?.status, 'flag')
  assert.match(r?.message ?? '', /name suggests/)
})

// Bug 7 — bare-size flag removed. Large non-named-as-text images are now
// deferred to the AI image-of-text check (handled in the UI). The runner
// emits no entry for them.
test('1.4.5: large image without text-y name → no runner entry (deferred to AI)', () => {
  const f = runTypographyCheck(dto({ images: [image({ name: 'banner', width: 800, height: 200 })] }))
  const r = f.find(x => x.criterion === '1.4.5')
  assert.equal(r, undefined)
})

test('1.4.5: small avatar without text-y name → no runner entry', () => {
  const f = runTypographyCheck(dto({ images: [image({ name: 'avatar', width: 24, height: 24 })] }))
  const r = f.find(x => x.criterion === '1.4.5')
  assert.equal(r, undefined)
})

test('1.4.5: name-flagged image still flags deterministically (cheap signal)', () => {
  const f = runTypographyCheck(dto({ images: [image({ name: 'hero-title-banner', width: 800, height: 200 })] }))
  const r = f.find(x => x.criterion === '1.4.5')
  assert.equal(r?.status, 'flag')
  assert.match(r?.message ?? '', /name suggests/)
})
