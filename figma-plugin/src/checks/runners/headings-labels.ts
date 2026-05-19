// SC 2.4.6 Headings & Labels. Pure DTO consumer.
//
// Flags text that doesn't describe topic or purpose (e.g. "Button", "Text 1",
// "Heading", "Lorem ipsum", "xxx"). A deterministic regex sweep is enough at
// design stage; real copy (Submit, Continue with Google, Forgot password?)
// doesn't false-positive.
//
// Sources audited:
//   • clickables[] — button / link text (skipped when textNormalized === '',
//     same icon-only carve-out as 2.4.4)
//   • formInputs[].childTextNodes[] where isLabel === true
//   • texts[] — every standalone text node in the audited subtree
//
// The standalone-text path is gated by an explicit REJECT list: numeric content,
// currency, URLs, dates, times, version strings, and a locked set of common
// short legitimate words pre-filter out so real copy isn't flagged. The reject
// list does NOT apply to clickables or form-input labels — those keep their
// strict-scope behavior. Text-node findings emit FLAGS only (no per-element
// passes, which would flood the pass disclosure with every text layer).

import type {
  AuditDTO,
  ClickableElement,
  FormInputElement,
  TextElement,
} from '../../shared/dtos'
import type { Finding } from '../findings.ts'

// ── Flag list ───────────────────────────────────────────────────────

/**
 * Placeholder patterns. First match wins for the `matchedPattern` detail.
 * Tested against the trimmed input string; `i` flag covers casing.
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: 'empty', regex: /^\s*$/ },
  { name: 'single-letter', regex: /^\p{L}$/u },
  // 2+ chars of pure punctuation/symbols/whitespace — keeps single symbols like
  // "→" or "&" (legitimate back/copy buttons) out of the trap.
  { name: 'punctuation-only', regex: /^[\p{P}\p{S}\s]{2,}$/u },
  // Generic UI noun — Figma layer-name vocabulary leaking into content. The
  // optional trailing digit run catches "Text 1", "Heading 2", "Heading 2024".
  {
    name: 'generic-ui-noun',
    regex:
      /^(?:button|btn|link|label|field|input|text|heading|subheading|subhead|subtitle|header|footer|caption|body|paragraph|description|copy|content|title|placeholder|untitled)(?:\s*\d+)?$/i,
  },
  { name: 'heading-shorthand', regex: /^h[1-6]$/i },
  // Lorem anywhere as a word — catches "Welcome to lorem section" as well as
  // "Lorem ipsum dolor sit amet". Word-boundary protects partial matches
  // ("florem", "loremly").
  { name: 'lorem', regex: /\blorem\b/i },
  // Common dummy keyboard-mash + placeholder tokens.
  {
    name: 'dummy-copy',
    regex: /^(?:x{3,}|asdf|tbd|todo|test|temp|dummy|sample|foo|bar|baz)$/i,
  },
]

export interface PlaceholderMatch {
  matched: boolean
  pattern: string | null
}

/** Pure helper exported for direct unit testing. */
export function matchesPlaceholder(text: string): PlaceholderMatch {
  const trimmed = text.trim()
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.regex.test(trimmed)) {
      return { matched: true, pattern: p.name }
    }
  }
  return { matched: false, pattern: null }
}

// ── Reject list (text-node path only) ───────────────────────────────

/**
 * Common short legitimate words. Locked in source — extend conservatively.
 * Match is case-insensitive exact (trimmed text lowercased, then set lookup).
 */
const COMMON_SHORT_WORDS: ReadonlySet<string> = new Set([
  'ok',
  'yes',
  'no',
  'on',
  'off',
  'new',
  'all',
  'any',
  'none',
  'edit',
  'save',
  'done',
  'back',
  'next',
  'skip',
  'open',
  'close',
  'add',
  'show',
  'hide',
  'sort',
  'view',
  'search',
  'filter',
  'cancel',
  'apply',
  'reset',
  'clear',
  'help',
  'info',
  'more',
  'less',
  'top',
  'end',
])

/**
 * Regex rejections — content that should never be flagged regardless of its
 * shape. Anchored where possible so partial matches inside real copy don't
 * accidentally suppress findings.
 */
