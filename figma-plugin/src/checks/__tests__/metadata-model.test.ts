import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSpecModel } from '../metadata-model.ts'
import type {
  AuditDTO,
  ClickableElement,
  FormInputElement,
  FormInputChildText,
  ImageElement,
} from '../../shared/dtos.ts'

// ── Fixtures ────────────────────────────────────────────────────────

const baseDTO = (
  over: Partial<Pick<AuditDTO, 'clickables' | 'formInputs' | 'images'>> = {}
): AuditDTO => ({
  component: {
    id: '0:1',
    name: 'Login card',
    type: 'COMPONENT',
    width: 320,
    height: 480,
    pageId: 'p',
    pageName: 'P',
    modeName: null,
  },
  texts: [],
  nonTextContrast: [],
  images: over.images ?? [],
  formInputs: over.formInputs ?? [],
  clickables: over.clickables ?? [],
  variants: null,
  warnings: [],
})

const bbox = (x: number, y: number) => ({ x, y, width: 40, height: 40 })

const clickable = (over: Partial<ClickableElement> = {}): ClickableElement => ({
  kind: 'clickable',
  id: over.id ?? 'c:1',
  name: over.name ?? 'Button',
  nodeType: over.nodeType ?? 'INSTANCE',
  cornerRadius: over.cornerRadius ?? 4,
  componentName: over.componentName ?? null,
  textRaw: over.textRaw ?? '',
  textNormalized: over.textNormalized ?? '',
  signals: over.signals ?? ['component-name'],
  bbox: over.bbox ?? bbox(0, 0),
})

const childText = (over: Partial<FormInputChildText> = {}): FormInputChildText => ({
  id: over.id ?? 't:1',
  text: over.text ?? '',
  isInsideInput: over.isInsideInput ?? false,
  isLabel: over.isLabel ?? false,
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
  bbox: over.bbox ?? bbox(0, 0),
})

const image = (over: Partial<ImageElement> = {}): ImageElement => ({
  kind: 'image',
  id: over.id ?? 'i:1',
  name: over.name ?? 'hero',
  width: over.width ?? 200,
  height: over.height ?? 120,
  isExempt: over.isExempt ?? false,
  imageHash: 'imageHash' in over ? (over.imageHash ?? null) : 'hash-1',
})

const field = (el: { fields: Array<{ label: string; value: unknown }> }, label: string) =>
  el.fields.find(f => f.label === label)!.value as
    | { kind: 'value'; text: string }
    | { kind: 'slot'; placeholder: string }
    | { kind: 'ai-image'; imageId: string; placeholder: string }

// ── Model shape + component name ────────────────────────────────────

test('model carries the component name; empty DTO → no elements', () => {
  const m = buildSpecModel(baseDTO())
  assert.equal(m.componentName, 'Login card')
  assert.deepEqual(m.elements, [])
  assert.deepEqual(m.focusOrder, [])
})

// ── Focus / reading order ───────────────────────────────────────────

test('focus order = clickables + form inputs sorted top→bottom, left→right', () => {
  const m = buildSpecModel(
    baseDTO({
      clickables: [
        clickable({ id: 'c:1', name: 'Submit', textRaw: 'Submit', textNormalized: 'submit', bbox: bbox(10, 300) }),
        clickable({ id: 'c:2', name: 'Help', textRaw: 'Help', textNormalized: 'help', bbox: bbox(200, 20) }),
      ],
      formInputs: [formInput({ id: 'fi:1', name: 'Email', bbox: bbox(10, 100) })],
    })
  )
  // y order: Help(20) → Email(100) → Submit(300)
  assert.deepEqual(m.focusOrder, ['Help', 'Email', 'Submit'])
})

// ── Images ──────────────────────────────────────────────────────────

test('non-exempt image with hash → Role slot, Alt text ai-image', () => {
  const m = buildSpecModel(baseDTO({ images: [image({ id: 'i:9', imageHash: 'h' })] }))
  const el = m.elements[0]
  assert.equal(el.kind, 'image')
  assert.equal(field(el, 'Role').kind, 'slot')
  const alt = field(el, 'Alt text')
  assert.equal(alt.kind, 'ai-image')
  assert.equal((alt as { imageId: string }).imageId, 'i:9')
})

test('non-exempt image without hash → Alt text slot (no AI possible)', () => {
  const m = buildSpecModel(baseDTO({ images: [image({ imageHash: null })] }))
  assert.equal(field(m.elements[0], 'Alt text').kind, 'slot')
})

