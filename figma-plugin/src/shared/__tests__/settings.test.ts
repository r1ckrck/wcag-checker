import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SETTINGS_STORAGE_KEY,
  LEGACY_SETTINGS_STORAGE_KEY,
} from '../settings.ts'

// Storage-key rebrand contract. The main-thread migration shim
// (loadWithMigration) reads the legacy key once and copies it to the new
// key so users keep their saved API key across the "Maanak" rename.
test('settings storage key is the rebranded maanak key', () => {
  assert.equal(SETTINGS_STORAGE_KEY, 'maanak.settings.v1')
})

test('legacy settings storage key is the pre-rebrand value', () => {
  assert.equal(LEGACY_SETTINGS_STORAGE_KEY, 'wcag-aa-auditor.settings.v1')
})
