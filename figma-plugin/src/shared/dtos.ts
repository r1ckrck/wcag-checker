// AuditDTO contract — produced by src/read pipeline, consumed by src/checks (Step 4).
// Lives in shared/ so both main thread and UI can type-check the audit message.

// ── Color primitives ────────────────────────────────────────────────
export type RGB = readonly [r: number, g: number, b: number]
export type RGBA = readonly [r: number, g: number, b: number, a: number]

export type ColorSourceUnresolvableReason =
  | 'gradient'
  | 'image'
  | 'pattern'
  | 'video'
  | 'mixed'
  | 'invisible'
  | 'unknown'

export type ColorSource =
  | { kind: 'raw' }
  | { kind: 'style'; styleId: string; styleName: string }
  | {
      kind: 'variable'
      variableId: string
      variableName: string
      modeId: string
      modeName: string
      collectionId: string
      collectionName: string
    }
  | { kind: 'unresolvable'; reason: ColorSourceUnresolvableReason }

export interface ResolvedFill {
  hex: string | null
  rgba: RGBA | null
  source: ColorSource
}

export type BackgroundUnresolvableReason =
  | 'gradient'
  | 'image'
  | 'pattern'
  | 'video'
  | 'no-ancestor'
  | 'transparent-stack'

export type BackgroundSample =
  | { kind: 'solid'; hex: string; rgba: RGBA; source: ColorSource; ancestorId: string }
  | { kind: 'unresolvable'; reason: BackgroundUnresolvableReason }

// ── Geometry ────────────────────────────────────────────────────────
export interface BBox {
  x: number
  y: number
  width: number
  height: number
}

// ── Element DTOs ────────────────────────────────────────────────────
export interface TextSegment {
  start: number
  end: number
  fontFamily: string
  fontStyle: string
  fontWeight: number
  fontSize: number
  lineHeightUnit: 'PIXELS' | 'PERCENT' | 'AUTO'
  lineHeightPx: number | null
  letterSpacingPx: number
  textCase: TextCase
  textDecoration: TextDecoration
  fill: ResolvedFill
}

export interface TextElement {
  kind: 'text'
  id: string
  name: string
  characters: string
  textAutoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'TRUNCATE'
  /** True when the source string contains no hard line break (`\n`) — i.e.
   * a single paragraph. Used for paragraph-spacing skip. Does NOT imply the
   * text renders on one visual line. */
  isSingleLine: boolean
  /** True when the rendered text actually fits on one visual line — derived
   * from bbox height vs effective line-height. Used for the line-height
   * auto-pass: a one-line block has no rendered line-height effect. */
  isSingleVisualLine: boolean
  /** Figma's `paragraphSpacing` (px). Lives on the text node, not segments.
   * `null` if unavailable (e.g. mixed-property edge case). */
  paragraphSpacingPx: number | null
  segments: TextSegment[]
  background: BackgroundSample
  bbox: BBox
  parentChain: string[]
}

export interface NonTextContrastElement {
  kind: 'non-text-contrast'
  id: string
  name: string
  // Drawn shapes (RECTANGLE / ELLIPSE / POLYGON / STAR / LINE) are included
  // alongside vectors and instances so 1.4.11 covers carousel dots, divider
  // chips, status pills, etc. — anything visually drawn that's not pure
  // background chrome.
  nodeType:
    | 'VECTOR'
    | 'BOOLEAN_OPERATION'
    | 'INSTANCE'
    | 'RECTANGLE'
    | 'ELLIPSE'
    | 'POLYGON'
    | 'STAR'
    | 'LINE'
  fill: ResolvedFill | null
  stroke: ResolvedFill | null
  strokeWeight: number | null
  background: BackgroundSample
  isIconOnly: boolean
  bbox: BBox
}

export interface ImageElement {
  kind: 'image'
  id: string
  name: string
  width: number
  height: number
  isExempt: boolean
  /** Hash of the first visible IMAGE paint on the node. Used by the
   * image-of-text AI check to fetch the *raw* asset bytes via
   * `figma.getImageByHash().getBytesAsync()` instead of `exportAsync`,
   * which would composite any sibling layers (overlays, badges, captions)
   * into the result and trigger false positives. */
  imageHash: string | null
}

export interface FormInputChildText {
  id: string
  text: string
  isInsideInput: boolean
  /**
   * True when the text node's own name OR any ancestor frame name (between the
   * text and the input root) matches a label-ish pattern (title / label /
   * caption). Lets the runner recognize labels that are nested inside the
   * form-input component itself, not as external siblings.
   */
  isLabel: boolean
}

export interface FormInputElement {
  kind: 'form-input'
  id: string
  name: string
  nodeType: string
  cornerRadius: number | null
  mainComponentName: string
  childTextNodes: FormInputChildText[]
  hasExternalLabel: boolean
  bbox: BBox
}

export type ClickableSignal =
  | 'component-name'
  | 'variant-states'
  | 'icon-wrapper'
  | 'designer-marked'

/**
 * A node classified as a clickable / tap target. Used by criteria that care
 * about *user intent* to click — Link Purpose (2.4.4), Touch Target (2.5.8),
 * etc. Distinct from `NonTextContrastElement` (which lives in
 * src/read/non-text-contrast.ts and finds non-text contrast targets —
 * vectors, shapes, icons — regardless of clickability).
 *
 * Identification is deliberately conservative: component-name regex match,
 * interactive variant states (Hover / Focus / Pressed), icon-wrapper heuristic,
 * or designer Include marker. Form inputs are excluded — they ride their own
 * DTO path and aren't relevant to 2.4.4.
 *
 * Plain text content (all visible text descendants, normalized) is captured
 * up-front so runners stay pure DTO consumers.
 */
export interface ClickableElement {
  kind: 'clickable'
  id: string
  name: string
  nodeType: string
  cornerRadius: number | null
  /** Name of the component-set or main component that fired the name signal, if any. */
  componentName: string | null
  /** All visible text descendants joined in document order, raw (untrimmed). */
  textRaw: string
  /** Same text after normalization (lowercase, trimmed, punctuation/arrows stripped). */
  textNormalized: string
  /** All signals that classified this node as clickable. */
  signals: ClickableSignal[]
  bbox: BBox
}

export interface VariantInfo {
  id: string
  name: string
  properties: Record<string, string>
}

export interface VariantData {
  componentSetId: string
  componentSetName: string
  defaultVariantId: string
  variants: VariantInfo[]
  focusVariantId: string | null
  errorVariantId: string | null
  otherVariantNames: string[]
}

// ── Top-level ───────────────────────────────────────────────────────
// Single source of truth for the four supported root types lives in
// shared/protocol.ts as `SupportedNodeType` (the UI/main-thread message
// contract uses it). Re-aliased here so the DTO layer can refer to it
// without an extra import in every consumer.
import type { SupportedNodeType } from './protocol'
export type SupportedComponentType = SupportedNodeType

export interface ComponentMeta {
  id: string
  name: string
  type: SupportedComponentType
  width: number
  height: number
  pageId: string
  pageName: string
  modeName: string | null
}

export interface AuditDTO {
  component: ComponentMeta
  texts: TextElement[]
  nonTextContrast: NonTextContrastElement[]
  images: ImageElement[]
  formInputs: FormInputElement[]
  clickables: ClickableElement[]
  variants: VariantData | null
  warnings: string[]
}
