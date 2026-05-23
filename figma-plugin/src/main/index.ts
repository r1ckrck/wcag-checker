// Main-thread orchestrator. Runs inside Figma's plugin sandbox.
//
// Error-handling policy: surface what matters, swallow what doesn't.
//   - Audit-level failures (DTO build, check run) become `audit-error`
//     messages so the UI can render them.
//   - Per-node export failures (variant thumbs, image candidates) are
//     silently dropped via `tryExportAll` — the UI tolerates missing
//     entries and renders without those visuals.
//   - The top-level message handler wraps every dispatch in try/catch +
//     `figma.notify` so unexpected throws never leave the user staring
//     at a dead plugin.

import type {
  AnyNodeSelectionInfo,
  DescendantInteractive,
  MainToUI,
  SelectionInfo,
  SupportedNodeType,
  UIToMain,
} from '../shared/protocol'
import type { AuditDTO } from '../shared/dtos'
import {
  DEFAULT_SETTINGS,
  parseSettings,
  SETTINGS_STORAGE_KEY,
  LEGACY_SETTINGS_STORAGE_KEY,
  type AiSettings,
} from '../shared/settings.ts'
import {
  EMPTY_MARKERS_FILE,
  MARKERS_STORAGE_KEY,
  LEGACY_MARKERS_STORAGE_KEY,
  getFileMarkers,
  parseMarkersStore,
  pruneFileMarkers,
  setFileMarkers,
  type MarkersFile,
} from '../shared/markers.ts'
import { buildAuditDTO } from '../read/index.ts'
import { buildSpecModel } from '../checks/metadata-model.ts'
import { drawSpecFrame } from './spec-frame.ts'
import { collect } from '../read/traverse.ts'
import { buildClickableElements } from '../read/interactivity.ts'
import { buildFormInputElements } from '../read/form-input.ts'
import { runChecks, runVariantChecks } from '../checks/orchestrator.ts'
import { tryExportAll } from './try-export-all.ts'

// Bug 4 — store the last successfully-built DTO so the user can opt into a
// variant audit later without re-traversing the tree. Cleared on each new
// run-audit / on errors.
let lastDTO: AuditDTO | null = null

// Metadata generator: the node selected when `generate-metadata` fired. The
// frame is drawn at `metadata-finalize` time (after the UI's AI round-trip),
// by which point the selection may have changed — so we pin the node id and
// re-resolve it, drawing beside the originally-selected component.
let pendingMetaNodeId: string | null = null

const SUPPORTED_TYPES: ReadonlyArray<SupportedNodeType> = [
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'FRAME',
]

figma.skipInvisibleInstanceChildren = true

const PLUGIN_WIDTH = 420
const MIN_HEIGHT = 240
const MAX_HEIGHT = 800

figma.showUI(__html__, {
  width: PLUGIN_WIDTH,
  height: MIN_HEIGHT,
  themeColors: false,
  title: 'Maanak — Accessibility Checker',
})

function isSupported(type: NodeType): type is SupportedNodeType {
  return (SUPPORTED_TYPES as ReadonlyArray<string>).includes(type)
}

function classifySelection(): SelectionInfo {
  const sel = figma.currentPage.selection
  if (sel.length === 0) return { kind: 'none' }
  if (sel.length > 1) return { kind: 'multiple', count: sel.length }

  const node = sel[0]
  if (!isSupported(node.type)) {
    return { kind: 'unsupported', nodeType: node.type, nodeName: node.name }
  }

  return {
    kind: 'ok',
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
  }
}

function send(msg: MainToUI): void {
  figma.ui.postMessage(msg)
}

// Export at 2x scale — readable for vision LLM without exploding payload size.
// Returns null on failure so visual review can degrade gracefully in the UI.
async function exportScreenshot(node: SceneNode): Promise<Uint8Array | null> {
  try {
    return await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 },
    })
  } catch {
    return null
  }
}

// Bug 7 — only check images that are large enough to plausibly carry UI text.
// Anything smaller than this is likely a tiny icon-as-image and not worth a
// round-trip to the LLM.
const IMAGE_OF_TEXT_MIN_LONGEST_SIDE = 100

