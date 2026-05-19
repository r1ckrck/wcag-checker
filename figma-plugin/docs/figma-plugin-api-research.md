# Figma Plugin API — Comprehensive Reference for the Maanak — Accessibility Checker Port

> **Scope.** This document is a planning-grade reference for porting our Claude-Code WCAG skill (currently MCP-driven) to a native Figma plugin. It catalogs the surface area of the Figma Plugin API, with emphasis on the parts we will actually touch: node traversal, fills/styles/variables (for contrast), text properties (for typography rules), components/variants, exports (for screenshots), the UI iframe (for our checker chrome), network access (for any backend), and storage. Where the API has gotchas we will hit, they are called out inline.

> **Source of truth.** Figma migrated the developer site from `figma.com/plugin-docs/*` to `developers.figma.com/docs/plugins/*` in 2025. All `plugin-docs` URLs 301 to the new domain. Both work; we use the new path everywhere.

---

## Table of contents

1. [Plugin architecture and lifecycle](#1-plugin-architecture-and-lifecycle)
2. [Reading the document — node tree](#2-reading-the-document--node-tree)
3. [Styles, fills, effects](#3-styles-fills-effects)
4. [Variables (modern token system)](#4-variables-modern-token-system)
5. [Text nodes](#5-text-nodes)
6. [Components, instances, variants](#6-components-instances-variants)
7. [Auto layout and constraints](#7-auto-layout-and-constraints)
8. [Exporting (screenshots)](#8-exporting-screenshots)
9. [UI thread (the iframe)](#9-ui-thread-the-iframe)
10. [Network requests](#10-network-requests)
11. [Plugin storage](#11-plugin-storage)
12. [Errors and notifications](#12-errors-and-notifications)
13. [Development workflow](#13-development-workflow)
14. [Publishing](#14-publishing)
15. [Limits, gotchas, async migration](#15-limits-gotchas-async-migration)
16. [Mapping our needs](#16-mapping-our-needs)

---

## 1. Plugin architecture and lifecycle

### 1.1 The two-thread execution model

A Figma plugin runs as **two separate JavaScript contexts** that communicate by `postMessage`:

| Thread | Where it runs | Has access to | Does NOT have |
|---|---|---|---|
| **Main thread** (sandbox) | Inside Figma's process, in a **stripped JS sandbox** (no DOM) | The `figma.*` global object — the entire document tree, variables, styles, exports | DOM, `fetch`, `XMLHttpRequest`, `setTimeout`/`setInterval` (in older runtimes — newer runtime adds these), `<script>`-style network loads |
| **UI thread** (iframe) | A regular sandboxed `<iframe>` rendered inside Figma's window | All browser APIs — DOM, `fetch`, `WebSocket`, `localStorage`, `crypto`, etc. | The `figma.*` global. Cannot directly read or write nodes. |

Anything that touches the document MUST run on the main thread. Anything that needs `fetch` (e.g. calling our own backend, the Figma REST API, an LLM API) MUST run in the UI iframe. The bridge between them is `postMessage`.

> **Mental model for our port.** Our skill has been a single linear script. The plugin will be split: read all the design data on main, send the JSON across to UI for any HTTP calls or HTML rendering, and post results back. This split is non-negotiable.

### 1.2 The manifest

`manifest.json` is the entry point. Every field below is real and reachable today.

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Display name in the plugin menu. |
| `id` | `string` | Globally unique plugin ID; assigned by Figma when you "Create new plugin." Required for publishing updates. |
| `api` | `string` | Plugin API version, e.g. `"1.0.0"`. Always set to the latest. |
| `main` | `string` | Path to the main-thread JS bundle. |
| `ui` | `string \| { [key: string]: string }` | Path(s) to UI HTML. A single string becomes the `__html__` global. A map gives you `__uiFiles__["name"]` for multi-screen UIs. |
| `editorType` | `('figma' \| 'figjam' \| 'dev' \| 'slides' \| 'buzz')[]` | Which editors the plugin runs in. **`['dev', 'figjam']` is disallowed.** For our auditor: `['figma', 'dev']`. |
| `documentAccess` | `'dynamic-page'` | **Required for all new plugins.** Forces async page loading, which means traversal across pages requires `await figma.loadAllPagesAsync()` or per-page `loadAsync()`. See §15. |
| `networkAccess` | `{ allowedDomains: string[]; reasoning?: string; devAllowedDomains?: string[] }` | Network allowlist. See §10. |
| `permissions` | `('currentuser' \| 'activeusers' \| 'fileusers' \| 'payments' \| 'teamlibrary')[]` | Gates specific APIs. `teamlibrary` lets you read published library content. |
| `capabilities` | `('textreview' \| 'codegen' \| 'inspect' \| 'vscode')[]` | Activates specialized plugin types. `inspect` puts the plugin in Dev Mode's Inspect panel; `codegen` adds a code generator tab; `vscode` enables the VS Code Dev Mode integration. |
| `menu` | `ManifestMenuItem[]` | Submenu structure. Items: `{ name, command }`, separators `{ separator: true }`, or nested `{ name, menu: [...] }`. |
| `parameters` | `Parameter[]` | "Quick action" parameter prompts. Each: `{ name, key, description?, allowFreeform?, optional? }`. |
| `parameterOnly` | `boolean` | If true, plugin only launches via parameters. Default `true` when `parameters` set. |
| `relaunchButtons` | `ManifestRelaunchButton[]` | Buttons that appear after `node.setRelaunchData()` is called. `{ command, name, multipleSelection? }`. |
| `codegenLanguages` | `CodeLanguage[]` | Required for `codegen` capability. The languages this plugin emits. |
| `codegenPreferences` | `CodegenPreference[]` | Codegen settings UI: units, options, actions. |
| `enablePrivatePluginApi` | `boolean` | Unlocks private-plugin-only API (e.g., `figma.fileKey`). Local dev plugins also get this with the flag. |
| `enableProposedApi` | `boolean` | Unlocks unstable APIs. **Will not run published**, dev only. |
| `build` | `string` | Experimental shell command Figma runs before loading `main`/`ui`. Useful for `tsc -w` style flows. |
| `containsWidget` | `boolean` | Marks the manifest as a widget package. Not relevant for us. |
| `widgetApi` | `string` | Widget API version. Not relevant for us. |

Example minimal manifest matching our likely needs:

```json
{
  "name": "Maanak — Accessibility Checker",
  "id": "1234567890",
  "api": "1.0.0",
  "main": "dist/main.js",
  "ui": "dist/ui.html",
  "editorType": ["figma", "dev"],
  "documentAccess": "dynamic-page",
  "networkAccess": {
    "allowedDomains": ["none"],
    "devAllowedDomains": ["http://localhost:3000"]
  }
}
```

### 1.3 Lifecycle

- The plugin starts when the user picks it from the menu (or via parameters / relaunch button / inspect panel).
- `main` is loaded and executed top-to-bottom in the sandbox.
- If a UI is desired, the main code calls `figma.showUI(__html__, options)`, which boots the iframe.
- The plugin keeps running until **`figma.closePlugin(message?)`** is called or the user dismisses it from the running-plugins menu. Until then, a persistent "Running [plugin name]" status appears in Figma's UI.
- `closePlugin()` clears any open UI, cancels pending `figma.notify` timers, and ends execution. The optional message argument is shown as a final toast.

> **Gotcha.** Forgetting `closePlugin()` is the #1 plugin bug. Any uncaught error path must still reach `closePlugin()`, or the plugin appears hung.

---

## 2. Reading the document — node tree

### 2.1 Node hierarchy

Everything in a Figma file is a node. Inheritance is roughly:

```
BaseNode
├── DocumentNode                     (figma.root; one per file)
└── SceneNode  (everything visible)
    ├── PageNode                     (children of root)
    ├── FrameNode                    (canvases, frames, screens)
    ├── GroupNode
    ├── SectionNode
    ├── ComponentNode
    ├── ComponentSetNode             (parent of variant ComponentNodes)
    ├── InstanceNode
    ├── BooleanOperationNode
    ├── VectorNode
    ├── RectangleNode
    ├── EllipseNode
    ├── PolygonNode
    ├── StarNode
    ├── LineNode
    ├── TextNode
    ├── SliceNode
    ├── StickyNode                   (FigJam)
    ├── ConnectorNode                (FigJam)
    ├── ShapeWithTextNode            (FigJam)
    ├── CodeBlockNode                (FigJam)
    ├── EmbedNode / LinkUnfurlNode   (FigJam)
    ├── HighlightNode
    ├── TableNode / TableCellNode
    ├── WashiTapeNode / StampNode    (FigJam)
    ├── WidgetNode
    ├── MediaNode
    ├── TextPathNode
    ├── TransformGroupNode
    ├── SlideNode / SlideRowNode / SlideGridNode / InteractiveSlideElementNode  (Slides)
    └── RemovedNode                  (placeholder for deleted nodes still referenced)
```

**For a Figma Design auditor we mostly care about:** `PageNode`, `FrameNode`, `ComponentNode`, `ComponentSetNode`, `InstanceNode`, `GroupNode`, `SectionNode`, `TextNode`, `RectangleNode`, `EllipseNode`, `VectorNode`, `LineNode`, `BooleanOperationNode`. All FigJam-specific nodes can be ignored.

### 2.2 Reaching nodes

```ts
// The current selection (sync, always available on the active page)
const sel: readonly SceneNode[] = figma.currentPage.selection

// The current page
const page: PageNode = figma.currentPage

// The whole document
const doc: DocumentNode = figma.root          // children = pages
```

**Cross-page traversal is async** when manifest has `documentAccess: 'dynamic-page'`:

```ts
// Loads every page so you can traverse the entire file
await figma.loadAllPagesAsync()

// Or load a single page
const otherPage = figma.root.children[2]
await otherPage.loadAsync()
```

### 2.3 Traversal methods

| Method | Scope | Sync/Async | Notes |
|---|---|---|---|
| `node.children` | Direct children only | sync | Read-only array. |
| `node.parent` | One level up | sync | `null` for `DocumentNode` and detached nodes. |
| `node.findAll(predicate?)` | Entire subtree | sync | DFS. **Expensive on large trees.** |
| `node.findOne(predicate)` | Entire subtree | sync | Stops on first match. |
| `node.findChildren(predicate?)` | Direct children only | sync | Cheaper than `findAll`. |
| `node.findAllWithCriteria<T>({ types, sharedPluginData?, pluginData? })` | Entire subtree | sync | **Use this**: Figma applies optimizations (especially for `types`) that `findAll` cannot. |
| `figma.getNodeByIdAsync(id)` | Whole document | async | Resolves to `BaseNode \| null`. Replaces deprecated `figma.getNodeById`. |

Performance-sensitive recommendations for our auditor:

- Prefer `findAllWithCriteria({ types: ['TEXT'] })` over `findAll(n => n.type === 'TEXT')`. Figma maintains type indexes.
- Set `figma.skipInvisibleInstanceChildren = true` early. This skips invisible nodes inside instances during all traversals — usually what we want for a visible-content audit, and a major perf win on component-heavy files. Default is `true` in Dev Mode, `false` elsewhere.
- Avoid `findAll` on `figma.root`. Walk pages explicitly so we can show progress per-page.

### 2.4 Async vs sync property access

Most node properties are still **sync getters**. The ones that became async with dynamic-page loading are the cross-page lookups:

| Sync (still) | Now async |
|---|---|
| `node.name`, `node.type`, `node.id` | `figma.getNodeByIdAsync(id)` |
| `node.x`, `y`, `width`, `height`, `rotation` | `figma.getStyleByIdAsync(id)` |
| `node.fills`, `strokes`, `effects`, `opacity`, `visible` | `instance.getMainComponentAsync()` |
| `node.children`, `node.parent` | `figma.variables.getVariableByIdAsync(id)` |
| `text.characters`, `fontSize`, etc. | `figma.variables.getLocalVariablesAsync()` |
| `instance.componentProperties` | `node.setFillsAsync(...)` for pattern fills |
| `instance.mainComponent` (still works but warns under dynamic-page; prefer the async variant) | `figma.getLocalPaintStylesAsync()`, `getLocalTextStylesAsync()`, `getLocalEffectStylesAsync()`, `getLocalGridStylesAsync()` |

> **Rule of thumb.** Anything that *crosses pages* or *resolves a remote/library reference* is async. Anything that reads in-memory properties of a loaded node is sync.

---

## 3. Styles, fills, effects

### 3.1 Fills (`fills` property)

Type: `ReadonlyArray<Paint> | typeof figma.mixed`.

`Paint` is a discriminated union:

```ts
type Paint =
  | SolidPaint            // type: 'SOLID'
  | GradientPaint         // 'GRADIENT_LINEAR' | '_RADIAL' | '_ANGULAR' | '_DIAMOND'
  | ImagePaint            // 'IMAGE'
  | VideoPaint            // 'VIDEO'
  | PatternPaint          // 'PATTERN'
```

Common to all paints:

- `visible: boolean` (default `true`)
- `opacity: number` (`0..1`, default `1`)
- `blendMode: BlendMode` (default `'NORMAL'`)
- `boundVariables?: { ... }` — variable bindings for color, opacity, etc.

#### SolidPaint

```ts
{ type: 'SOLID', color: { r, g, b }, opacity?: number, ... }
```

**Color values are floats `0..1`, not `0..255`.** A WCAG calculation must remember this:

```ts
function paintToHex(p: SolidPaint): string {
  const { r, g, b } = p.color
  const to255 = (v: number) => Math.round(v * 255)
  return `#${[r, g, b].map(to255).map(c => c.toString(16).padStart(2, '0')).join('')}`
}
```

The `opacity` field on a SolidPaint multiplies the alpha; the `color` itself has no alpha channel. Effective alpha for compositing = `paint.opacity * node.opacity * (ancestor opacity products)`.

#### GradientPaint

- `gradientStops: { position: 0..1, color: RGBA, boundVariables? }[]`
- `gradientTransform: Transform` (2x3 affine matrix)

For WCAG contrast we generally cannot give a single value. Flag gradients for manual review.

#### ImagePaint / VideoPaint / PatternPaint

- ImagePaint: `imageHash`, `scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE'`, `imageTransform?`, `scalingFactor?`, `rotation?`, `filters?` (exposure, contrast, saturation, temperature, tint, highlights, shadows; range `-1..1`).
- VideoPaint: same shape with `videoHash`.
- PatternPaint: tiles a `sourceNodeId` across the surface; `tileType`, `scalingFactor`, `spacing`, `horizontalAlignment`.

For text contrast over images/videos/patterns, we cannot compute a deterministic ratio — flag for manual review (WCAG SC 1.4.3 acknowledges this case).

#### Modifying fills

The `fills` array is **immutable**. To change it you must reassign. For pattern fills (which need source-node loading), use the async setter:

```ts
const fills = [...node.fills as Paint[]]
fills[0] = { ...fills[0], opacity: 0.5 }
node.fills = fills

// Pattern fills only:
await node.setFillsAsync([myPatternPaint])
```

### 3.2 Strokes

Same `Paint[]` model as fills, plus:

- `strokeWeight: number | typeof figma.mixed` — mixed when individual sides differ.
- `strokeAlign: 'CENTER' | 'INSIDE' | 'OUTSIDE'`
- `strokeCap`, `strokeJoin`, `dashPattern`
- Per-side weights: `strokeTopWeight`, `strokeBottomWeight`, `strokeLeftWeight`, `strokeRightWeight` (frames only)

### 3.3 Effects

`effects: ReadonlyArray<Effect>` where `Effect` is one of:

- `DropShadowEffect`, `InnerShadowEffect` — `color` RGBA, `offset { x, y }`, `radius`, `spread?`, `visible`, `blendMode`, `showShadowBehindNode?`
- `BlurEffect` — `type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'`, `radius`
- `NoiseEffect`, `TextureEffect` (newer)

Each effect can also carry `boundVariables`.

### 3.4 Style references (the legacy "Styles" system)

Before variables, Figma had Paint/Text/Effect/Grid Styles. Many production files still use them.

```ts
node.fillStyleId   // string | typeof figma.mixed
node.strokeStyleId // string
node.effectStyleId // string
text.textStyleId   // string | typeof figma.mixed

// Resolve a style by id
const style = await figma.getStyleByIdAsync(node.fillStyleId as string)

// Enumerate local styles (per file)
const paintStyles  = await figma.getLocalPaintStylesAsync()
const textStyles   = await figma.getLocalTextStylesAsync()
const effectStyles = await figma.getLocalEffectStylesAsync()
const gridStyles   = await figma.getLocalGridStylesAsync()
```

Each style: `{ id, name, type, key, remote, description, descriptionMarkdown, paints?/value?/textStyle?, getPublishStatusAsync(), boundVariables? }`. `remote: true` means the style came from a published library.

> **For the audit.** When `fillStyleId` is set we know the color came from a token. Worth surfacing in the report ("color from style 'Surface/Primary'") because designers fix the token, not the layer.

---

## 4. Variables (modern token system)

Variables are the *current* Figma token system; styles are legacy. **In any contemporary file most colors will be variable-bound.** Our auditor MUST handle both.

### 4.1 Concepts

- `VariableCollection` — a named bucket. Has one or more **modes** (e.g. "Light", "Dark", "Compact").
- `Variable` — typed token (`'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR'`). Holds one value **per mode** in `valuesByMode`.
- A **binding** ties a node property to a variable. Read via `node.boundVariables` and per-paint `paint.boundVariables`.

### 4.2 Reading the registry

```ts
const collections = await figma.variables.getLocalVariableCollectionsAsync()
const variables   = await figma.variables.getLocalVariablesAsync('COLOR')

const v   = await figma.variables.getVariableByIdAsync(id)
const col = await figma.variables.getVariableCollectionByIdAsync(id)
```

### 4.3 Detecting bindings on a node

For simple scalar properties:

```ts
if (frame.boundVariables?.width) {
  const id = frame.boundVariables.width.id
}
```

For paint arrays (fills/strokes), bindings live on each individual `Paint`:

```ts
const fills = node.fills as Paint[]
for (const paint of fills) {
  if (paint.type === 'SOLID') {
    const colorBinding = paint.boundVariables?.color
    if (colorBinding) {
      const variable = await figma.variables.getVariableByIdAsync(colorBinding.id)
      // variable.valuesByMode[modeId] is the resolved RGB
    }
  }
}
```

### 4.4 Resolving the actual color a user sees

This is the critical piece for our contrast checker. A bound color depends on which **mode** the consumer's nearest collection ancestor is set to.

```ts
const variable = await figma.variables.getVariableByIdAsync(id)
const resolved = variable.resolveForConsumer(node)
// resolved: { value: VariableValue, resolvedType: VariableResolvedDataType }
```

`resolveForConsumer(node)` walks up from `node` to find which mode applies, follows alias chains across collections, and returns the final RGB(A). Use this — do **not** read `valuesByMode` directly unless you know the mode.

### 4.5 Modes and aliases

- A node lives inside zero or more collections worth of modes. The mode for collection X at a node is whichever value its nearest ancestor (or self) `explicitVariableModes` setting specifies, falling back to the collection's default.
- A variable's value can itself be an alias to another variable (`{ type: 'VARIABLE_ALIAS', id }`). Aliases resolve transitively. `resolveForConsumer` does this for you.
- Extended collections (Enterprise) inherit and override; reading the resolved value is the same.

### 4.6 Why this matters for the auditor

A single text layer in a "Light/Dark" file may produce two completely different contrast ratios depending on mode. We should report both, or at minimum the active mode at the time of audit, plus a flag noting the layer is mode-dependent.

---

## 5. Text nodes

### 5.1 Properties (whole-node)

```ts
text.characters                // string
text.fontSize                  // number | figma.mixed
text.fontName                  // FontName | figma.mixed   { family, style }
text.fontWeight                // number | figma.mixed (readonly)
text.letterSpacing             // LetterSpacing | figma.mixed
text.lineHeight                // LineHeight | figma.mixed
text.textCase                  // 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | ... | figma.mixed
text.textDecoration            // 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH' | figma.mixed
text.textAlignHorizontal       // 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
text.textAlignVertical         // 'TOP' | 'CENTER' | 'BOTTOM'
text.textAutoResize            // 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' | 'TRUNCATE'
text.textTruncation            // 'DISABLED' | 'ENDING'
text.maxLines                  // number | null
text.paragraphIndent           // number | figma.mixed
text.paragraphSpacing          // number | figma.mixed
text.listSpacing               // number | figma.mixed
text.leadingTrim               // 'NONE' | 'CAP_HEIGHT' | figma.mixed
text.hangingPunctuation        // boolean
text.hangingList               // boolean
text.textStyleId               // string | figma.mixed
text.hyperlink                 // HyperlinkTarget | null | figma.mixed
text.autoRename                // boolean
```

### 5.2 Units

- **`LineHeight`**: `{ unit: 'PIXELS', value: number } | { unit: 'PERCENT', value: number } | { unit: 'AUTO' }`. AUTO uses the font's intrinsic leading; we cannot compute the pixel height without measuring against the font.
- **`LetterSpacing`**: `{ unit: 'PIXELS', value: number } | { unit: 'PERCENT', value: number }`. Percent is relative to font size.

### 5.3 Mixed values and ranges

Any whole-node property that varies across characters returns the sentinel `figma.mixed` (a unique symbol). To inspect ranges:

```ts
text.getRangeFontSize(start, end)           // number | figma.mixed
text.getRangeFontName(start, end)           // FontName | figma.mixed
text.getRangeFontWeight(start, end)
text.getRangeFills(start, end)              // Paint[] | figma.mixed
text.getRangeFillStyleId(start, end)
text.getRangeTextStyleId(start, end)
text.getRangeLetterSpacing(start, end)
text.getRangeLineHeight(start, end)
text.getRangeTextDecoration(start, end)
text.getRangeTextCase(start, end)
text.getRangeAllFontNames(start, end)        // FontName[]   (unique)
```

The clean way to walk all heterogeneous segments at once:

```ts
const segments = text.getStyledTextSegments([
  'fontSize', 'fontName', 'fontWeight',
  'fills', 'lineHeight', 'letterSpacing',
  'textDecoration', 'textCase',
  'boundVariables',
])
// segments: { start, end, characters, fontSize, fontName, ... }[]
```

This is the right primitive for typography audits — one call yields a normalized list of style runs we can iterate.

### 5.4 Font loading

Reading text properties does **not** require font loading. Writing them does. Since our auditor is read-only we mostly skip this.

If we ever do want to mutate (e.g. annotate), we must:

```ts
await figma.loadFontAsync(text.fontName as FontName)
// or for mixed:
await Promise.all(
  text.getRangeAllFontNames(0, text.characters.length).map(figma.loadFontAsync)
)
```

Always check `text.hasMissingFont` first — a missing font cannot be loaded.

### 5.5 Comparing `figma.mixed`

```ts
if (text.fontSize === figma.mixed) { ... }
```

Never `===` a mixed value to a number — it always returns false. Always equality-check the constant itself.

---

## 6. Components, instances, variants

### 6.1 The triple

| Node | Role |
|---|---|
| `ComponentNode` | The source of truth for a single component (or a single variant inside a set). |
| `ComponentSetNode` | A frame that contains multiple `ComponentNode` children, each a variant of the set. |
| `InstanceNode` | A live copy of a component placed in a layout. Tracks overrides. |

### 6.2 ComponentSetNode

```ts
componentSet.children                      // ComponentNode[] — each is a variant
componentSet.defaultVariant                // ComponentNode (top-leftmost)
componentSet.componentPropertyDefinitions  // map of property name -> definition
componentSet.key                           // import key for libraries
componentSet.remote                        // from team library?
componentSet.description / descriptionMarkdown
```

`componentPropertyDefinitions` is the schema. For a `VARIANT` property the definition includes `variantOptions: string[]`. For `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`, names are mangled with a `#` plus a unique suffix (e.g. `"State#1234:0"`) to prevent collisions when properties are renamed. Always read the *exact* keys from the definitions object — never hard-code.

### 6.3 ComponentNode

```ts
component.name                             // typically "Property=Value, Property=Value" inside a set
component.variantProperties                // { [propName]: string } | null
component.parent                           // typically a ComponentSetNode if a variant
component.key                              // for library imports
component.remote
component.getPublishStatusAsync()
component.getInstancesAsync()              // Promise<InstanceNode[]>  (preferred over deprecated `instances`)
component.createInstance()                 // sync
```

### 6.4 InstanceNode

```ts
instance.componentProperties               // { [name]: { type, value, boundVariables? } } readonly
instance.variantProperties                 // shortcut for VARIANT entries
instance.mainComponent                     // sync (works, but under dynamic-page prefer:)
await instance.getMainComponentAsync()
instance.exposedInstances                  // nested instances surfaced at this level
instance.isExposedInstance
instance.overrides                         // direct overrides only (not inherited)
instance.componentPropertyReferences       // bindings from this instance's properties to inner nodes
instance.scaleFactor

instance.setProperties({ "Size#42:0": "Large" })
instance.swapComponent(otherComponent)
instance.detachInstance()                  // returns FrameNode
instance.resetOverrides()                  // (or removeOverrides() in some versions)
```

### 6.5 Library imports

```ts
const c   = await figma.importComponentByKeyAsync(key)
const cs  = await figma.importComponentSetByKeyAsync(key)
const sty = await figma.importStyleByKeyAsync(key)
const v   = await figma.variables.importVariableByKeyAsync(key)
```

Useful if our audit cross-references a known design-system library.

---

## 7. Auto layout and constraints

### 7.1 Auto layout

```ts
node.layoutMode                  // 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID'
node.layoutWrap                  // 'NO_WRAP' | 'WRAP'
node.primaryAxisSizingMode       // 'FIXED' | 'AUTO'
node.counterAxisSizingMode       // 'FIXED' | 'AUTO'
node.layoutSizingHorizontal      // 'FIXED' | 'HUG' | 'FILL'   (newer convenience)
node.layoutSizingVertical
node.primaryAxisAlignItems       // 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
node.counterAxisAlignItems       // 'MIN' | 'CENTER' | 'MAX' | 'BASELINE'
node.counterAxisAlignContent     // 'AUTO' | 'SPACE_BETWEEN'
node.paddingLeft / paddingRight / paddingTop / paddingBottom
node.itemSpacing
node.counterAxisSpacing
node.itemReverseZIndex
node.strokesIncludedInLayout
```

On children:

```ts
child.layoutAlign      // 'INHERIT' | 'STRETCH' | 'MIN' | 'CENTER' | 'MAX' (legacy)
child.layoutGrow       // 0 or 1; equivalent to flex-grow
child.layoutPositioning // 'AUTO' | 'ABSOLUTE'  (ABSOLUTE = "out of flow")
```

### 7.2 Constraints (only meaningful when parent is NOT auto-layout)

```ts
node.constraints.horizontal   // 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE'
node.constraints.vertical     // same set
```

### 7.3 Bounding boxes (key for "what's behind this layer")

```ts
node.absoluteTransform        // 2x3 matrix, canvas space
node.absoluteBoundingBox      // { x, y, width, height } — geometric bounds, ignores effects
node.absoluteRenderBounds     // bounds expanded by stroke geometry, drop shadows, etc., clipped by ancestors
```

For our auditor's "what color is the parent surface behind this text?" check, walk `node.parent` up the tree, intersect each ancestor's `absoluteBoundingBox` with the text's own, and find the first ancestor with a non-transparent solid fill that overlaps. Note `absoluteRenderBounds` may be `null` for nodes with no rendered geometry.

---

## 8. Exporting (screenshots)

### 8.1 Signature

```ts
exportAsync(settings?: ExportSettings): Promise<Uint8Array>
exportAsync(settings: ExportSettingsSVGString): Promise<string>
exportAsync(settings: ExportSettingsREST): Promise<object>      // JSON_REST_V1
```

### 8.2 Settings

```ts
type ExportSettings =
  | ExportSettingsImage    // PNG, JPG
  | ExportSettingsSVG      // SVG (Uint8Array of bytes)
  | ExportSettingsSVGString
  | ExportSettingsPDF
  | ExportSettingsREST     // JSON_REST_V1
```

Common fields:

```ts
{
  format: 'PNG' | 'JPG' | 'SVG' | 'SVG_STRING' | 'PDF' | 'JSON_REST_V1',
  constraint?: { type: 'SCALE' | 'WIDTH' | 'HEIGHT', value: number },
  suffix?: string,
  contentsOnly?: boolean,      // exclude the node's own bounds; export children only
  useAbsoluteBounds?: boolean, // include effects/strokes that fall outside bounds
  colorProfile?: 'DOCUMENT' | 'SRGB' | 'DISPLAY_P3_V4',
  // SVG only:
  svgOutlineText?: boolean,    // outline text → paths (loses semantic text)
  svgIdAttribute?: boolean,
  svgSimplifyStroke?: boolean,
}
```

### 8.3 Returns and conversion

PNG/JPG/PDF: `Uint8Array`. To send to a server, send the bytes directly through the iframe; to embed in HTML, convert to a data URL:

```ts
// Main thread:
const bytes = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 }})
figma.ui.postMessage({ kind: 'screenshot', bytes })

// UI thread:
window.onmessage = (e) => {
  const { bytes } = e.data.pluginMessage
  const blob = new Blob([bytes], { type: 'image/png' })
  const url  = URL.createObjectURL(blob)        // for <img src=>
  // or base64:
  const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
}
```

`Uint8Array` survives `postMessage` cleanly. `Blob` and `ArrayBuffer` do **not** — convert at the boundary.

### 8.4 Performance / limits

- Exports run on the main thread and block other plugin work; for a journey-level audit with 50 frames, batch and yield to the event loop between calls.
- There is no published hard size cap, but 4K PNGs of complex screens routinely take 1–3s each. Plan for visible progress feedback.
- `useAbsoluteBounds: true` is correct when the node has shadows extending outside its frame and we want the visible shadow captured.

---

## 9. UI thread (the iframe)

### 9.1 Showing UI

```ts
figma.showUI(__html__, {
  width: 360,
  height: 480,
  themeColors: true,            // injects --figma-color-* CSS vars
  visible: true,
  position?: { x, y },
  title?: string,
})
```

`__html__` is a global string injected by Figma — the contents of the file referenced in `manifest.ui`. For multi-page UI use a manifest map and `figma.showUI(__uiFiles__["onboarding"], ...)`.

### 9.2 Message passing

The two halves use different envelopes — internalize this once:

| Direction | Sender call | Receiver |
|---|---|---|
| **UI → main** | `parent.postMessage({ pluginMessage: payload }, '*')` | `figma.ui.onmessage = (msg) => { ... }` (msg is the payload directly) |
| **Main → UI** | `figma.ui.postMessage(payload)` | `window.onmessage = (e) => { e.data.pluginMessage }` (unwrap one level) |

The asymmetry is the most-stumbled-on detail in the API. UI must wrap, main does not. UI must pass `'*'` as the second arg.

### 9.3 What survives postMessage

OK: objects, arrays, strings, numbers, booleans, `null`, `undefined`, `Date`, `Uint8Array`. Class instances are flattened (prototype chain dropped). NOT OK: `Blob`, `ArrayBuffer`, most other typed arrays, functions, symbols.

### 9.4 Theme colors

When `themeColors: true`, Figma injects CSS variables we should use:

```css
.body { background: var(--figma-color-bg); color: var(--figma-color-text); }
.button { background: var(--figma-color-bg-brand); color: var(--figma-color-text-onbrand); }
.error { color: var(--figma-color-text-danger); }
```

Auto-switches with Figma's light/dark mode. Strongly recommended over hand-rolled palettes.

### 9.5 Resizing, hiding, closing

```ts
figma.ui.resize(width, height)
figma.ui.hide()
figma.ui.show()
figma.ui.close()                 // closes UI but keeps plugin running
```

---

## 10. Network requests

### 10.1 Where `fetch` works

- **UI thread (iframe):** fully available, governed by browser CORS plus the manifest allowlist.
- **Main thread (sandbox):** `fetch` *is* exposed in current Figma runtimes, governed by the same manifest. Historically it was UI-only, and many guides still say so. For portability and CORS sanity, **do all HTTP from the UI iframe** anyway.

### 10.2 CORS reality

The plugin iframe runs with a `null` origin. Any external endpoint we call must send `Access-Control-Allow-Origin: *` (or echo our origin, which is `null`). Tight CORS APIs (AWS signed, GitHub raw user content with restrictions) will fail. We control our own backend, so this is fine for us — just make sure the endpoint sets `*`.

### 10.3 Manifest allowlist

```json
"networkAccess": {
  "allowedDomains": ["api.our-backend.com", "*.api.openai.com"],
  "reasoning": "Sends design data to our WCAG analysis backend; calls LLM to produce findings.",
  "devAllowedDomains": ["http://localhost:3000", "http://localhost:8000"]
}
```

Pattern rules:

- `["none"]` blocks all network. Use this during early dev, then add domains incrementally.
- `["*"]` — all domains. Forces a `reasoning` field, gets extra scrutiny in review, and is generally rejected unless your plugin is genuinely a "fetch arbitrary URL" tool.
- Plain hostname (`"api.example.com"`) — exact match.
- Wildcard subdomain (`"*.example.com"`).
- Specific path (`"httpbin.org/get"`) — narrowest grant.
- Scheme prefix permitted (`"https://api.example.com"`).
- `devAllowedDomains` is appended to `allowedDomains` only when running an unpublished local plugin. It is **not** active in published builds. Localhost MUST live here, never in `allowedDomains` of a published plugin.
- Adding `*` or local hosts to `allowedDomains` triggers the `reasoning` requirement.

Violations show up as **CSP errors in the dev console**, not exceptions. Watch the console while testing.

---

## 11. Plugin storage

### 11.1 `figma.clientStorage` — per-user, persistent

```ts
await figma.clientStorage.setAsync('apiKey', 'sk_...')
const key = await figma.clientStorage.getAsync<string>('apiKey')
await figma.clientStorage.deleteAsync('apiKey')
const allKeys = await figma.clientStorage.keysAsync()
```

| Property | Value |
|---|---|
| Scope | Per (user, plugin id) tuple. Other plugins cannot read it. |
| Persistence | Across plugin runs and Figma restarts; cleared if the user clears Figma cache. |
| Capacity | **5 MB total per plugin.** |
| Allowed value types | Object, array, string, number, boolean, null, undefined, Uint8Array. |
| Security | "Private for stability, not security." A sufficiently determined user can inspect their own client storage. Don't store another user's secrets. |

Use cases for us: API keys for our own backend, user preferences (severity threshold, page-vs-journey default), last-used Figma file shortlist.

### 11.2 Other storage primitives (not for our case but worth knowing)

- `node.setPluginData(key, value)` / `getPluginData(key)` — string-only, attached to a specific node, **stored in the file** (visible to anyone who opens it). Useful for marking nodes as "audited at v1.2."
- `node.setSharedPluginData(namespace, key, value)` — readable by other plugins that know the namespace. Useful only if we publish a complementary plugin.
- `figma.root.setPluginData(...)` — file-scoped private data.

---

## 12. Errors and notifications

### 12.1 `figma.notify`

```ts
const handle = figma.notify('Audit complete: 3 errors, 5 warnings', {
  timeout: 5000,                         // ms; Infinity = sticky
  error: false,                          // red styling when true
  button: {
    text: 'View report',
    action: () => { figma.ui.show(); return false }, // return false = keep toast
  },
  onDequeue: (reason) => { /* 'timeout' | 'dismiss' | 'action_button_click' */ },
})

handle.cancel()   // dismiss programmatically
```

Message is **truncated at 100 characters**. For long results show them in the UI iframe instead.

### 12.2 `figma.closePlugin`

```ts
figma.closePlugin('Closed: nothing selected')
```

The string is shown as a final toast. Calling it ends the plugin immediately — code after it does not run.

### 12.3 Error patterns

Common runtime errors we should guard against:

| Error | Cause | Fix |
|---|---|---|
| `Cannot call with documentAccess: dynamic-page. Use figma.getNodeByIdAsync() instead` | Used a sync API that's been gated under dynamic-page. | Switch to the async variant. |
| `Cannot access children on a page that has not been explicitly loaded` | Touching a non-current page without `loadAsync()`. | `await page.loadAsync()` first, or `figma.loadAllPagesAsync()` once. |
| `Cannot write to node with unloaded font 'Inter Regular'` | Mutating text without loading its fonts. | `await figma.loadFontAsync(fontName)`. |
| `Cannot write to internal and read-only nodes` | Mutating a node in Dev Mode (where the plugin is read-only) or a node in a remote library. | Check `node.remote` and `figma.editorType`. |
| `This property cannot be overridden on an instance` | Setting a property that's pinned by the main component (e.g. layoutMode on an instance). | Detach first, or write to the main component. |
| `Expected 'opacity' to have type number but got string instead` | Assigning the wrong type. | TypeScript catches these before runtime. |

Wrap the main entry in try/catch and always finish with `closePlugin`:

```ts
async function main() {
  try {
    await runAudit()
  } catch (e) {
    figma.notify(String(e), { error: true, timeout: 5000 })
  } finally {
    figma.closePlugin()
  }
}
main()
```

---

## 13. Development workflow

### 13.1 Bootstrapping

1. Figma Desktop → **Plugins → Development → New plugin**.
2. Pick "Figma design," "Custom UI," save the folder.
3. Figma scaffolds `manifest.json`, `code.ts`, `ui.html`, `tsconfig.json`, `package.json` with `@figma/plugin-typings` already wired.
4. `npm install`.

### 13.2 Build

Three common toolchains:

| Tool | Setup | Verdict |
|---|---|---|
| `tsc -w` | Built-in via `Cmd/Ctrl + Shift + B → watch-tsconfig.json`. | Fine for tiny single-file plugins. No bundling, so no `import` from `node_modules`. |
| **esbuild** | One config file, sub-second builds, TS+JSX+JSON out of the box. | **Recommended for us.** |
| webpack | `ts-loader`, `webpack.config.js`, slowest builds. | Use if you already know it. |
| Plugma / Create Figma Plugin | Community scaffolds with React/Svelte/Vue templates. | Fast start, gives an opinion. |

Why bundling: a Figma plugin must load from a single JS file referenced by `manifest.main`. Multi-file ESM works during authoring but must compile into one output.

### 13.3 TypeScript

```bash
npm i -D @figma/plugin-typings
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "es2020",
    "strict": true,
    "typeRoots": ["./node_modules/@types", "./node_modules/@figma"]
  }
}
```

Once configured, `figma`, `__html__`, `__uiFiles__`, and types like `SceneNode`, `FrameNode`, `TextNode`, `Paint`, `Variable` are global.

Add `eslint-plugin-figma-plugins` for plugin-specific lint rules (e.g. flags accidental sync usages under dynamic-page).

### 13.4 Iteration loop

1. Save TS file → bundler emits `dist/main.js` and `dist/ui.html`.
2. In Figma, **Plugins → Development → [your plugin]** to launch (or `⌥⌘P` to re-run last).
3. **Right-click anywhere → Plugins → Development → Open Console** for the main-thread console. The UI iframe has its own DevTools (right-click inside the UI → Inspect element).
4. Hot reload: not built in. Re-run the plugin. Some scaffolds (Plugma) emulate it via auto-relaunch.

Tip: keep a small "dev" command in `manifest.json` that no-ops to a known canvas state for fast iteration.

---

## 14. Publishing

| Visibility | Audience | Review |
|---|---|---|
| **Public (Community)** | Anyone on figma.com | Manual Figma review (privacy, security, performance, name/icon, prompt clarity); turnaround days–weeks. |
| **Private** | Just the publisher and explicitly invited orgs | No review. |
| **Org / Workspace** | Members of a Figma Enterprise org | Org admin approves; no public review. |

Versioning is implicit — each publish increments. Plugin `id` in manifest is permanent and assigned by Figma during "Create new plugin." Don't change it; it's how Figma tracks updates.

The pre-publish checklist Figma highlights: handle dynamic-page properly, gracefully handle empty selection, load fonts before mutating text, gracefully handle library/component swaps, declare `networkAccess` truthfully, behave on huge files. Reviewers check these.

For our case, plan to publish as an **org plugin first** (faster, lets BFL teammates use it), and consider Community later.

---

## 15. Limits, gotchas, async migration

### 15.1 Dynamic-page (mandatory in 2024+)

`documentAccess: 'dynamic-page'` is now required for new plugins. Implications:

- Pages other than the user's current page may not be in memory.
- Sync `figma.getNodeById`, `figma.getStyleById`, deprecated `instance.mainComponent` accessor (still present but warns), and many remote-resource lookups become **async**.
- Cross-page traversal must be preceded by `await figma.loadAllPagesAsync()` or `await page.loadAsync()`.
- `findAll` on `figma.root` will only see loaded pages. Use `findAllWithCriteria` per page after loading.

The migration list to apply mechanically when porting old code:

| Old (sync) | New (async) |
|---|---|
| `figma.getNodeById(id)` | `await figma.getNodeByIdAsync(id)` |
| `figma.getStyleById(id)` | `await figma.getStyleByIdAsync(id)` |
| `instance.mainComponent` | `await instance.getMainComponentAsync()` |
| `figma.getLocalPaintStyles()` | `await figma.getLocalPaintStylesAsync()` |
| `figma.getLocalTextStyles()` | `await figma.getLocalTextStylesAsync()` |
| `figma.getLocalEffectStyles()` | `await figma.getLocalEffectStylesAsync()` |
| `figma.getLocalGridStyles()` | `await figma.getLocalGridStylesAsync()` |
| `figma.variables.getVariableById` | `await ...ByIdAsync` |
| `component.instances` | `await component.getInstancesAsync()` |
| `node.fillStyleId = id` (for some style types) | `await node.setFillStyleIdAsync(id)` |

### 15.2 `figma.mixed`

Returned by any whole-node property when the underlying value is heterogeneous across children, paints, or character ranges (`fontSize`, `fills`, `cornerRadius`, `strokeWeight`, `letterSpacing`, etc.). Always:

```ts
if (val === figma.mixed) { /* split via getRange* / getStyledTextSegments / per-paint */ }
else { /* uniform value */ }
```

Never compare a non-mixed property using `==` — TypeScript's `figma.mixed` type is `unique symbol` and won't equal anything else.

### 15.3 Performance

- A fully expanded Figma file can have hundreds of thousands of nodes. `findAll` traverses all of them and can take seconds.
- `findAllWithCriteria({ types: [...] })` uses indexes; orders of magnitude faster.
- `figma.skipInvisibleInstanceChildren = true` prunes hidden subtrees inside instances. Set this once at startup for read-only audits.
- Exports are CPU-heavy. Batch and yield (`await new Promise(r => setTimeout(r, 0))` only works in iframes; on main thread use a `Promise.resolve()` to yield).
- The plugin runtime has no published hard timeout, but Figma will show a "still running…" indicator after about 5–10 seconds of synchronous work, and very large operations can spike memory enough to crash the tab. Always stream progress via UI postMessage.

### 15.4 Read-only contexts

- In **Dev Mode** the plugin cannot mutate the document. Reading is fine. Our auditor is fundamentally read-only, so this is comfortable.
- Nodes in remote libraries (`node.remote === true`) are read-only.
- Viewer-permission users running the plugin will hit "read-only" errors on writes; check `figma.editorType` and consider `figma.currentUser` + `figma.currentPage.canBeFlattened`-style probes to short-circuit gracefully.

### 15.5 Memory and message size

- Single `postMessage` payloads of multiple megabytes work but slow Figma noticeably; stream large data (e.g. several screenshots) as separate messages.
- Don't post a fully expanded node tree across the boundary. Walk on main, build a slim DTO with only the fields the UI actually renders, and post the DTO.

### 15.6 Node identity stability

- `node.id` is stable for the lifetime of the document (and across saves), but a deleted node's id can be reused after a restart in some edge cases. Cache audit findings keyed by id within a session only; for cross-session caching include `figma.fileKey` (private API) or a content hash.

---

## 16. Mapping our needs

### 16.1 What the MCP gives us today vs Plugin API equivalents

| MCP capability we use | Plugin API equivalent | Notes |
|---|---|---|
| `get_metadata(fileKey, nodeId)` — coarse component metadata, page list, frame list | Walk `figma.root.children` → pages → frames. Use `findAllWithCriteria({ types: ['FRAME', 'COMPONENT', 'COMPONENT_SET'] })` per page. | We get **richer** data than MCP because we have full property access, not just a summary. |
| `get_design_context(fileKey, nodeId)` — computed styles, simplified node tree, fills, layout | Direct property reads on each node: `name`, `type`, `id`, `fills`, `strokes`, `effects`, `layoutMode`, `paddingX`, `itemSpacing`, `absoluteBoundingBox`, `boundVariables`. For text: `getStyledTextSegments`. | One-to-one; the plugin sees more raw detail. We need to build the "computed style" view ourselves (resolving variables, walking style references). |
| `get_screenshot(fileKey, nodeId)` | `node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 }})` | Works; we control scale and format. Slower per call but no rate limits. |
| `use_figma` consolidated script — variant info, computed text styles, fills, parent backgrounds for contrast | Build it ourselves on main thread, post a clean DTO to UI. Variant info from `componentSet.componentPropertyDefinitions` + each variant `ComponentNode`. Computed text from `getStyledTextSegments`. Parent backgrounds via ancestor walk + `absoluteBoundingBox` overlap test. Variables resolved via `Variable.resolveForConsumer(node)`. | This is the bulk of the port. Detailed mapping in §16.2. |

### 16.2 Concrete data shapes we'll build on the main thread

```ts
// Per text-layer audit input
type TextAuditDTO = {
  id: string
  name: string
  characters: string                       // truncated for safety
  segments: Array<{
    start: number
    end: number
    fontFamily: string
    fontStyle: string                      // e.g. "Regular", "Bold Italic"
    fontWeight: number                     // 100..900
    fontSize: number                       // px
    lineHeight: { unit: 'PIXELS'|'PERCENT'|'AUTO', value?: number, resolvedPx?: number }
    letterSpacing: { unit: 'PIXELS'|'PERCENT', value: number, resolvedPx: number }
    textCase: TextCase
    textDecoration: TextDecoration
    fillHex: string | null                 // resolved color (variable-aware), null if non-solid
    fillSource:
      | { kind: 'raw' }
      | { kind: 'style', styleId: string, styleName: string }
      | { kind: 'variable', variableId: string, variableName: string, modeId: string, modeName: string }
      | { kind: 'gradient' | 'image' | 'pattern' | 'video' }
  }>
  // Computed background sample for contrast
  background:
    | { kind: 'solid', hex: string, source: TextAuditDTO['segments'][0]['fillSource'] }
    | { kind: 'mixed', reason: string }    // gradient/image/multiple overlaps → manual review
  bbox: { x: number, y: number, width: number, height: number }
  pageId: string
  parentChain: string[]                    // ids
}
```

The shape mirrors what our skill already produces, so the report layer above is unchanged.

### 16.3 Things MCP gives us that the Plugin API does NOT

| MCP gives | Plugin API status |
|---|---|
| Code Connect mappings (designed component ↔ codebase component) | **Not exposed to plugins.** Code Connect data is server-side. If we need it we have to call the Figma REST API from the UI iframe with a personal access token. |
| Server-side "context hints" (annotations, inline notes) | Available as `node.description`, `node.annotations` (newer API), or via REST. Pluggable but not identical to MCP's processed output. |
| Pre-rendered, AI-friendly screenshot with overlays | Plugin can `exportAsync`, but if we want overlays we draw them client-side or post-process server-side. |
| Cross-file knowledge in one call | Plugin can only see the current file. Multi-file audits require either the user re-running the plugin per file, or an out-of-band REST workflow. |

### 16.4 Things the Plugin API gives us that MCP does NOT

| Plugin advantages |
|---|
| **Full variable tree with `resolveForConsumer`** — the only reliable way to get the actual rendered color in mode-aware files. MCP often returns the variable name without resolving. |
| **All `getStyledTextSegments` fields** — letter spacing, leading trim, hyperlink, list options, openTypeFeatures. MCP omits several. |
| **No round-trip latency.** Reads are local; an audit of 300 frames takes ~1s of pure reads vs minutes via MCP. |
| **In-context UI** — annotations rendered directly on the canvas, "jump to issue" via `figma.viewport.scrollAndZoomIntoView`. |
| **Live reactivity.** We can observe `figma.on('selectionchange')` or `'documentchange'` and re-audit incrementally. |
| **Run in Dev Mode** — auditor surfaces inside Inspect panel for engineers, not just designers. |

### 16.5 Where variables vs raw colors vs styles will need special handling

Our contrast checker must handle three color sources for every text fill and every ancestor background fill:

1. **Raw color.** `paint.color` directly. Multiply by `paint.opacity * node.opacity * ancestor opacity`. Convert `0..1` floats to `0..255`.
2. **Style-bound color.** `node.fillStyleId` set (or per-paint inside a multi-fill node — note text styles bind as `textStyleId` separately). Resolve via `figma.getStyleByIdAsync` to get the underlying paints; record the style name in the report so the fix is "edit style 'Surface/Primary'" not "edit layer."
3. **Variable-bound color.** `paint.boundVariables.color` set. Resolve via `figma.variables.getVariableByIdAsync` then `variable.resolveForConsumer(textNode)`. **Do this from the text node's perspective, not the surface's**, so mode inheritance from ancestors is correct. Record both the variable name and the mode it resolved in.

For contrast against an image, gradient, video, or pattern: we cannot give a deterministic ratio. Report `manual-review` with the surface kind. Optionally compute a perceived-luminance histogram by exporting a small PNG of the immediate background and sampling — but that's a v2 feature, not required for parity.

For multi-fill layers (a tinted overlay over a solid base), composite top-down: start with the deepest opaque solid fill, alpha-blend each layer above, ending with the layer's own fill. Use straight-alpha math:

```ts
// over-operator: result = src * src.a + dst * (1 - src.a)
```

### 16.6 Action items derived from this research

1. **Fix the manifest first.** `documentAccess: 'dynamic-page'` is non-negotiable; everything else is downstream.
2. **Pick esbuild + TypeScript + `@figma/plugin-typings`** for the toolchain. Add `eslint-plugin-figma-plugins`.
3. **Split the codebase** into `main/` (sandbox, all `figma.*` access) and `ui/` (HTML/CSS/TS, uses `fetch` if needed). A small `protocol.ts` shared module defines the message types both sides import.
4. **Build the read pipeline once** — one async traversal that returns the DTOs in §16.2 — and reuse for page-level, journey-level, and dev-handoff audits. Differences between modes are filtering, not re-traversal.
5. **Resolve every color through `Variable.resolveForConsumer`** when bound; never read `valuesByMode` directly without knowing the mode.
6. **Use `figma.skipInvisibleInstanceChildren = true`** at startup.
7. **Cap `findAll` use** — prefer `findAllWithCriteria({ types })` per loaded page.
8. **Set `themeColors: true`** on `showUI` and design the report UI with `--figma-color-*` from day one.
9. **Surface progress via `figma.ui.postMessage`** for any operation > 1s; don't block on a single `await` chain.
10. **Always end with `figma.closePlugin()`** in a `finally` block.

---

## Appendix A — minimal end-to-end skeleton

```ts
// main.ts
figma.skipInvisibleInstanceChildren = true
figma.showUI(__html__, { width: 420, height: 600, themeColors: true })

figma.ui.onmessage = async (msg: { kind: 'run' }) => {
  if (msg.kind !== 'run') return
  try {
    const sel = figma.currentPage.selection
    if (sel.length === 0) {
      figma.notify('Select one or more frames to audit.', { error: true })
      return
    }
    const findings = []
    for (const node of sel) {
      const texts = (node as FrameNode).findAllWithCriteria({ types: ['TEXT'] })
      for (const t of texts) findings.push(await auditText(t))
    }
    figma.ui.postMessage({ kind: 'findings', findings })
  } catch (e) {
    figma.notify(String(e), { error: true })
  }
}

async function auditText(t: TextNode) {
  const segments = t.getStyledTextSegments(['fontSize', 'fontName', 'fontWeight', 'fills', 'lineHeight', 'letterSpacing', 'boundVariables'])
  // ... resolve fills/variables, walk parent for background, run rules
  return { id: t.id, name: t.name, /* ... */ }
}
```

```html
<!-- ui.html -->
<button id="run">Audit selection</button>
<pre id="out"></pre>
<script>
  document.getElementById('run').onclick = () => {
    parent.postMessage({ pluginMessage: { kind: 'run' } }, '*')
  }
  window.onmessage = (e) => {
    const msg = e.data.pluginMessage
    if (msg?.kind === 'findings') {
      document.getElementById('out').textContent = JSON.stringify(msg.findings, null, 2)
    }
  }
</script>
```

---

## Appendix B — useful primary URLs

- API reference: https://developers.figma.com/docs/plugins/api/api-reference/
- Manifest: https://developers.figma.com/docs/plugins/manifest/
- How plugins run: https://developers.figma.com/docs/plugins/how-plugins-run/
- Working with text: https://developers.figma.com/docs/plugins/working-with-text/
- Working with variables: https://developers.figma.com/docs/plugins/working-with-variables/
- Async tasks: https://developers.figma.com/docs/plugins/async-tasks/
- Network requests: https://developers.figma.com/docs/plugins/making-network-requests/
- Creating UI: https://developers.figma.com/docs/plugins/creating-ui/
- Working in Dev Mode: https://developers.figma.com/docs/plugins/working-in-dev-mode/
- Libraries and bundling: https://developers.figma.com/docs/plugins/libraries-and-bundling/
- TypeScript: https://developers.figma.com/docs/plugins/typescript/
- API errors: https://developers.figma.com/docs/plugins/api/api-errors/
- TextNode: https://developers.figma.com/docs/plugins/api/TextNode/
- Variable: https://developers.figma.com/docs/plugins/api/Variable/
- PaintStyle: https://developers.figma.com/docs/plugins/api/PaintStyle/
- Editor types: https://developers.figma.com/docs/plugins/setting-editor-type/
