// Build script — esbuild for both bundles + HTML inliner for the UI single-file.
// Usage: node scripts/build.mjs [--watch]

import * as esbuild from 'esbuild'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const ASSETS = path.join(ROOT, 'assets')
const DIST = path.join(ROOT, 'dist')

const MAIN_ENTRY = path.join(SRC, 'main', 'index.ts')
const UI_ENTRY = path.join(SRC, 'ui', 'index.ts')
const UI_HTML = path.join(SRC, 'ui', 'index.html')
const UI_CSS = path.join(SRC, 'ui', 'styles.css')
const TOKENS_CSS = path.join(ASSETS, 'tokens.css')
const MONOGRAM_SVG = path.join(ASSETS, 'monogram.svg')
const FONTS_DIR = path.join(ASSETS, 'fonts')
const PROMPTS_DIR = path.join(ASSETS, 'prompts')
const VISUAL_REVIEW_PROMPT_FILE = path.join(PROMPTS_DIR, 'visual-review.txt')
const IMAGE_OF_TEXT_PROMPT_FILE = path.join(PROMPTS_DIR, 'image-of-text.txt')
const PHOSPHOR_DIR = path.join(ASSETS, 'icons', 'phosphor')

// Fonts to inline as base64 woff2 inside @font-face rules. The plugin iframe
// can't fetch external font files (Figma's CSP blocks it; the manifest's
// networkAccess only permits the configured AI provider domains), so the
// bytes ship in ui.html. General Sans is variable (one file = all weights);
// JetBrains Mono covers the three weights the CSS actually uses (400/500/700).
const FONT_FACES = [
  {
    family: 'General Sans',
    file: path.join(FONTS_DIR, 'general-sans', 'GeneralSans-Variable.woff2'),
    weight: '200 700',
    style: 'normal',
  },
  {
    family: 'JetBrains Mono',
    file: path.join(FONTS_DIR, 'jetbrains-mono', 'JetBrainsMono-Regular.woff2'),
    weight: '400',
    style: 'normal',
  },
  {
    family: 'JetBrains Mono',
    file: path.join(FONTS_DIR, 'jetbrains-mono', 'JetBrainsMono-Medium.woff2'),
    weight: '500',
    style: 'normal',
  },
  {
    family: 'JetBrains Mono',
    file: path.join(FONTS_DIR, 'jetbrains-mono', 'JetBrainsMono-Bold.woff2'),
    weight: '700',
    style: 'normal',
  },
]
// Phosphor Duotone is the locked icon system for the plugin (see CLAUDE.md →
// Iconography). To add a new icon: drop the SVG into assets/icons/phosphor/
// and append the name here.
const PHOSPHOR_ICON_NAMES = ['check', 'warning', 'prohibit', 'cog', 'cursor-click', 'arrow-left']

const MAIN_OUT = path.join(DIST, 'main.js')
const UI_OUT = path.join(DIST, 'ui.html')

const watch = process.argv.includes('--watch')
const dev = watch

const PLACEHOLDERS = {
  css: '/* INLINE_CSS */',
  js: '/* INLINE_JS */',
  monogram: '/* INLINE_MONOGRAM */',
  sprite: '<!-- INLINE_PHOSPHOR_SPRITE -->',
}