// Sniff a PNG/JPEG/WEBP/GIF MIME from the first few bytes of an image asset.
// Figma doesn't tell us what format `getBytesAsync` returns — it's whatever
// the designer originally uploaded — so we need to identify it ourselves
// before constructing the data URL the vision LLM expects.
function detectImageMime(b: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | null {
  if (b.length < 12) return null
  // PNG  — 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  // JPEG — FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  // GIF  — 47 49 46 38
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  // WEBP — "RIFF" .... "WEBP"
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp'
  return null
}

interface ImageCandidate {
  id: string
  name: string
  /** Raw image asset bytes pulled via `figma.getImageByHash().getBytesAsync()`.
   * NOT a screenshot of the node — that would composite sibling layers
   * (overlays, badges, captions) into the result and produce false
   * "image-of-text" positives for cards/banners. The bytes here are the
   * original upload, format depends on what the designer placed. */
  bytes: Uint8Array
  /** Wire format for the data URL — derived from the byte signature
   * (PNG/JPEG/WEBP/GIF magic bytes). Sent through to the server so the
   * vision LLM gets the correct `data:image/<mime>;base64,…` prefix. */
  mimeType: 'png' | 'jpeg' | 'webp' | 'gif'
}

/**
 * Export 2× PNG thumbs for whichever variant ids the DTO surfaces. Keyed by
 * node id so the UI can look up exactly the variants it needs to render
 * (default / focus / error). Individual export failures fall through silently
 * — the renderer tolerates missing keys.
 */
async function buildVariantThumbs(
  variants: { defaultVariantId: string; focusVariantId: string | null; errorVariantId: string | null } | null
): Promise<Record<string, Uint8Array>> {
  if (!variants) return {}
  const ids = [variants.defaultVariantId, variants.focusVariantId, variants.errorVariantId]
    .filter((id): id is string => typeof id === 'string')
  const entries = await tryExportAll<string, readonly [string, Uint8Array]>(
    ids,
    async id => {
      const node = await figma.getNodeByIdAsync(id)
      if (!node || !('exportAsync' in node)) return null
      const png = await (node as SceneNode).exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      })
      return [id, png] as const
    }
  )
  const out: Record<string, Uint8Array> = {}
  for (const [id, png] of entries) out[id] = png
  return out
}

/**
 * Identify and fetch image assets the AI image-of-text check should evaluate.
 * Skips logo/brand-exempt images (already a pass) and tiny images (decorative
 * icon-as-image fills not worth a round-trip).
 *
 * IMPORTANT: We pull the **raw asset bytes** via `figma.getImageByHash().
 * getBytesAsync()` — NOT a screenshot via `node.exportAsync()`. A node with
 * an image fill can also have child layers (e.g. a "media" frame with a
 * Lorem-Ipsum pill on top); `exportAsync` would composite those children
 * into the result and the vision LLM would correctly but uselessly flag
 * them as UI text. The raw asset bytes are the original upload — no
 * compositing, no overlays — exactly what 1.4.5 needs to judge.
 */
async function buildImageCandidates(dto: { images: Array<{ id: string; name: string; width: number; height: number; isExempt: boolean; imageHash: string | null }> }): Promise<ImageCandidate[]> {
  const eligible = dto.images.filter(
    img =>
      !img.isExempt &&
      Math.max(img.width, img.height) >= IMAGE_OF_TEXT_MIN_LONGEST_SIDE &&
      img.imageHash !== null
  )
  return tryExportAll(eligible, async img => {
    const hash = img.imageHash
    if (!hash) return null
    const image = figma.getImageByHash(hash)
    if (!image) return null
    const bytes = await image.getBytesAsync()
    const mimeType = detectImageMime(bytes)
    if (!mimeType) return null
    return { id: img.id, name: img.name, bytes, mimeType }
  })
}

function postCurrentState(): void {
  send({ kind: 'state', selection: classifySelection() })
}

// ── Marker-mode selection emission ────────────────────────────────────
// `marker-state` is a parallel selection stream for the marking page. It
// accepts ANY SceneNode (vectors, icons, text — not just the four supported
// audit roots) and is gated by `markerWatchOn` so we don't pay the descendant
// walk outside the marking page. The audit-mode `state` stream above stays
// untouched.

let markerWatchOn = false

