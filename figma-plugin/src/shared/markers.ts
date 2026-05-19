// Designer-set marker store for the interactivity classifier override.
// Persisted via `figma.clientStorage`, scoped per fileKey, owned by the main
// thread. Pure module — no figma.*, no DOM. Tests live in
// `src/shared/__tests__/markers.test.ts`.
//
// Three states per node:
//   include  → user force-marked this node as clickable
//   exclude  → user force-unmarked it (overrides classifier auto-detection)
//   neutral  → no override; classifier decides
//
// Invariants:
//   - include ∩ exclude = ∅ for any single file. Enforced by setMarkerState
//     and by parseMarkersStore at load time (defensive: exclude wins on a
//     duplicate, since that's the safer override).
//   - Soft cap: MARKERS_FILE_CAP fileKey slots; oldest by lastTouched evicted.
//   - Versioned storage key (`.v1` suffix) allows future migration.

export type MarkerState = 'include' | 'exclude' | 'neutral'

export interface MarkersFile {
  /** Node IDs the user force-marked as clickable. Sorted + deduped. */
  include: string[]
  /** Node IDs the user force-unmarked. Sorted + deduped. */
  exclude: string[]
}

/** Per-fileKey slot — adds a recency timestamp used by the eviction cap. */
interface MarkersFileEntry extends MarkersFile {
  lastTouched: number // unix ms
}

export type MarkersStore = Record<string, MarkersFileEntry>

export const MARKERS_STORAGE_KEY = 'maanak.markers.v1'

/** Pre-rebrand key. Read once by the main-thread migration shim so existing
 *  per-file marker overrides survive the rename. Never written to again. */
export const LEGACY_MARKERS_STORAGE_KEY = 'wcag-auditor.markers.v1'

/** Maximum number of fileKey slots to keep before evicting oldest-by-lastTouched. */
export const MARKERS_FILE_CAP = 50

export const EMPTY_MARKERS_FILE: MarkersFile = { include: [], exclude: [] }

// ── Helpers ─────────────────────────────────────────────────────────

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

function normalizeList(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Defensive parse — accepts any shape from `clientStorage`, drops malformed
 * entries, never throws. On a node id appearing in BOTH lists, exclude wins
 * (safer override; matches the classifier integration semantics).
 */
export function parseMarkersStore(raw: unknown): MarkersStore {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: MarkersStore = {}
  for (const [fileKey, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!fileKey) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>

    const includeRaw = isStringArray(e.include) ? normalizeList(e.include) : []
    const excludeRaw = isStringArray(e.exclude) ? normalizeList(e.exclude) : []
    // Mutex enforcement on load — exclude wins on duplicates.
    const excludeSet = new Set(excludeRaw)
    const include = includeRaw.filter(id => !excludeSet.has(id))

    const lastTouched =
      typeof e.lastTouched === 'number' && Number.isFinite(e.lastTouched)
        ? e.lastTouched
        : 0

    out[fileKey] = { include, exclude: excludeRaw, lastTouched }
  }
  return out
}

/** Return the file's markers, stripping internal `lastTouched`. */
export function getFileMarkers(store: MarkersStore, fileKey: string): MarkersFile {
  const entry = store[fileKey]
  if (!entry) return EMPTY_MARKERS_FILE
  return { include: entry.include, exclude: entry.exclude }
}

/**
 * Write a file's markers. Refreshes `lastTouched`, normalises both lists,
 * enforces the soft cap (oldest-by-lastTouched evicted).
 */
export function setFileMarkers(
  store: MarkersStore,
  fileKey: string,
  file: MarkersFile,
  now: number = Date.now()
): MarkersStore {
  const entry: MarkersFileEntry = {
    include: normalizeList(file.include),
    exclude: normalizeList(file.exclude),
    lastTouched: now,
  }
  return enforceCap({ ...store, [fileKey]: entry })
}

function enforceCap(store: MarkersStore): MarkersStore {
  const keys = Object.keys(store)
  if (keys.length <= MARKERS_FILE_CAP) return store
  // Sort descending by lastTouched, keep the most-recent N.
  keys.sort((a, b) => (store[b].lastTouched ?? 0) - (store[a].lastTouched ?? 0))
  const kept = keys.slice(0, MARKERS_FILE_CAP)
  const out: MarkersStore = {}
  for (const k of kept) out[k] = store[k]
  return out
}

/** Drop ids that no longer resolve to a valid node. Lists stay sorted. */
export function pruneFileMarkers(file: MarkersFile, validIds: Set<string>): MarkersFile {
  return {
    include: file.include.filter(id => validIds.has(id)),
    exclude: file.exclude.filter(id => validIds.has(id)),
  }
}

/** Resolve the state of a single node. Exclude wins (matches the runtime override semantics). */
export function deriveState(file: MarkersFile, nodeId: string): MarkerState {
  if (file.exclude.includes(nodeId)) return 'exclude'
  if (file.include.includes(nodeId)) return 'include'
  return 'neutral'
}

/**
 * Set the state for a single node — always removes from the opposite list first
 * so the include/exclude mutex invariant holds. Click-the-active-CTA semantics
 * (returning `next === current`) are handled by callers; this function just
 * writes the requested state.
 */
export function setMarkerState(
  file: MarkersFile,
  nodeId: string,
  next: MarkerState
): MarkersFile {
  const include = file.include.filter(id => id !== nodeId)
  const exclude = file.exclude.filter(id => id !== nodeId)
  if (next === 'include') include.push(nodeId)
  if (next === 'exclude') exclude.push(nodeId)
  return {
    include: normalizeList(include),
    exclude: normalizeList(exclude),
  }
}
