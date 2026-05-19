// Classify nodes as clickable / tap targets for criteria that care about
// user-intent-to-click — SC 2.4.4 (Link Purpose), SC 2.5.8 (Touch Target), etc.
//
// Distinct from src/read/non-text-contrast.ts, which finds non-text contrast targets
// (vectors, shapes, icons) regardless of clickability. Naming kept separate so
// callers can pick the right signal.
//
// Signals (priority chain — first match wins; all firing signals recorded):
//   1. Component-name match — main-component or component-set name maps to an
//      interactive component (Button, Link, IconButton, Chip, Tab, MenuItem, …)
//      via a slash- and camelCase-aware morpheme matcher with explicit
//      container exclusions (ButtonGroup, Tabs, Menu, Toolbar, Navigation).
//   2. Variant states — the owning ComponentSet has at least one variant
//      whose name or property values look like an interactive state
//      (Hover / Focus / Pressed / Active / Selected).
//   3. Icon wrapper — small, near-square frame/instance with a visible vector
//      descendant and an icon-ish name (Info, Help, Close, Search, etc.).
//
// Form inputs are excluded (they ride the form-input DTO path).
//
// Error-handling policy: silent fallback. Per-node failures (missing main
// component, missing bbox, hidden) return `null` and the element simply
// doesn't appear in the DTO.

import type {
  BBox,
  ClickableElement,
  ClickableSignal,
} from '../shared/dtos'
import { toBBox } from './geometry.ts'
import { isFormInputName } from './regex.ts'
import { shapeMeta } from './shape.ts'

// ── Name matching ───────────────────────────────────────────────────

const SIMPLE_INCLUDE = new Set([
  'button',
  'btn',
  'link',
  'chip',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'toggle',
  'dropdown',
  'select',
  'combobox',
])

// Container-pattern excludes removed per user feedback: `tabs`, `menu`,
// `toolbar`, `navigation` were too aggressive — they were blocking real
// clickables like `navigation/voice` and `Tabs/Single`. `navbar` stays
// because it's almost always a layout container, never a single target.
const SIMPLE_EXCLUDE = new Set(['navbar'])

// Words that ONLY make sense as a single morpheme — checked against a
// punctuation-stripped flatten of the name so `Menu Item`, `MenuItem`, and
// `menu-item` all match `menuitem`.
const COMPOUND_INCLUDE = [
  'menuitem',
  'navitem',
  'listitem',
  'iconbutton',
  'iconbtn',
]

const COMPOUND_EXCLUDE = [
  'buttongroup',
  'checkboxgroup',
  'radiogroup',
  'tabgroup',
]

const INTERACTIVE_STATE_RE =
  /\b(hover|hovered|focus|focused|focus[-_\s]?visible|pressed|active|selected)\b/i

const ICON_MIN_SIDE = 12
const ICON_MAX_SIDE = 48
const ICON_MIN_ASPECT = 0.75
const ICON_MAX_ASPECT = 1.33

const ICON_SIMPLE_INCLUDE = new Set([
  'info',
  'help',
  'more',
  'close',
  'menu',
  'search',
  'settings',
  'gear',
  'chevron',
  'caret',
  'arrow',
  'back',
  'forward',
  'download',
  'upload',
  'share',
  'copy',
  'edit',
  'delete',
  'plus',
  'minus',
  'check',
  'x',
  'question',
  'warning',
])

const ICON_COMPOUND_INCLUDE = ['externallink']

const ICON_SIMPLE_REJECT = new Set([
  'button',
  'chip',
  'tab',
  'link',
  'input',
  'select',
  'dropdown',
  'card',
  'label',
  'logo',
  'brand',
  'decorative',
  'separator',
  'divider',
])

function flatten(name: string): string {
  return name.toLowerCase().replace(/[\s\-_/.]+/g, '')
}

function splitMorphemes(name: string): string[] {
  return name
    // camelCase split: insert a space before each capital that follows a lowercase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // handle ALLCAPSWord runs (split between the run and the next CamelCase)
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s/\-_.]+/)
    .filter(Boolean)
    .map(s => s.toLowerCase())
}

/**
 * True if `name` looks like a clickable component (Button, Link, Chip, etc.).
 *
 * Compound-include patterns (MenuItem, IconButton) are checked first on the
 * flattened name so they beat single-morpheme excludes — `MenuItem` is
 * clickable even though `Menu` alone is a container.
 */