// ── Token consistency check ───────────────────────────────────────
// Verifies the local copy of tokens in styles.css mirrors assets/tokens.css.
// We don't fail the build — just warn. Single source of truth lives in assets/.
async function verifyTokenSync() {
  const tokens = await readFile(TOKENS_CSS, 'utf8')
  const local = await readFile(UI_CSS, 'utf8')
  const tokenColors = ['--bg', '--fg', '--mute', '--hairline', '--accent']
  const missing = tokenColors.filter(t => !local.includes(t))
  if (missing.length > 0) {
    console.warn(`[tokens] styles.css missing tokens: ${missing.join(', ')}`)
  }
  // Lightweight value cross-check on light-mode colors.
  // Normalize whitespace, case, and trailing zeros so that #F2EEE3 == #f2eee3
  // and rgba(31, 31, 31, 0.30) == rgba(31,31,31,0.3).
  const norm = s =>
    s
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/0\.(\d*?)0+(?=[,)])/g, '0.$1')
      .replace(/(\.\d*[1-9])0+(?=[,)])/g, '$1')
  const localNormalized = norm(local)
  const lightValues = [...tokens.matchAll(/--(\w+):\s*(#[0-9a-fA-F]+|rgba?\([^)]+\));/g)]
  for (const [, name, value] of lightValues) {
    if (!localNormalized.includes(norm(value))) {
      console.warn(`[tokens] value for --${name} (${value}) not found in styles.css`)
    }
  }
}

// ── Web fonts inline (base64 woff2 → @font-face) ─────────────────
// Reads each font in FONT_FACES and emits one @font-face block with the
// bytes embedded as a data: URL. The build crashes loud if a file is
// missing — silent fallback to system fonts here would mask a config error.
async function buildFontFaces() {
  const blocks = await Promise.all(
    FONT_FACES.map(async f => {
      const bytes = await readFile(f.file)
      const b64 = bytes.toString('base64')
      return [
        '@font-face {',
        `  font-family: "${f.family}";`,
        `  font-style: ${f.style};`,
        `  font-weight: ${f.weight};`,
        '  font-display: swap;',
        `  src: url(data:font/woff2;base64,${b64}) format("woff2");`,
        '}',
      ].join('\n')
    })
  )
  return blocks.join('\n')
}

// ── Monogram inline (raw, unmodified) ────────────────────────────
// We inline the SVG file as-is so the original colors and structure survive.
// Sizing happens via the wrapping <span class="footer__monogram"> CSS.
async function loadMonogram() {
  const raw = await readFile(MONOGRAM_SVG, 'utf8')
  // Strip XML prolog if present (illegal inside HTML body)
  return raw.replace(/<\?xml[^?]*\?>\s*/, '').trim()
}

// ── Phosphor duotone sprite ──────────────────────────────────────
// Reads each named icon from assets/icons/phosphor/<name>-duotone.svg,
// strips the outer <svg> wrapper, and rewraps as <symbol id="icon-<name>">
// preserving the original viewBox. Consumers reference via:
//   <svg class="icon"><use href="#icon-<name>"/></svg>
//
// Phosphor's raw duotone SVGs only put `stroke="currentColor"` on the OUTLINE
// paths. Two other element kinds carry NO fill attribute and so default to
// black, ignoring the design tokens:
//   1. the translucent duotone backing shape (always has opacity="0.2")
//   2. solid primary marks (no opacity — e.g. the warning exclamation dot)
//
// design.md is explicit: the outline + primary marks carry the structural
// color; the duotone backing must RECEDE as a muted neutral. `color` and
// `fill` are both inherited and cross the <use>/<symbol> boundary, so we
// drive them as two independent channels (set on `.icon` in styles.css):
//   • color → currentColor → outline strokes + solid primary marks
//   • fill  → var(--icon-secondary) → the fill-less duotone backing
//
// Transform rules (elements that already declare `fill=` — outline
// `fill="none"` and the bbox rect — are left untouched):
//   • has opacity, no fill  → duotone backing: leave fill-less so it
//     INHERITS the muted `fill` from `.icon`
//   • no opacity, no fill   → solid primary mark: pin to `fill="currentColor"`
//     so it tracks the semantic color, not the muted backing
function tintDuotone(inner) {
  return inner.replace(
    /<(path|polyline|polygon|circle|line|ellipse|rect)\b([^>]*?)(\s*\/?)>/g,
    (match, tag, attrs, tail) => {
      if (/\bfill\s*=/.test(attrs)) return match
      if (/\bopacity\s*=/.test(attrs)) return match
      return `<${tag}${attrs} fill="currentColor"${tail}>`
    }
  )
}

async function loadPhosphorSprite() {
  const symbols = await Promise.all(
    PHOSPHOR_ICON_NAMES.map(async name => {
      const file = path.join(PHOSPHOR_DIR, `${name}-duotone.svg`)
      const raw = await readFile(file, 'utf8')
      const viewBoxMatch = raw.match(/viewBox="([^"]+)"/)
      const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 256 256'
      const inner = raw
        .replace(/<\?xml[^?]*\?>\s*/, '')
        .replace(/<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, '')
        .trim()
      return `<symbol id="icon-${name}" viewBox="${viewBox}">${tintDuotone(inner)}</symbol>`
    })
  )
  return `<svg class="phosphor-sprite" aria-hidden="true">${symbols.join('')}</svg>`
}

// ── Main bundle ───────────────────────────────────────────────────
async function buildMain() {
  await esbuild.build({
    entryPoints: [MAIN_ENTRY],
    bundle: true,
    outfile: MAIN_OUT,
    format: 'iife',
    // Figma's plugin sandbox parser rejects ES2020 syntax (`??`, `?.`).
    // Targeting es2017 forces esbuild to transpile those operators away.
    target: 'es2017',
    platform: 'browser',
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    legalComments: 'none',
    logLevel: 'silent',
  })
}

// ── UI bundle (returns JS as string) ──────────────────────────────
async function buildUIScript() {
  const result = await esbuild.build({
    entryPoints: [UI_ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    // Match the main bundle's target for consistency. UI runs in a real
    // iframe so ES2020 would work, but lowering to es2017 costs almost nothing.
    target: 'es2017',
    platform: 'browser',
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    legalComments: 'none',
    logLevel: 'silent',
  })
  if (result.outputFiles.length !== 1) {
    throw new Error('Expected single UI bundle output')
  }
  return inlinePrompts(result.outputFiles[0].text)
}

// ── Prompt inlining ──────────────────────────────────────────────
// `src/ui/ai/prompts.ts` ships placeholder string literals (e.g. the source
// reads `export const VISUAL_REVIEW_PROMPT = '/* INLINE_VISUAL_REVIEW_PROMPT */'`).
// After esbuild that compiles to `"/* INLINE_VISUAL_REVIEW_PROMPT */"` — the
// marker sits *inside* the existing double-quote pair. We replace just the
// marker substring with `JSON.stringify(text).slice(1, -1)` (escaped content
// without the wrapping quotes) so the surrounding quotes from the source
// stay valid and the result is a single well-formed string literal.
//
// Function form on `String.replace` so any `$&`/`$$` byte sequence in the
// prompt body is treated as a literal, not a regex substitution token —
// same trick the HTML-assembly step uses for fonts / sprite / monogram.
async function inlinePrompts(js) {
  const [visualReview, imageOfText] = await Promise.all([
    readFile(VISUAL_REVIEW_PROMPT_FILE, 'utf8'),
    readFile(IMAGE_OF_TEXT_PROMPT_FILE, 'utf8'),
  ])
  const markers = [
    { marker: '/* INLINE_VISUAL_REVIEW_PROMPT */', value: visualReview },
    { marker: '/* INLINE_IMAGE_OF_TEXT_PROMPT */', value: imageOfText },
  ]
  let out = js
  for (const { marker, value } of markers) {
    if (!out.includes(marker)) {
      throw new Error(`UI bundle missing prompt marker: ${marker}`)
    }
    const escaped = JSON.stringify(value).slice(1, -1) // strip wrapping quotes
    out = out.replace(marker, () => escaped)
  }
  return out
}

// ── HTML assembly ─────────────────────────────────────────────────
async function buildUI() {
  const [html, rawCss, js, fontFaces, monogram, sprite] = await Promise.all([
    readFile(UI_HTML, 'utf8'),
    readFile(UI_CSS, 'utf8'),
    buildUIScript(),
    buildFontFaces(),
    loadMonogram(),
    loadPhosphorSprite(),
  ])

  // Splice @font-face blocks into the CSS at the dedicated marker before
  // the CSS gets inlined into the HTML. Function form on .replace so the
  // base64 payload's $-bytes don't get re-interpreted as substitution tokens.
  const FONTS_MARKER = '/* INLINE_FONTS */'
  if (!rawCss.includes(FONTS_MARKER)) {
    throw new Error(`styles.css missing marker: ${FONTS_MARKER}`)
  }
  const css = rawCss.replace(FONTS_MARKER, () => fontFaces)

  let out = html
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (!out.includes(placeholder)) {
      throw new Error(`UI template missing placeholder: ${placeholder} (for ${name})`)
    }
  }

  // Pass replacements as functions so any `$&`, `$$`, `$\``, `$'` byte sequence
  // inside a replacement string is treated as a literal, not as a regex-style
  // substitution token. Without this, esbuild's minified output (which often
  // mangles identifiers to `$`) can produce strings like `$&&$.id` that
  // String.replace misinterprets, corrupting the bundle silently and breaking
  // the iframe at parse time.
  out = out
    .replace(PLACEHOLDERS.css, () => css)
    .replace(PLACEHOLDERS.js, () => js)
    .replace(PLACEHOLDERS.monogram, () => monogram)
    .replace(PLACEHOLDERS.sprite, () => sprite)

  await writeFile(UI_OUT, out, 'utf8')
}

async function ensureDist() {
  if (!existsSync(DIST)) await mkdir(DIST, { recursive: true })
}

async function buildAll() {
  const t0 = Date.now()
  await ensureDist()
  await verifyTokenSync()
  await Promise.all([buildMain(), buildUI()])
  const ms = Date.now() - t0
  const [mainStat, uiStat] = await Promise.all([stat(MAIN_OUT), stat(UI_OUT)])
  console.log(
    `[build] ok in ${ms}ms — main.js ${kb(mainStat.size)} · ui.html ${kb(uiStat.size)}`
  )
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`
}

// ── Watch mode ────────────────────────────────────────────────────
function setupWatch() {
  const targets = [SRC, ASSETS]
  let pending = false
  let timer = null

  const trigger = () => {
    if (pending) return
    pending = true
    clearTimeout(timer)
    timer = setTimeout(async () => {
      pending = false
      try {
        await buildAll()
      } catch (e) {
        console.error('[build] failed:', e.message)
      }
    }, 80)
  }

  for (const target of targets) {
    fsWatch(target, { recursive: true }, trigger)
  }
  console.log('[watch] watching src/ and assets/')
}

// ── Entry ─────────────────────────────────────────────────────────
try {
  await buildAll()
  if (watch) setupWatch()
} catch (e) {
  console.error('[build] failed:', e.message)
  process.exit(1)
}