function classifyForMarking(): AnyNodeSelectionInfo {
  const sel = figma.currentPage.selection
  if (sel.length === 0) return { kind: 'none' }
  if (sel.length > 1) return { kind: 'multiple', count: sel.length }
  const node = sel[0]
  // PAGE / DOCUMENT are not SceneNodes and can't appear in currentPage.selection,
  // so any selected node is markable by construction. The `canMark` field is
  // kept on the wire for future-proofing (e.g. a slide-context extension).
  return {
    kind: 'any',
    id: node.id,
    name: node.name,
    nodeType: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
    canMark: true,
  }
}

/** Hard cap on rows returned to the UI. Anything beyond this gets dropped;
 * the UI surfaces an overflow tail so the designer knows. */
const DESCENDANT_LIST_CAP = 200

/** Heuristic icon-shape bounds. An INSTANCE descendant with no text inside
 * and bbox sitting in this size + aspect window is *probably* a tap-target
 * icon (chevron, voice mic, play, info, etc.). We don't auto-classify these
 * as clickable in the audit (false positives would generate phantom flags)
 * but we DO surface them as marking-page candidates so designers can opt
 * them in. */
const ICON_MIN_PX = 12
const ICON_MAX_PX = 80
const ICON_ASPECT_MIN = 0.7
const ICON_ASPECT_MAX = 1.4

/** True if `node` sits anywhere inside `ancestor`'s subtree. Bails at PAGE /
 * DOCUMENT so we don't walk the whole document for a stale id. */
function isDescendantOf(node: BaseNode, ancestor: BaseNode): boolean {
  let p: BaseNode | null = node.parent
  while (p) {
    if (p.id === ancestor.id) return true
    if (p.type === 'PAGE' || p.type === 'DOCUMENT') return false
    p = p.parent
  }
  return false
}

/** True if any ancestor between `node` and `root` (exclusive on both ends —
 * we don't consider the node itself or the root) is in the Include set.
 * Used to suppress descendants of Include-marked nodes from the marking-page
 * list: when a node is marked Include, everything inside it is hidden, no
 * matter how deeply nested or which frame is currently selected. */
function hasIncludeMarkedAncestor(
  node: BaseNode,
  rootId: string,
  includeSet: Set<string>
): boolean {
  if (includeSet.size === 0) return false
  let p: BaseNode | null = node.parent
  while (p) {
    if (p.id === rootId) return false
    if (p.type === 'PAGE' || p.type === 'DOCUMENT') return false
    if (includeSet.has(p.id)) return true
    p = p.parent
  }
  return false
}

/** True if the node has any visible TEXT descendant. Excludes labelled
 * components (Button/Chip/MenuItem) from the icon-only heuristic — those
 * already classify via the classifier's name regex. */
function hasVisibleTextDescendant(node: SceneNode): boolean {
  if (node.type === 'TEXT') return node.visible !== false
  if (!('findOne' in node)) return false
  const hit = (node as FrameNode).findOne(
    n => n.type === 'TEXT' && n.visible !== false
  )
  return hit !== null
}

/** Icon-shape filter — used to surface unwrapped icon instances (chevron,
 * voice, play, etc.) as marking-page candidates even when their names don't
 * match the classifier's include list. */
function isIconShape(node: SceneNode): boolean {
  const bbox = node.absoluteBoundingBox
  if (!bbox) return false
  const w = bbox.width
  const h = bbox.height
  if (w < ICON_MIN_PX || h < ICON_MIN_PX) return false
  if (w > ICON_MAX_PX || h > ICON_MAX_PX) return false
  if (h === 0) return false
  const ratio = w / h
  return ratio >= ICON_ASPECT_MIN && ratio <= ICON_ASPECT_MAX
}

/**
 * Walk the selected subtree and surface (a) classifier-detected interactives
 * plus (b) any include-marked nodes that live anywhere inside it. The two
 * sets are unioned and deduped — a node detected by the classifier AND
 * marked by the user appears once, with `detected: true` (the auto pill
 * still hides because the marker state is non-neutral when the row renders).
 *
 * Returns at most `DESCENDANT_LIST_CAP` rows; the UI tail-renders an overflow
 * notice when the result is at the cap.
 */
