// Pure spec-model builder for the metadata generator. No figma globals — both
// the main thread (to draw the frame) and the UI iframe (to fill AI alt text)
// import these types; only the main thread calls `buildSpecModel`.
//
// The model captures accessibility intent a developer needs at handoff:
// alt text + image role, accessible names, reading/focus order, form-field
// semantics, link/button intent. Every derived value is junk-filtered so a
// leaked layer name ("Frame 12") or placeholder ("Button") becomes an empty
// slot the designer fills, never a wrong value.

import type {
  AuditDTO,
  ClickableElement,
  FormInputElement,
  ImageElement,
} from '../shared/dtos'
import { matchesPlaceholder } from './runners/headings-labels.ts'

// ── Model ───────────────────────────────────────────────────────────

export type SpecFieldValue =
  | { kind: 'value'; text: string }
  | { kind: 'slot'; placeholder: string }
  // Alt text awaiting an AI draft in the UI iframe. The UI replaces this with
  // a `value` (success) or a `slot` (AI off / failure / timeout).
  | { kind: 'ai-image'; imageId: string; placeholder: string }

export interface SpecField {
  label: string
  value: SpecFieldValue
}

export type SpecElementKind = 'image' | 'icon' | 'button' | 'link' | 'form-input'

export interface SpecElement {
  ref: string
  kind: SpecElementKind
  fields: SpecField[]
}

export interface SpecModel {
  componentName: string
  /** Element refs in visual reading order (top→bottom, left→right). */
  focusOrder: string[]
  elements: SpecElement[]
}

// ── Validation ──────────────────────────────────────────────────────

// Default Figma layer names that carry no authorial meaning. `matchesPlaceholder`
// (reused from 2.4.6) already catches "Button" / "Text 1" / "Lorem" / single
// chars / punctuation; this adds the structural defaults it doesn't. The full
// 2.4.6 `isRejected` is deliberately NOT used here — its common-short-word list
// (`ok`, `yes`, `email`, …) would wrongly blank perfectly valid short
// accessible names and labels.
const DEFAULT_LAYER_NAME =
  /^(?:frame|group|rectangle|ellipse|vector|line|polygon|star|component|instance|slice|section|union|subtract|intersect|exclude|mask)\s*\d*$/i

function slot(label: string): SpecFieldValue {
  return { kind: 'slot', placeholder: `⟨ add ${label.toLowerCase()} ⟩` }
}

/** A trimmed candidate becomes a value, or an empty slot if it's blank,
 *  placeholder-ish, or a default layer name. */
function valueOrSlot(raw: string | null | undefined, label: string): SpecFieldValue {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return slot(label)
  if (DEFAULT_LAYER_NAME.test(trimmed)) return slot(label)
  if (matchesPlaceholder(trimmed).matched) return slot(label)
  return { kind: 'value', text: trimmed }
}

// ── Input-purpose map (HTML autocomplete tokens) ────────────────────

const INPUT_PURPOSE: Record<string, string> = {
  email: 'email',
  tel: 'tel',
  phone: 'tel',
  name: 'name',
  url: 'url',
  password: 'current-password',
  date: 'bday',
  dob: 'bday',
  pincode: 'postal-code',
  pin: 'postal-code',
  otp: 'one-time-code',
  address: 'street-address',
}

/** Pull the `input/<suffix>` token from a form-input's names and map it to an
 *  HTML autocomplete token. Returns null when there's no confident mapping. */
function inputPurposeToken(fi: FormInputElement): string | null {
  const source = `${fi.mainComponentName} ${fi.name}`
  const m = source.match(/input\/([a-z]+)/i)
  const suffix = m ? m[1].toLowerCase() : ''
  return suffix && suffix in INPUT_PURPOSE ? INPUT_PURPOSE[suffix] : null
}

// ── Element builders ────────────────────────────────────────────────

function imageElement(img: ImageElement): SpecElement {
  if (img.isExempt) {
    return {
      ref: img.name,
      kind: 'image',
      fields: [
        { label: 'Role', value: { kind: 'value', text: 'decorative' } },
        {
          label: 'Alt text',
          value: { kind: 'value', text: '(decorative — no alt needed)' },
        },
      ],
    }
  }
  const altValue: SpecFieldValue = img.imageHash
    ? { kind: 'ai-image', imageId: img.id, placeholder: '⟨ add alt text ⟩' }
    : slot('alt text')
  return {
    ref: img.name,
    kind: 'image',
    fields: [
      { label: 'Role', value: slot('role (informative / decorative / functional / complex)') },
      { label: 'Alt text', value: altValue },
    ],
  }
}

function isLink(c: ClickableElement): boolean {
  return /link/i.test(c.name) || /link/i.test(c.componentName ?? '')
}

function clickableElement(c: ClickableElement): SpecElement {
  // Icon-only — no visible text, needs an authored accessible name.
  if (c.textNormalized === '') {
    return {
      ref: c.name,
      kind: 'icon',
      fields: [
        { label: 'Accessible name', value: valueOrSlot(c.componentName ?? c.name, 'accessible name') },
        { label: 'Intent', value: slot('intent') },
      ],
    }
  }
  if (isLink(c)) {
    return {
      ref: c.name,
      kind: 'link',
      fields: [
        { label: 'Accessible name', value: valueOrSlot(c.textRaw, 'accessible name') },
        { label: 'Destination', value: slot('destination') },
        { label: 'Opens new tab', value: slot('opens new tab') },
        { label: 'Is download', value: slot('is download') },
      ],
    }
  }
  return {
    ref: c.name,
    kind: 'button',
    fields: [
      { label: 'Accessible name', value: valueOrSlot(c.textRaw, 'accessible name') },
      { label: 'Intent', value: slot('intent') },
    ],
  }
}

function formInputElement(fi: FormInputElement): SpecElement {
  const labelText = fi.childTextNodes.find(t => t.isLabel)?.text ?? null
  const purpose = inputPurposeToken(fi)
  return {
    ref: fi.name,
    kind: 'form-input',
    fields: [
      { label: 'Label', value: valueOrSlot(labelText, 'label') },
      {
        label: 'Input purpose',
        value: purpose ? { kind: 'value', text: purpose } : slot('input purpose'),
      },
      { label: 'Required', value: slot('required') },
      { label: 'Error message', value: slot('error message') },
    ],
  }
}

// ── Builder ─────────────────────────────────────────────────────────

export function buildSpecModel(dto: AuditDTO): SpecModel {
  const elements: SpecElement[] = [
    ...dto.images.map(imageElement),
    ...dto.clickables.map(clickableElement),
    ...dto.formInputs.map(formInputElement),
  ]

  // Reading / focus order: clickables + form inputs in visual order
  // (top→bottom, then left→right). Designer reorders by editing the text.
  const focusable: Array<{ ref: string; x: number; y: number }> = [
    ...dto.clickables.map(c => ({ ref: c.name, x: Math.round(c.bbox.x), y: Math.round(c.bbox.y) })),
    ...dto.formInputs.map(fi => ({ ref: fi.name, x: Math.round(fi.bbox.x), y: Math.round(fi.bbox.y) })),
  ]
  focusable.sort((a, b) => (a.y - b.y) || (a.x - b.x))

  return {
    componentName: dto.component.name,
    focusOrder: focusable.map(f => f.ref),
    elements,
  }
}
