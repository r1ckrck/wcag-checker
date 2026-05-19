// Name-based heuristics — kept as pure regex functions for testability.
//
// Error-handling policy: pure functions, no failure modes. Inputs that don't
// match return `false`; never throws.

// Bug 9 — match only specific text-entry control names. Bare `input/...` is
// too generic in real design systems (catches `input/chip`, `input/product_variant`,
// etc.) so we require either a recognized text-entry keyword on its own, or
// `input/<text-entry-suffix>`. The shape guard in form-input.ts catches
// remaining false positives (squarish bbox, many child texts).
// Each keyword requires a word boundary at the end so we don't match supersets
// like "Selectable", "Searchable", "TextFields…" — accidental matches caused
// false positives on Bajaj's design system. `input/<suffix>` paths use \b too
// so `input/textbox` matches `text` but `input/text2` doesn't.
// `input/<suffix>` allowlist. Ordered longest-before-prefix within overlapping
// families (pincode|pin, gstin|gst, accountnumber|accno|account) — defensive,
// though the trailing \b already disambiguates (input/pin matches,
// input/pinterest doesn't; input/account matches, input/accountant doesn't).
// BFSI / India-domain suffixes (pan, aadhaar, ifsc, …) added so Indian product
// designs that name fields by domain are still caught by the 3.3.2 form-label
// check. The geometric shape guard in form-input.ts remains the false-positive
// backstop.
const FORM_INPUT_RE =
  /^(?:textfield\b|text\s*field\b|combobox\b|combo\s*box\b|textarea\b|text\s*area\b|select\b|search\b|input\/(?:text|email|password|search|amount|number|phone|tel|url|date|time|name|pan|aadhaar|aadhar|address|pincode|pin|income|salary|ifsc|gstin|gst|accountnumber|accno|account|dob|otp)\b)/i

const IMAGE_EXEMPT_RE = /(logo|logotype|brand|branding)/i

/** True if the component name looks like a form-input component. */
export function isFormInputName(name: string): boolean {
  return FORM_INPUT_RE.test(name.trim())
}

/** True if the node name suggests a logo/brand (image-of-text exemption). */
export function isImageExemptName(name: string): boolean {
  return IMAGE_EXEMPT_RE.test(name)
}