async function collectDescendantInteractives(
  rootId: string,
  file: MarkersFile
): Promise<DescendantInteractive[]> {
  // 1. Resolve the root and bail on anything we can't traverse.
  const root = await figma.getNodeByIdAsync(rootId).catch(() => null)
  if (!root) return []
  if (!('findAllWithCriteria' in root)) {
    // Leaf-type roots (VECTOR / TEXT) — nothing inside to list. Honour the
    // user's include marker on the root itself indirectly through the
    // selection card, not the list.
    return []
  }
  const rootScene = root as SceneNode

  // 2. Mirror the read pipeline's traversal so descendant classification
  //    matches what the audit would emit. Failures here yield empty lists
  //    rather than crashing the marking page.
  let collected: ReturnType<typeof collect>
  try {
    collected = collect(rootScene)
  } catch {
    return []
  }

  // 3. Identify form-input ids first so the clickable classifier can skip
  //    them (matches read/index.ts ordering).
  let formInputIds: string[] = []
  try {
    const formInputs = await buildFormInputElements(collected.instances)
    formInputIds = formInputs.map(f => f.id)
  } catch {
    formInputIds = []
  }

  // 4. Run the classifier — same function the audit calls.
  let clickables: Array<{ id: string; name: string }> = []
  try {
    clickables = await buildClickableElements(
      rootScene,
      collected.instances,
      formInputIds
    )
  } catch {
    clickables = []
  }

  // 5. Build an id→SceneNode lookup for fast node-type retrieval. The same
  //    nodes are already in memory courtesy of collect(), so this is cheap.
  const nodeById = new Map<string, SceneNode>()
  nodeById.set(rootScene.id, rootScene)
  for (const t of collected.texts) nodeById.set(t.id, t)
  for (const v of collected.vectors) nodeById.set(v.id, v)
  for (const s of collected.shapes) nodeById.set(s.id, s)
  for (const i of collected.instances) nodeById.set(i.id, i)

  // 6. Resolve form inputs alongside clickables — they're interactive too,
  //    just classified separately for the audit's 3.3.2 pipeline. Designers
  //    expect to see them in the marking list.
  let formInputs: Array<{ id: string; name: string }> = []
  try {
    formInputs = await buildFormInputElements(collected.instances)
  } catch {
    formInputs = []
  }

  // Build the Include set up-front so every pass can skip descendants of any
  // Include-marked node. The rule: when a node is marked Include, everything
  // inside it is hidden from the list — the marker is the whole story for
  // that branch.
  const includeSet = new Set(file.include)

  // 7. Classifier-detected rows. Skip the root itself — it's surfaced by the
  //    selection card, not the list.
  const seen = new Set<string>()
  const rows: DescendantInteractive[] = []
  for (const c of clickables) {
    if (c.id === rootId) continue
    if (seen.has(c.id)) continue
    const node = nodeById.get(c.id)
    if (node && hasIncludeMarkedAncestor(node, rootId, includeSet)) continue
    seen.add(c.id)
    rows.push({
      id: c.id,
      name: c.name,
      nodeType: node?.type ?? 'UNKNOWN',
      detected: true,
    })
    if (rows.length >= DESCENDANT_LIST_CAP) return rows
  }

  // 8. Form inputs — definitely interactive, surface them as auto-detected.
  for (const fi of formInputs) {
    if (fi.id === rootId) continue
    if (seen.has(fi.id)) continue
    const node = nodeById.get(fi.id)
    if (node && hasIncludeMarkedAncestor(node, rootId, includeSet)) continue
    seen.add(fi.id)
    rows.push({
      id: fi.id,
      name: fi.name,
      nodeType: node?.type ?? 'INSTANCE',
      detected: true,
    })
    if (rows.length >= DESCENDANT_LIST_CAP) return rows
  }

  // 9. Icon-only INSTANCE descendants — likely tap targets the classifier
  //    didn't catch by name. Designers can confirm via Include or override
  //    via Exclude on the marking page. These are intentionally NOT promoted
  //    to the classifier itself (the audit doesn't want decorative icons
  //    flagged), only surfaced here for designer review.
  for (const inst of collected.instances) {
    if (inst.id === rootId) continue
    if (seen.has(inst.id)) continue
    if (hasVisibleTextDescendant(inst)) continue
    if (!isIconShape(inst)) continue
    if (hasIncludeMarkedAncestor(inst, rootId, includeSet)) continue
    seen.add(inst.id)
    rows.push({
      id: inst.id,
      name: inst.name,
      nodeType: inst.type,
      detected: true,
    })
    if (rows.length >= DESCENDANT_LIST_CAP) return rows
  }

  // 10. Include-marked union — any node the user explicitly marked Include
  //     that lives inside this subtree but wasn't surfaced above. Resolved
  //     lazily one at a time; if a marker has gone stale (deleted node) we
  //     skip silently and let the prune cycle clean it up later. We DO still
  //     skip include-marked nodes that themselves sit inside another
  //     Include-marked node — same rule as everywhere else.
  for (const id of file.include) {
    if (seen.has(id)) continue
    if (id === rootId) continue
    const node = await figma.getNodeByIdAsync(id).catch(() => null)
    if (!node) continue
    if (!isDescendantOf(node, rootScene)) continue
    if (hasIncludeMarkedAncestor(node, rootId, includeSet)) continue
    rows.push({
      id,
      name: node.name,
      nodeType: node.type,
      detected: false,
    })
    seen.add(id)
    if (rows.length >= DESCENDANT_LIST_CAP) return rows
  }

  return rows
}