const REJECT_PATTERNS: ReadonlyArray<RegExp> = [
  // Numeric-only (digits, commas, dots, spaces). Requires at least one digit
  // so an empty / pure-space string still falls through to the empty flag rule
  // when it comes from a label / clickable path. (Reject is text-node only, and
  // empty text nodes are uncommon, but the digit anchor keeps the rule honest.)
  /^[\d][\d,.\s]*$/,
  // Number with currency or percent symbol. Catches "$99", "₹500", "12.5%",
  // "€1.20" — symbol can lead or trail, and digits/commas/dots make the body.
  /^[\p{Sc}]?\s*\d[\d,.\s]*\s*[\p{Sc}%]?$/u,
  /^\d[\d,.\s]*\s*%$/,
  // Version / code string.
  /^v\s?\d+(?:\.\d+){0,3}$/i, // v1, v1.0, v 1.2.3
  /^\d+(?:\.\d+){1,3}$/, // 1.2, 1.2.3, 1.2.3.4
  /^#[\w-]+$/, // #hash, #3076, #foo-bar
  /^vol\.?\s*\d+$/i, // vol. 2, vol 2
  // URL / email / @handle.
  /^https?:\/\/\S+$/i,
  /^www\.\S+$/i,
  /^\S+\.(?:com|org|net|io|in|gov|edu|co|app|dev|me)(?:\/\S*)?$/i,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^@[\w._-]+$/,
  // Date-ish: slash/dash separated, or month-name patterns.
  /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/, // 01/01/2025, 2025-01-01
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,4}$/i, // Jan 2025
  /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i, // 15 May
  // Time: HH:MM optionally with seconds and AM/PM.
  /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?$/i,
]

/** Pure helper exported for direct unit testing. */
export function isRejected(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (COMMON_SHORT_WORDS.has(trimmed.toLowerCase())) return true
  for (const re of REJECT_PATTERNS) {
    if (re.test(trimmed)) return true
  }
  return false
}

// ── Runner ──────────────────────────────────────────────────────────

export function runHeadingsLabelsCheck(dto: AuditDTO): Finding[] {
  const out: Finding[] = []

  for (const c of dto.clickables) {
    const f = auditClickable(c)
    if (f) out.push(f)
  }
  for (const fi of dto.formInputs) {
    auditFormInputLabels(fi, out)
  }
  for (const t of dto.texts) {
    const f = auditTextNode(t)
    if (f) out.push(f)
  }

  return out
}

function auditClickable(c: ClickableElement): Finding | null {
  // Icon-only — out of scope for 2.4.6, same carve-out 2.4.4 uses.
  if (c.textNormalized === '') return null

  const text = c.textRaw.trim()
  const m = matchesPlaceholder(text)

  if (m.matched) {
    return {
      criterion: '2.4.6',
      status: 'flag',
      scope: 'element',
      nodeId: c.id,
      nodeName: c.name,
      message: `Link text "${text}" looks like a placeholder.`,
      details: {
        severity: 'warning',
        text,
        matchedPattern: m.pattern,
        source: 'clickable',
      },
    }
  }

  return {
    criterion: '2.4.6',
    status: 'pass',
    scope: 'element',
    nodeId: c.id,
    nodeName: c.name,
    message: '2.4.6 — link text appears descriptive.',
  }
}

function auditFormInputLabels(fi: FormInputElement, out: Finding[]): void {
  for (const ct of fi.childTextNodes) {
    if (!ct.isLabel) continue

    const text = ct.text.trim()
    const m = matchesPlaceholder(text)

    if (m.matched) {
      out.push({
        criterion: '2.4.6',
        status: 'flag',
        scope: 'element',
        nodeId: ct.id,
        nodeName: ct.text,
        message: `Label "${text}" looks like a placeholder.`,
        details: {
          severity: 'warning',
          text,
          matchedPattern: m.pattern,
          source: 'form-label',
        },
      })
    } else {
      out.push({
        criterion: '2.4.6',
        status: 'pass',
        scope: 'element',
        nodeId: ct.id,
        nodeName: ct.text,
        message: '2.4.6 — label appears descriptive.',
      })
    }
  }
}

function auditTextNode(t: TextElement): Finding | null {
  const text = t.characters.trim()

  // Reject list runs first — anything that looks like real content (numbers,
  // dates, URLs, currency, common short words) is filtered out before the
  // placeholder check sees it.
  if (isRejected(text)) return null

  const m = matchesPlaceholder(text)
  if (!m.matched) return null

  return {
    criterion: '2.4.6',
    status: 'flag',
    scope: 'element',
    nodeId: t.id,
    nodeName: t.name,
    message: `Text "${text}" looks like a placeholder.`,
    details: {
      severity: 'warning',
      text,
      matchedPattern: m.pattern,
      source: 'text-node',
    },
  }
}