export function isClickableName(name: string): boolean {
  if (!name) return false
  const flat = flatten(name)
  if (COMPOUND_INCLUDE.some(p => flat.includes(p))) return true
  if (COMPOUND_EXCLUDE.some(p => flat.includes(p))) return false
  const morphemes = splitMorphemes(name)
  if (morphemes.some(m => SIMPLE_EXCLUDE.has(m))) return false
  return morphemes.some(m => SIMPLE_INCLUDE.has(m))
}

/**
 * True if a component set has at least one variant whose name or property
 * values look like an interactive state — strong signal that the parent
 * component is meant to be tapped.
 */
export function hasInteractiveVariants(compSet: ComponentSetNode): boolean {
  for (const child of compSet.children) {
    if (child.type !== 'COMPONENT') continue
    const comp = child as ComponentNode
    const propValues = Object.values(comp.variantProperties ?? {})
    const haystack = [comp.name, ...propValues].join(' ')
    if (INTERACTIVE_STATE_RE.test(haystack)) return true
  }
  return false
}

function hasIconishName(name: string): boolean {
  if (!name) return false
  const flat = flatten(name)
  if (ICON_COMPOUND_INCLUDE.some(p => flat.includes(p))) return true
  const morphemes = splitMorphemes(name)
  if (morphemes.some(m => ICON_SIMPLE_REJECT.has(m))) return false
  return morphemes.some(m => ICON_SIMPLE_INCLUDE.has(m))
}

function isIconWrapperCandidate(node: SceneNode): boolean {
  if (node.type !== 'FRAME' && node.type !== 'INSTANCE') return false
  if (!node.absoluteBoundingBox) return false
  const { width, height } = node.absoluteBoundingBox
  if (width < ICON_MIN_SIDE || height < ICON_MIN_SIDE) return false
  if (width > ICON_MAX_SIDE || height > ICON_MAX_SIDE) return false
  if (height === 0) return false
  const aspect = width / height
  if (aspect < ICON_MIN_ASPECT || aspect > ICON_MAX_ASPECT) return false
  if (!('findAllWithCriteria' in node)) return false
  const vectors = (node as FrameNode).findAllWithCriteria({
    types: ['VECTOR', 'BOOLEAN_OPERATION'],
  })
  return vectors.some(v => v.visible !== false)
}

// ── Link-text normalization ─────────────────────────────────────────

/**
 * Normalize link/button text for the vague-text match in 2.4.4. Strips
 * directional arrows / chevrons, collapses whitespace, drops trailing
 * punctuation, and lowercases. Returns an empty string for empty input.
 */
export function normalizeLinkText(raw: string): string {
  return raw
    .replace(/[→↦↗➜▶▸›»>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,:;!?]+$/u, '')
    .trim()
    .toLowerCase()
}

// ── Builder ─────────────────────────────────────────────────────────

/** Designer-set marker overrides passed into `buildClickableElements`.
 *  Exclude wins over every other signal; Include forces classification with
 *  signal `'designer-marked'`. */
export interface MarkersForClassifier {
  include: Set<string>
  exclude: Set<string>
}

const EMPTY_MARKERS: MarkersForClassifier = {
  include: new Set(),
  exclude: new Set(),
}

interface BuildContext {
  formInputIds: Set<string>
  /** Memo: COMPONENT_SET id → has-interactive-state. Avoids re-walking variants
   * for every instance of the same button. */
  setHasInteractiveStateCache: Map<string, boolean>
  markers: MarkersForClassifier
  rootId: string
}

async function getOwningComponentSet(node: SceneNode): Promise<ComponentSetNode | null> {
  if (node.type === 'COMPONENT_SET') return node
  if (node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') {
    return node.parent
  }
  if (node.type === 'INSTANCE') {
    try {
      const main = await node.getMainComponentAsync()
      if (main && main.parent?.type === 'COMPONENT_SET') return main.parent
    } catch {
      return null
    }
  }
  return null
}

async function getCanonicalName(node: SceneNode): Promise<string> {
  if (node.type === 'INSTANCE') {
    try {
      const main = await node.getMainComponentAsync()
      if (main?.parent?.type === 'COMPONENT_SET') return main.parent.name
      if (main) return main.name
    } catch {
      // fall through to layer name
    }
  }
  return node.name
}