async function emitMarkerState(file: MarkersFile = EMPTY_MARKERS_FILE): Promise<void> {
  if (!markerWatchOn) return
  const selection = classifyForMarking()
  const descendantInteractives =
    selection.kind === 'any'
      ? await collectDescendantInteractives(selection.id, file)
      : []
  send({ kind: 'marker-state', selection, descendantInteractives })
}

// In-memory cache of the current file's markers — refreshed on load/save,
// consulted by `emitMarkerState` so we don't round-trip clientStorage on every
// selectionchange tick.
let currentFileMarkers: MarkersFile = EMPTY_MARKERS_FILE

/** File-scope id used to key the per-file slot in clientStorage.
 *
 * `figma.fileKey` is only exposed for private organization plugins published
 * with `enablePrivatePluginApi`. Local-dev and public-published plugins always
 * see `undefined`. To still scope markers per file we generate an opaque UUID
 * once and stash it in the file's shared plugin data — the file becomes
 * self-identifying without leaking any sensitive payload (the actual markers
 * live in clientStorage, per-user, never in the document).
 *
 * Trade-off: when the same Figma file is opened on a different machine the
 * UUID travels with the file, so the same identifier resolves to that
 * machine's (per-user, possibly empty) clientStorage slot. That matches the
 * spec — markers don't sync across machines, but the file identity is stable.
 */
// Figma's `setSharedPluginData` requires the namespace to be "at least 3
// alphanumeric characters." Hyphens (and other non-alphanumerics) cause the
// call to throw, which previously hit our silent catch and falsely surfaced
// the "Dev Mode is read-only" message. Keep this strictly alphanumeric.
const FILE_ID_NAMESPACE = 'maanak'
// Pre-rebrand namespace. Read once for migration so a file's existing
// scope-id (and therefore its marker overrides) survives the rename.
const LEGACY_FILE_ID_NAMESPACE = 'wcagauditor'
const FILE_ID_KEY = 'fileidv1'

/**
 * Read a clientStorage value, migrating a pre-rebrand key on first run.
 * New-key-wins (idempotent). When only the legacy key exists, its value is
 * copied to the new key and the legacy key deleted — a one-time, transparent
 * move so users keep their saved API key / markers after the rename. If the
 * copy write fails (quota, permissions) the legacy value is still returned so
 * no data is lost this session; the copy retries next run.
 */
async function loadWithMigration(newKey: string, legacyKey: string): Promise<unknown> {
  const current = await figma.clientStorage.getAsync(newKey)
  if (current !== undefined) return current
  let legacy: unknown
  try {
    legacy = await figma.clientStorage.getAsync(legacyKey)
  } catch {
    return undefined
  }
  if (legacy === undefined) return undefined
  try {
    await figma.clientStorage.setAsync(newKey, legacy)
    await figma.clientStorage.deleteAsync(legacyKey)
  } catch {
    // Keep the legacy value for this session; retry the copy next run.
  }
  return legacy
}

function generateFileId(): string {
  // Not cryptographically meaningful — just unique enough to label one file
  // distinctly from another. RFC 4122 isn't necessary here.
  const a = Date.now().toString(36)
  const b = Math.random().toString(36).slice(2, 10)
  const c = Math.random().toString(36).slice(2, 10)
  return `${a}-${b}-${c}`
}

