import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkersStore,
  getFileMarkers,
  setFileMarkers,
  pruneFileMarkers,
  deriveState,
  setMarkerState,
  EMPTY_MARKERS_FILE,
  MARKERS_FILE_CAP,
  MARKERS_STORAGE_KEY,
  LEGACY_MARKERS_STORAGE_KEY,
  type MarkersFile,
  type MarkersStore,
} from '../markers.ts'

// ── Storage-key rebrand contract ────────────────────────────────────
// The main-thread migration shim relies on these exact strings: the new
// key is what we read/write going forward; the legacy key is read once to
// carry pre-rebrand marker overrides across the "Maanak" rename.
test('markers storage key is the rebranded maanak key', () => {
  assert.equal(MARKERS_STORAGE_KEY, 'maanak.markers.v1')
})

test('legacy markers storage key is the pre-rebrand value', () => {
  assert.equal(LEGACY_MARKERS_STORAGE_KEY, 'wcag-auditor.markers.v1')
})

// ── parseMarkersStore ───────────────────────────────────────────────

test('parseMarkersStore — empty / wrong-type input returns {}', () => {
  assert.deepEqual(parseMarkersStore(null), {})
  assert.deepEqual(parseMarkersStore(undefined), {})
  assert.deepEqual(parseMarkersStore('string'), {})
  assert.deepEqual(parseMarkersStore(42), {})
  assert.deepEqual(parseMarkersStore([]), {})
})

test('parseMarkersStore — accepts a valid record', () => {
  const raw = {
    fileA: { include: ['n1', 'n2'], exclude: ['n3'], lastTouched: 1000 },
    fileB: { include: [], exclude: ['n4'], lastTouched: 2000 },
  }
  const out = parseMarkersStore(raw)
  assert.deepEqual(out.fileA.include, ['n1', 'n2'])
  assert.deepEqual(out.fileA.exclude, ['n3'])
  assert.equal(out.fileA.lastTouched, 1000)
  assert.deepEqual(out.fileB.exclude, ['n4'])
})

test('parseMarkersStore — drops malformed entries silently', () => {
  const raw = {
    good: { include: ['a'], exclude: [], lastTouched: 1 },
    notObject: 'oops',
    arrayEntry: ['n1'],
    nullEntry: null,
    missingFields: {},
  }
  const out = parseMarkersStore(raw)
  assert.ok(out.good)
  assert.equal(out.notObject, undefined)
  assert.equal(out.arrayEntry, undefined)
  assert.equal(out.nullEntry, undefined)
  // missingFields becomes an empty record — still valid
  assert.deepEqual(out.missingFields, { include: [], exclude: [], lastTouched: 0 })
})

test('parseMarkersStore — normalises (sorts + dedupes) include/exclude', () => {
  const raw = {
    f: { include: ['c', 'a', 'b', 'a'], exclude: ['z', 'y', 'y'] },
  }
  const out = parseMarkersStore(raw)
  assert.deepEqual(out.f.include, ['a', 'b', 'c'])
  assert.deepEqual(out.f.exclude, ['y', 'z'])
})

test('parseMarkersStore — exclude wins on duplicate id (mutex enforced on load)', () => {
  const raw = {
    f: { include: ['n1', 'n2'], exclude: ['n2', 'n3'] },
  }
  const out = parseMarkersStore(raw)
  assert.deepEqual(out.f.include, ['n1']) // n2 dropped — appears in exclude
  assert.deepEqual(out.f.exclude, ['n2', 'n3'])
})

test('parseMarkersStore — rejects non-string array entries', () => {
  const raw = {
    f: { include: [1, 2, 3] as unknown as string[], exclude: 'oops' as unknown as string[] },
  }
  const out = parseMarkersStore(raw)
  assert.deepEqual(out.f.include, [])
  assert.deepEqual(out.f.exclude, [])
})

// ── getFileMarkers ──────────────────────────────────────────────────

test('getFileMarkers — returns empty for unknown fileKey', () => {
  const store: MarkersStore = {}
  assert.deepEqual(getFileMarkers(store, 'fileA'), EMPTY_MARKERS_FILE)
})

test('getFileMarkers — strips lastTouched from output', () => {
  const store: MarkersStore = {
    fileA: { include: ['a'], exclude: ['b'], lastTouched: 1000 },
  }
  const out = getFileMarkers(store, 'fileA')
  assert.deepEqual(out, { include: ['a'], exclude: ['b'] })
  assert.equal((out as { lastTouched?: number }).lastTouched, undefined)
})

// ── setFileMarkers ──────────────────────────────────────────────────

test('setFileMarkers — writes normalised entry with lastTouched', () => {
  const store: MarkersStore = {}
  const out = setFileMarkers(store, 'fileA', { include: ['z', 'a'], exclude: [] }, 1234)
  assert.deepEqual(out.fileA.include, ['a', 'z']) // sorted
  assert.equal(out.fileA.lastTouched, 1234)
})

test('setFileMarkers — replaces existing entry, refreshes lastTouched', () => {
  const initial: MarkersStore = {
    fileA: { include: ['a'], exclude: [], lastTouched: 1 },
  }
  const out = setFileMarkers(initial, 'fileA', { include: ['b'], exclude: [] }, 2)
  assert.deepEqual(out.fileA.include, ['b'])
  assert.equal(out.fileA.lastTouched, 2)
})