test('exempt image → Role decorative, Alt text fixed value', () => {
  const m = buildSpecModel(baseDTO({ images: [image({ isExempt: true })] }))
  const el = m.elements[0]
  assert.deepEqual(field(el, 'Role'), { kind: 'value', text: 'decorative' })
  assert.deepEqual(field(el, 'Alt text'), { kind: 'value', text: '(decorative — no alt needed)' })
})

// ── Clickables: icon / link / button ────────────────────────────────

test('icon-only clickable → icon kind, name from componentName, Intent slot', () => {
  const m = buildSpecModel(
    baseDTO({ clickables: [clickable({ name: 'icon-search', componentName: 'IconButton', textNormalized: '' })] })
  )
  const el = m.elements[0]
  assert.equal(el.kind, 'icon')
  assert.deepEqual(field(el, 'Accessible name'), { kind: 'value', text: 'IconButton' })
  assert.equal(field(el, 'Intent').kind, 'slot')
})

test('link (name matches /link/i) → link kind with destination/new-tab/download slots', () => {
  const m = buildSpecModel(
    baseDTO({ clickables: [clickable({ name: 'nav-link', textRaw: 'Pricing', textNormalized: 'pricing' })] })
  )
  const el = m.elements[0]
  assert.equal(el.kind, 'link')
  assert.deepEqual(field(el, 'Accessible name'), { kind: 'value', text: 'Pricing' })
  assert.equal(field(el, 'Destination').kind, 'slot')
  assert.equal(field(el, 'Opens new tab').kind, 'slot')
  assert.equal(field(el, 'Is download').kind, 'slot')
})

test('text clickable, not link → button kind, name from textRaw', () => {
  const m = buildSpecModel(
    baseDTO({ clickables: [clickable({ name: 'cta', textRaw: 'Sign up', textNormalized: 'sign up' })] })
  )
  const el = m.elements[0]
  assert.equal(el.kind, 'button')
  assert.deepEqual(field(el, 'Accessible name'), { kind: 'value', text: 'Sign up' })
})

// ── Junk filtering ──────────────────────────────────────────────────

test('placeholder / default-layer-name candidates → slot, legit short label kept', () => {
  // "Button" → matchesPlaceholder → slot
  let m = buildSpecModel(baseDTO({ clickables: [clickable({ textRaw: 'Button', textNormalized: 'button' })] }))
  assert.equal(field(m.elements[0], 'Accessible name').kind, 'slot')

  // "Frame 12" default layer name → slot
  m = buildSpecModel(
    baseDTO({ clickables: [clickable({ name: 'x', componentName: null, textNormalized: '', textRaw: '' }) ] })
  )
  m = buildSpecModel(
    baseDTO({ clickables: [clickable({ componentName: 'Frame 12', textNormalized: '' })] })
  )
  assert.equal(field(m.elements[0], 'Accessible name').kind, 'slot')

  // "OK" is a valid short accessible name — must NOT be slotted
  m = buildSpecModel(baseDTO({ clickables: [clickable({ textRaw: 'OK', textNormalized: 'ok' })] }))
  assert.deepEqual(field(m.elements[0], 'Accessible name'), { kind: 'value', text: 'OK' })
})

// ── Form inputs ─────────────────────────────────────────────────────

test('form input → label from isLabel child, input purpose from input/<suffix>', () => {
  const m = buildSpecModel(
    baseDTO({
      formInputs: [
        formInput({
          name: 'input/email',
          mainComponentName: 'input/email',
          childTextNodes: [childText({ text: 'Email address', isLabel: true })],
        }),
      ],
    })
  )
  const el = m.elements[0]
  assert.equal(el.kind, 'form-input')
  assert.deepEqual(field(el, 'Label'), { kind: 'value', text: 'Email address' })
  assert.deepEqual(field(el, 'Input purpose'), { kind: 'value', text: 'email' })
  assert.equal(field(el, 'Required').kind, 'slot')
  assert.equal(field(el, 'Error message').kind, 'slot')
})

test('form input with no mappable suffix / no label → slots', () => {
  const m = buildSpecModel(
    baseDTO({ formInputs: [formInput({ name: 'input/pan', mainComponentName: 'input/pan', childTextNodes: [] })] })
  )
  const el = m.elements[0]
  assert.equal(field(el, 'Label').kind, 'slot')
  assert.equal(field(el, 'Input purpose').kind, 'slot')
})

// ── Ordering of element cards ───────────────────────────────────────

test('elements are images, then clickables, then form inputs', () => {
  const m = buildSpecModel(
    baseDTO({
      images: [image()],
      clickables: [clickable({ textRaw: 'Go', textNormalized: 'go' })],
      formInputs: [formInput({ childTextNodes: [childText({ text: 'Name', isLabel: true })] })],
    })
  )
  assert.deepEqual(m.elements.map(e => e.kind), ['image', 'button', 'form-input'])
})