function getFileScopeId(): string | null {
  // Path 1 — official fileKey for private org plugins. Returns immediately
  // when available; almost no local-dev plugins hit this branch.
  if (figma.fileKey) return figma.fileKey

  // Path 2 — read a previously-stashed UUID from the document. Works in
  // both editor mode and dev mode (reads don't require write access).
  let existing = ''
  try {
    existing = figma.root.getSharedPluginData(FILE_ID_NAMESPACE, FILE_ID_KEY)
  } catch (e) {
    // Defensive: any error here is unexpected. Log so we don't silently
    // mistake it for "no file id available".
    // eslint-disable-next-line no-console
    console.error('[wcag-auditor] getSharedPluginData failed:', e)
    existing = ''
  }
  if (existing) return existing

  // Migration: a pre-rebrand file id lives under the old namespace. Carry it
  // forward so marker overrides keyed by this id still resolve. Best-effort
  // re-stash under the new namespace (fails silently in dev read-only mode —
  // we still return the legacy id so this session works).
  let legacyId = ''
  try {
    legacyId = figma.root.getSharedPluginData(LEGACY_FILE_ID_NAMESPACE, FILE_ID_KEY)
  } catch {
    legacyId = ''
  }
  if (legacyId) {
    try {
      figma.root.setSharedPluginData(FILE_ID_NAMESPACE, FILE_ID_KEY, legacyId)
    } catch {
      // Read-only context — keep using the legacy id this session.
    }
    return legacyId
  }

  // Path 3 — create + persist a fresh UUID. Writes require write access to
  // the document; dev mode is read-only and will throw. Anything else (a
  // namespace constraint violation, a permissions edge case) should be
  // logged loudly so it doesn't masquerade as "dev mode".
  try {
    const fresh = generateFileId()
    figma.root.setSharedPluginData(FILE_ID_NAMESPACE, FILE_ID_KEY, fresh)
    return fresh
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[wcag-auditor] setSharedPluginData failed:', e)
    return null
  }
}

/** Batched parallel node-id resolution. Drops only ids that resolve to `null`;
 * keeps ids that threw (transient lookup failures shouldn't permanently
 * destroy valid markers). */
async function collectValidIds(ids: string[]): Promise<Set<string>> {
  const valid = new Set<string>()
  const BATCH = 50
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH)
    const results = await Promise.all(
      batch.map(async id => {
        try {
          const node = await figma.getNodeByIdAsync(id)
          return node ? id : null
        } catch {
          // Transient — keep the id rather than drop a potentially-valid marker.
          return id
        }
      })
    )
    for (const id of results) {
      if (id) valid.add(id)
    }
  }
  return valid
}

/** Load markers for the current file from clientStorage, prune stale ids,
 * persist if pruning changed anything, and return the resolved set. Throws
 * on storage failure; caller maps to `markers-error`. */
async function loadAndPruneMarkers(): Promise<{
  fileKey: string | null
  markers: MarkersFile
}> {
  const fileKey = getFileScopeId()
  if (!fileKey) {
    return { fileKey: null, markers: EMPTY_MARKERS_FILE }
  }
  const raw = await loadWithMigration(MARKERS_STORAGE_KEY, LEGACY_MARKERS_STORAGE_KEY)
  const store = parseMarkersStore(raw)
  const file = getFileMarkers(store, fileKey)

  const allIds = [...file.include, ...file.exclude]
  if (allIds.length === 0) return { fileKey, markers: file }

  const validIds = await collectValidIds(allIds)
  const pruned = pruneFileMarkers(file, validIds)

  // Persist pruned state if anything changed; non-fatal if persistence fails.
  if (
    pruned.include.length !== file.include.length ||
    pruned.exclude.length !== file.exclude.length
  ) {
    try {
      const nextStore = setFileMarkers(store, fileKey, pruned)
      await figma.clientStorage.setAsync(MARKERS_STORAGE_KEY, nextStore)
    } catch {
      // Surfacing this would be noisy and unhelpful — the user can still
      // read/write markers; the cleanup just retries on the next plugin run.
    }
  }
  return { fileKey, markers: pruned }
}