function collectVisibleText(node: SceneNode): string {
  if (!('findAllWithCriteria' in node)) {
    return node.type === 'TEXT' ? (node as TextNode).characters : ''
  }
  const texts = (node as FrameNode).findAllWithCriteria({ types: ['TEXT'] })
  const parts: string[] = []
  for (const t of texts) {
    if (t.visible === false) continue
    parts.push((t as TextNode).characters)
  }
  return parts.join(' ')
}

async function classifyOne(
  node: SceneNode,
  ctx: BuildContext
): Promise<ClickableElement | null> {
  if (node.visible === false) return null
  if (!node.absoluteBoundingBox) return null
  // Designer-set Exclude wins over every other signal. Returning null also
  // covers the rare case where the user excluded a form-input id (form inputs
  // ride their own DTO path; the exclude is a no-op there but consistent).
  if (ctx.markers.exclude.has(node.id)) return null
  if (ctx.formInputIds.has(node.id)) return null

  // Include-marked ancestors absorb their whole subtree. The marked ancestor
  // itself may classify; descendants should not be reported as separate
  // targets, even if they also match the automatic classifier.
  let p: BaseNode | null = node.parent
  while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') {
    if (p.id === ctx.rootId) break
    if (ctx.markers.include.has(p.id)) return null
    p = p.parent
  }

  const canonicalName = await getCanonicalName(node)
  // Belt-and-braces: even if buildFormInputElements rejected this node on
  // shape grounds, we don't want to re-announce it as a generic clickable.
  if (isFormInputName(canonicalName)) return null

  const signals: ClickableSignal[] = []
  let componentName: string | null = null

  if (isClickableName(canonicalName)) {
    signals.push('component-name')
    componentName = canonicalName
  }

  if (isIconWrapperCandidate(node) && hasIconishName(canonicalName)) {
    signals.push('icon-wrapper')
    if (componentName === null) componentName = canonicalName
  }

  const compSet = await getOwningComponentSet(node)
  if (compSet) {
    let interactive = ctx.setHasInteractiveStateCache.get(compSet.id)
    if (interactive === undefined) {
      interactive = hasInteractiveVariants(compSet)
      ctx.setHasInteractiveStateCache.set(compSet.id, interactive)
    }
    if (interactive) {
      signals.push('variant-states')
      if (componentName === null) componentName = compSet.name
    }
  }

  // Designer-set Include forces classification even when no automatic signal
  // fired. The classifier still respected exclude at the top of this function,
  // so include can never override exclude — that mutex is enforced upstream.
  if (ctx.markers.include.has(node.id)) {
    signals.push('designer-marked')
    if (componentName === null) componentName = node.name
  }

  if (signals.length === 0) return null

  const textRaw = collectVisibleText(node)
  const bbox: BBox = toBBox(node.absoluteBoundingBox)
  const shape = shapeMeta(node)

  return {
    kind: 'clickable',
    id: node.id,
    name: node.name,
    nodeType: shape.nodeType,
    cornerRadius: shape.cornerRadius,
    componentName,
    textRaw,
    textNormalized: normalizeLinkText(textRaw),
    signals,
    bbox,
  }
}

/** True when `node` is anywhere inside `ancestor`'s subtree. Bails at PAGE /
 * DOCUMENT so we don't walk into other pages chasing a stale id. */
function isDescendantOfNode(node: BaseNode, ancestor: BaseNode): boolean {
  let p: BaseNode | null = node.parent
  while (p) {
    if (p.id === ancestor.id) return true
    if (p.type === 'PAGE' || p.type === 'DOCUMENT') return false
    p = p.parent
  }
  return false
}

/**
 * Identify clickable / tap-target elements inside the audited subtree.
 *
 * Candidates, in priority order:
 *   1. The root itself (when COMPONENT / COMPONENT_SET / INSTANCE) — covers
 *      "the audited node IS the button".
 *   2. Every INSTANCE descendant — components dropped into a layout.
 *   3. Small icon-wrapper FRAME / INSTANCE descendants.
 *   4. FRAME / GROUP / TEXT descendants (and the root, if FRAME/GROUP)
 *      whose layer NAME matches the clickable regex. Covers the ad-hoc case
 *      where a designer types "Click here" as a TextNode named "link" without
 *      wrapping it in a component.
 *
 * Form inputs are excluded by id and by name guard.
 */