test('setFileMarkers — soft cap evicts oldest-by-lastTouched', () => {
  let store: MarkersStore = {}
  // Insert MARKERS_FILE_CAP + 5 entries with increasing timestamps.
  for (let i = 0; i < MARKERS_FILE_CAP + 5; i++) {
    store = setFileMarkers(store, `file${i}`, { include: [`n${i}`], exclude: [] }, i)
  }
  const keys = Object.keys(store).sort((a, b) => store[a].lastTouched - store[b].lastTouched)
  assert.equal(keys.length, MARKERS_FILE_CAP)
  // Oldest 5 (file0..file4) should be gone; newest MARKERS_FILE_CAP retained.
  assert.equal(store.file0, undefined)
  assert.equal(store.file4, undefined)
  assert.ok(store.file5)
  assert.ok(store[`file${MARKERS_FILE_CAP + 4}`])
})

// ── pruneFileMarkers ────────────────────────────────────────────────

test('pruneFileMarkers — drops missing ids from both lists', () => {
  const file: MarkersFile = { include: ['a', 'b', 'c'], exclude: ['x', 'y'] }
  const out = pruneFileMarkers(file, new Set(['a', 'c', 'y']))
  assert.deepEqual(out.include, ['a', 'c'])
  assert.deepEqual(out.exclude, ['y'])
})

test('pruneFileMarkers — empty validIds drops everything', () => {
  const file: MarkersFile = { include: ['a', 'b'], exclude: ['x'] }
  const out = pruneFileMarkers(file, new Set())
  assert.deepEqual(out, { include: [], exclude: [] })
})

// ── deriveState ─────────────────────────────────────────────────────

test('deriveState — neutral when not in either list', () => {
  const file: MarkersFile = { include: ['a'], exclude: ['b'] }
  assert.equal(deriveState(file, 'c'), 'neutral')
})

test('deriveState — include when in include list', () => {
  const file: MarkersFile = { include: ['a'], exclude: [] }
  assert.equal(deriveState(file, 'a'), 'include')
})

test('deriveState — exclude wins if id somehow in both (safety net)', () => {
  // Note: setMarkerState prevents this state, but parseMarkersStore also
  // protects on load. deriveState applies one more layer of safety.
  const file: MarkersFile = { include: ['a'], exclude: ['a'] }
  assert.equal(deriveState(file, 'a'), 'exclude')
})

// ── setMarkerState ──────────────────────────────────────────────────

test('setMarkerState — neutral → include adds to include only', () => {
  const file: MarkersFile = { include: [], exclude: [] }
  const out = setMarkerState(file, 'a', 'include')
  assert.deepEqual(out.include, ['a'])
  assert.deepEqual(out.exclude, [])
})

test('setMarkerState — neutral → exclude adds to exclude only', () => {
  const file: MarkersFile = { include: [], exclude: [] }
  const out = setMarkerState(file, 'a', 'exclude')
  assert.deepEqual(out.include, [])
  assert.deepEqual(out.exclude, ['a'])
})

test('setMarkerState — include → exclude moves id (replace, not duplicate)', () => {
  const file: MarkersFile = { include: ['a'], exclude: [] }
  const out = setMarkerState(file, 'a', 'exclude')
  assert.deepEqual(out.include, [])
  assert.deepEqual(out.exclude, ['a'])
})

test('setMarkerState — exclude → include moves id (replace)', () => {
  const file: MarkersFile = { include: [], exclude: ['a'] }
  const out = setMarkerState(file, 'a', 'include')
  assert.deepEqual(out.include, ['a'])
  assert.deepEqual(out.exclude, [])
})

test('setMarkerState — include → neutral clears the id', () => {
  const file: MarkersFile = { include: ['a', 'b'], exclude: [] }
  const out = setMarkerState(file, 'a', 'neutral')
  assert.deepEqual(out.include, ['b'])
  assert.deepEqual(out.exclude, [])
})

test('setMarkerState — exclude → neutral clears the id', () => {
  const file: MarkersFile = { include: [], exclude: ['a', 'b'] }
  const out = setMarkerState(file, 'b', 'neutral')
  assert.deepEqual(out.include, [])
  assert.deepEqual(out.exclude, ['a'])
})

test('setMarkerState — mutex preserved across many writes', () => {
  let file: MarkersFile = { include: [], exclude: [] }
  file = setMarkerState(file, 'a', 'include')
  file = setMarkerState(file, 'a', 'exclude')
  file = setMarkerState(file, 'a', 'include')
  file = setMarkerState(file, 'a', 'exclude')
  // Final state: exclude only, never both.
  assert.deepEqual(file.include, [])
  assert.deepEqual(file.exclude, ['a'])
})

test('setMarkerState — does not affect other ids', () => {
  const file: MarkersFile = { include: ['a', 'b'], exclude: ['c'] }
  const out = setMarkerState(file, 'a', 'exclude')
  assert.deepEqual(out.include, ['b'])
  assert.deepEqual(out.exclude, ['a', 'c'])
})