figma.on('selectionchange', () => {
  postCurrentState()
  void emitMarkerState(currentFileMarkers)
})
figma.on('currentpagechange', () => {
  postCurrentState()
  void emitMarkerState(currentFileMarkers)
})

figma.ui.onmessage = async (msg: UIToMain) => {
  try {
    switch (msg.kind) {
      case 'init':
        postCurrentState()
        return
      case 'run-audit': {
        const sel = figma.currentPage.selection
        if (sel.length !== 1) {
          lastDTO = null
          send({ kind: 'audit-error', error: 'Select exactly one component, instance, or frame.' })
          return
        }
        const node = sel[0]
        try {
          // Resolve designer-set markers for the current file so the
          // classifier can honour Include / Exclude overrides. Stale ids
          // are silently pruned by `loadAndPruneMarkers`. Missing fileKey
          // → empty markers, audit runs as if no overrides exist.
          let auditMarkers: MarkersFile = EMPTY_MARKERS_FILE
          try {
            const { markers } = await loadAndPruneMarkers()
            auditMarkers = markers
            currentFileMarkers = markers
          } catch {
            // Storage read failed — proceed without markers. Better partial
            // audit than no audit.
          }
          const dto = await buildAuditDTO(node, {
            markers: {
              include: new Set(auditMarkers.include),
              exclude: new Set(auditMarkers.exclude),
            },
          })
          // Run deterministic checks, screenshot export, image-of-text
          // candidates, and per-variant thumbs in parallel — all four are
          // independent. Individual failures fall through to empty/null.
          const [findings, screenshot, imageCandidates, variantThumbs] = await Promise.all([
            runChecks(dto),
            exportScreenshot(node),
            buildImageCandidates(dto),
            buildVariantThumbs(dto.variants),
          ])
          lastDTO = dto
          send({ kind: 'audit-result', dto, findings, screenshot, imageCandidates, variantThumbs })
        } catch (e) {
          lastDTO = null
          send({ kind: 'audit-error', error: String(e) })
        }
        return
      }
      case 'generate-metadata': {
        const sel = figma.currentPage.selection
        if (sel.length !== 1) {
          send({ kind: 'metadata-error', error: 'Select exactly one component, instance, or frame.' })
          return
        }
        const node = sel[0]
        try {
          let metaMarkers: MarkersFile = EMPTY_MARKERS_FILE
          try {
            const { markers } = await loadAndPruneMarkers()
            metaMarkers = markers
            currentFileMarkers = markers
          } catch {
            // Storage read failed — proceed without overrides.
          }
          const dto = await buildAuditDTO(node, {
            markers: {
              include: new Set(metaMarkers.include),
              exclude: new Set(metaMarkers.exclude),
            },
          })
          const model = buildSpecModel(dto)
          const imageCandidates = await buildImageCandidates(dto)
          pendingMetaNodeId = node.id
          send({ kind: 'metadata-model', model, imageCandidates })
        } catch (e) {
          send({ kind: 'metadata-error', error: String(e) })
        }
        return
      }
      case 'metadata-finalize': {
        try {
          const id = pendingMetaNodeId
          pendingMetaNodeId = null
          const node = id ? await figma.getNodeByIdAsync(id).catch(() => null) : null
          if (!node) {
            send({ kind: 'metadata-error', error: 'The selected component is no longer available.' })
            return
          }
          await drawSpecFrame(msg.model, node as SceneNode)
          send({ kind: 'metadata-generated' })
        } catch (e) {
          // Dev Mode is read-only — createFrame / appendChild throw here.
          const raw = String(e)
          const error = /read-only|readonly|cannot|permission/i.test(raw)
            ? 'Switch to editor mode to generate metadata.'
            : raw
          send({ kind: 'metadata-error', error })
        }
        return
      }
      case 'run-variant-audit': {
        if (!lastDTO) {
          send({ kind: 'variant-error', error: 'No audit yet — run an audit first.' })
          return
        }
        try {
          const buckets = await runVariantChecks(lastDTO)
          send({
            kind: 'variant-result',
            passes: buckets.passes,
            flags: buckets.flags,
            unableToTest: buckets.unableToTest,
          })
        } catch (e) {
          send({ kind: 'variant-error', error: String(e) })
        }
        return
      }
      case 'select-node': {
        // Click-to-select from the findings UI. Read-only side effect: we
        // change the canvas selection + viewport but never re-run the audit
        // (results stay sticky on the originally-audited component).
        try {
          const node = await figma.getNodeByIdAsync(msg.nodeId)
          if (!node || !('absoluteBoundingBox' in node)) return
          const scene = node as SceneNode
          figma.currentPage.selection = [scene]
          figma.viewport.scrollAndZoomIntoView([scene])
        } catch {
          // Node deleted or otherwise unreachable — silent no-op.
        }
        return
      }
      case 'resize': {
        const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, msg.height)))
        figma.ui.resize(PLUGIN_WIDTH, h)
        return
      }
      // ── Per-user AI settings (figma.clientStorage) ────────────────────
      // The UI iframe can't read clientStorage directly — only the main
      // thread has access. UI sends settings-load/save; we round-trip via
      // settings-loaded/saved (or settings-error on the rare clientStorage
      // failure). DEFAULT_SETTINGS surface on first launch / parse miss.
      case 'settings-load': {
        try {
          const raw = await loadWithMigration(SETTINGS_STORAGE_KEY, LEGACY_SETTINGS_STORAGE_KEY)
          send({ kind: 'settings-loaded', settings: parseSettings(raw) })
        } catch (e) {
          // clientStorage failure is exceptional but possible (quota,
          // permissions). Surface as a recoverable settings-error rather
          // than a generic audit-error.
          send({ kind: 'settings-error', reason: `failed to load settings: ${String(e)}` })
          send({ kind: 'settings-loaded', settings: DEFAULT_SETTINGS })
        }
        return
      }
      case 'settings-save': {
        try {
          // Defensive re-parse: trust the wire shape but coerce missing /
          // wrong-typed fields against defaults so a malformed save can't
          // corrupt clientStorage.
          const next: AiSettings = parseSettings(msg.settings)
          await figma.clientStorage.setAsync(SETTINGS_STORAGE_KEY, next)
          send({ kind: 'settings-saved' })
        } catch (e) {
          send({ kind: 'settings-error', reason: `failed to save settings: ${String(e)}` })
        }
        return
      }
      // ── Markers (per-file interactivity overrides) ──────────────────
      case 'markers-load': {
        try {
          const { fileKey, markers } = await loadAndPruneMarkers()
          currentFileMarkers = markers
          if (!fileKey) {
            // Marking is unavailable in this file context (rare: certain
            // playground / pre-save states). UI renders read-only with toast.
            send({ kind: 'markers-error', reason: 'no-file-key' })
            send({ kind: 'markers-loaded', fileKey: null, markers: EMPTY_MARKERS_FILE })
            return
          }
          send({ kind: 'markers-loaded', fileKey, markers })
        } catch (_e) {
          currentFileMarkers = EMPTY_MARKERS_FILE
          send({ kind: 'markers-error', reason: 'storage-failed' })
          send({ kind: 'markers-loaded', fileKey: null, markers: EMPTY_MARKERS_FILE })
        }
        return
      }
      case 'markers-save': {
        const fileKey = getFileScopeId()
        if (!fileKey) {
          send({ kind: 'markers-error', reason: 'no-file-key' })
          return
        }
        try {
          const raw = await loadWithMigration(MARKERS_STORAGE_KEY, LEGACY_MARKERS_STORAGE_KEY)
          const store = parseMarkersStore(raw)
          const nextStore = setFileMarkers(store, fileKey, msg.markers)
          await figma.clientStorage.setAsync(MARKERS_STORAGE_KEY, nextStore)
          currentFileMarkers = getFileMarkers(nextStore, fileKey)
          send({ kind: 'markers-saved' })
          // Re-emit marker-state so the UI's row list reflects any include set
          // changes immediately (commit 3 will use this for auto-row stamping).
          void emitMarkerState(currentFileMarkers)
        } catch (_e) {
          send({ kind: 'markers-error', reason: 'storage-failed' })
        }
        return
      }
      case 'marker-watch': {
        markerWatchOn = msg.on
        if (msg.on) {
          // Synthetic emit so the page paints without waiting for the user
          // to wiggle the cursor.
          void emitMarkerState(currentFileMarkers)
        }
        return
      }
    }
  } catch (e) {
    figma.notify(`Error: ${String(e)}`, { error: true, timeout: 4000 })
  }
}
