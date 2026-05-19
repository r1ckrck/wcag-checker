import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFormInputName, isImageExemptName } from '../regex.ts'

// Bug 9 — the regex was tightened. Bare `input/...` no longer matches; we
// require either a recognized text-entry keyword on its own (TextField,
// Combobox, Textarea, Select, Search) or `input/<text-entry-suffix>`.
// Selection chips and cards (named `input/chip`, `input/product_variant`,
// etc.) are explicitly excluded — the shape guard in form-input.ts handles
// any leakage from the regex.

test('isFormInputName — recognized text-entry keywords match', () => {
  assert.equal(isFormInputName('TextField'), true)
  assert.equal(isFormInputName('Text Field'), true)
  assert.equal(isFormInputName('Combobox'), true)
  assert.equal(isFormInputName('Combo Box'), true)
  assert.equal(isFormInputName('Textarea'), true)
  assert.equal(isFormInputName('Text Area'), true)
  assert.equal(isFormInputName('Select'), true)
  assert.equal(isFormInputName('Search'), true)
  assert.equal(isFormInputName('Search Bar'), true)
  assert.equal(isFormInputName('search/main'), true)
})

test('isFormInputName — input/<text-entry-suffix> matches', () => {
  assert.equal(isFormInputName('input/text'), true)
  assert.equal(isFormInputName('input/email'), true)
  assert.equal(isFormInputName('input/password'), true)
  assert.equal(isFormInputName('input/search'), true)
  assert.equal(isFormInputName('input/amount'), true)
  assert.equal(isFormInputName('input/number'), true)
  assert.equal(isFormInputName('input/phone'), true)
  assert.equal(isFormInputName('input/url'), true)
  assert.equal(isFormInputName('input/date'), true)
  assert.equal(isFormInputName('input/name'), true)
})

test('isFormInputName — BFSI / India-domain input/<suffix> matches', () => {
  assert.equal(isFormInputName('input/pan'), true)
  assert.equal(isFormInputName('input/aadhaar'), true)
  assert.equal(isFormInputName('input/aadhar'), true)
  assert.equal(isFormInputName('input/address'), true)
  assert.equal(isFormInputName('input/pincode'), true)
  assert.equal(isFormInputName('input/pin'), true)
  assert.equal(isFormInputName('input/income'), true)
  assert.equal(isFormInputName('input/salary'), true)
  assert.equal(isFormInputName('input/ifsc'), true)
  assert.equal(isFormInputName('input/gstin'), true)
  assert.equal(isFormInputName('input/gst'), true)
  assert.equal(isFormInputName('input/accountnumber'), true)
  assert.equal(isFormInputName('input/accno'), true)
  assert.equal(isFormInputName('input/account'), true)
  assert.equal(isFormInputName('input/dob'), true)
  assert.equal(isFormInputName('input/otp'), true)
})

test('isFormInputName — superset names of new suffixes do NOT match (\\b guard)', () => {
  assert.equal(isFormInputName('input/pinterest'), false)
  assert.equal(isFormInputName('input/accountant'), false)
  assert.equal(isFormInputName('input/panic'), false)
  assert.equal(isFormInputName('input/addressbook'), false)
})

test('isFormInputName — case insensitive', () => {
  assert.equal(isFormInputName('TEXTFIELD'), true)
  assert.equal(isFormInputName('textfield'), true)
  assert.equal(isFormInputName('Input/Email'), true)
})

test('isFormInputName — Bug 9: bare input/* and selection components do NOT match', () => {
  // Bare `input/...` without a text-entry suffix is the false-positive trap.
  assert.equal(isFormInputName('Input'), false)
  assert.equal(isFormInputName('Input/Default'), false)
  assert.equal(isFormInputName('Input/Some/Path'), false)
  assert.equal(isFormInputName('input/chip'), false)
  assert.equal(isFormInputName('input/product_variant'), false)
  assert.equal(isFormInputName('input/radio'), false)
  assert.equal(isFormInputName('input/checkbox'), false)
})

test('isFormInputName — non-input components do not match', () => {
  assert.equal(isFormInputName('Button'), false)
  assert.equal(isFormInputName('Button/Primary'), false)
  assert.equal(isFormInputName('Card'), false)
  assert.equal(isFormInputName('Icon'), false)
  assert.equal(isFormInputName('Selectable List'), false)
  assert.equal(isFormInputName('MyInput'), false)
})

test('isImageExemptName — logo / brand variants match', () => {
  assert.equal(isImageExemptName('Logo'), true)
  assert.equal(isImageExemptName('logo'), true)
  assert.equal(isImageExemptName('Brand Mark'), true)
  assert.equal(isImageExemptName('BRANDING'), true)
  assert.equal(isImageExemptName('logotype'), true)
  assert.equal(isImageExemptName('Company Logo'), true)
})

test('isImageExemptName — non-logo names do not match', () => {
  assert.equal(isImageExemptName('Hero Image'), false)
  assert.equal(isImageExemptName('Cover'), false)
  assert.equal(isImageExemptName('Avatar'), false)
  assert.equal(isImageExemptName('Photo'), false)
})