export async function buildClickableElements(
  root: SceneNode,
  instances: InstanceNode[],
  formInputIds: Iterable<string>,
  markers: MarkersForClassifier = EMPTY_MARKERS
): Promise<ClickableElement[]> {
  const ctx: BuildContext = {
    formInputIds: new Set(formInputIds),
    setHasInteractiveStateCache: new Map(),
    markers,
    rootId: root.id,
  }

  const candidates: SceneNode[] = []
  const seen = new Set<string>()
  const add = (n: SceneNode): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    candidates.push(n)
  }

  if (
    root.type === 'COMPONENT' ||
    root.type === 'COMPONENT_SET' ||
    root.type === 'INSTANCE'
  ) {
    add(root)
  }
  for (const inst of instances) {
    add(inst)
  }

  if ((root.type === 'FRAME' || root.type === 'INSTANCE') && isIconWrapperCandidate(root)) {
    add(root)
  }
  if ('findAllWithCriteria' in root) {
    const iconNodes = (root as FrameNode).findAllWithCriteria({
      types: ['FRAME', 'INSTANCE'],
    })
    for (const n of iconNodes) {
      if (n.visible === false) continue
      if (!isIconWrapperCandidate(n)) continue
      add(n)
    }
  }

  // Name-based fallback: any FRAME / GROUP / TEXT (incl. root) whose layer
  // name matches the clickable regex. A text node named "link" with content
  // "click here" is a clear intent signal even without a component wrapper.
  if ((root.type === 'FRAME' || root.type === 'GROUP') && isClickableName(root.name)) {
    add(root)
  }
  if ('findAllWithCriteria' in root) {
    const namedNodes = (root as FrameNode).findAllWithCriteria({
      types: ['FRAME', 'GROUP', 'TEXT'],
    })
    for (const n of namedNodes) {
      if (n.visible === false) continue
      if (!isClickableName(n.name)) continue
      add(n)
    }
  }

  // Designer-set Include pre-pass — for every node the user explicitly
  // marked Include that isn't already a candidate (e.g., a loose vector),
  // resolve it and add to the list IF it lives inside the audited subtree.
  // Excluded ids are silently dropped (no point resolving — classifyOne
  // would reject them anyway).
  if (markers.include.size > 0) {
    for (const id of markers.include) {
      if (seen.has(id)) continue
      if (markers.exclude.has(id)) continue
      // Skip resolution failures silently — stale marker ids are pruned on
      // the next plugin run.
      const node = await figma.getNodeByIdAsync(id).catch(() => null)
      if (!node) continue
      if (!('absoluteBoundingBox' in node)) continue
      const scene = node as SceneNode
      if (scene.id !== root.id && !isDescendantOfNode(scene, root)) continue
      add(scene)
    }
  }

  // Classify every candidate first, then apply ancestry dedup against the set
  // of nodes that ACTUALLY classified as clickable. This matters for the case
  // where the audited root is an INSTANCE (or COMPONENT_SET): the root is
  // added to candidates unconditionally as a safety net, but most roots don't
  // themselves classify. Previously the unclassified root sat in the candidate
  // id set and killed every descendant via the ancestry check. Now an
  // unclassified ancestor passes through unnoticed — only ancestors that
  // genuinely became clickable elements cause descendants to be dropped.
  //
  // Dedup intent (unchanged): "a `button` frame containing a `link` text
  // reports once at the button level". When both classify, the inner one is
  // dropped because its outer is a real clickable.
  const classified = await Promise.all(
    candidates.map(async c => {
      const result = await classifyOne(c, ctx)
      return { candidate: c, result }
    })
  )
  const clickableIds = new Set<string>()
  for (const { candidate, result } of classified) {
    if (result !== null) clickableIds.add(candidate.id)
  }

  const out: ClickableElement[] = []
  for (const { candidate, result } of classified) {
    if (result === null) continue
    let p: BaseNode | null = candidate.parent
    let droppedByAncestor = false
    while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') {
      if (clickableIds.has(p.id)) {
        droppedByAncestor = true
        break
      }
      p = p.parent
    }
    if (!droppedByAncestor) out.push(result)
  }
  return out
}
