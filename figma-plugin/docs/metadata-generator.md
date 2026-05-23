# Metadata Generator — Specification

The metadata generator captures accessibility intent that no algorithm can infer — the authored values a developer needs at handoff. The designer selects a component, clicks **Generate metadata**, and the plugin draws an editable **Accessibility Spec** frame in the empty canvas space beside the selection. Values are pre-filled from existing detection where possible, AI-drafted for image alt text, and left as editable placeholder slots everywhere else. Every value is an ordinary Figma text node the designer can edit.

## Entry point and feedback

- **Trigger:** a secondary CTA, **Generate metadata**, placed directly beneath the existing **Run audit** button. It is visually smaller / lower-weight than Run audit — a quiet secondary action, not a competing primary.
- **On click:** the plugin builds the Accessibility Spec frame and places it on the canvas in the empty space immediately beside the selected component. The frame appears in the document itself, not inside the plugin panel.
- **Confirmation:** a transient toast inside the plugin reads **"Metadata generated"**, then dismisses on its own — success feedback so the designer knows the canvas frame was produced.
- **AI gating:** image alt text is the only AI-backed field. When AI is enabled it is drafted as part of generation; when AI is off that step is skipped and alt-text renders as an empty editable slot. Nothing else changes — no other field uses AI, no prompt, no error.

## Scope

### Fields

| Field | Applies to | Pre-fill source | AI |
|---|---|---|---|
| **Image role + alt text** | Images (image DTO) | Role is a designer choice — `informative` / `decorative` / `functional` / `complex`. Alt text is AI-generated from the image when AI is enabled, otherwise an empty slot | Yes — images only |
| **Accessible name** | Icon-only and interactive elements (interactivity classifier) | Component / main-component / layer name, run through the placeholder/reject filter so junk never surfaces; otherwise an empty slot | No |
| **Reading / focus order** | All focusable elements (clickables + form inputs) | Document order, as the default sequence the designer reorders | No |
| **Form field semantics** | Form inputs (form-input detection) | Label (detected or layer name); input purpose from the `input/<suffix>` regex. Required state and error-message text are empty slots | No |
| **Link / button intent** | Clickables classified as link / button | Current label text shown for reference. Destination, opens-new-tab, and is-download are empty slots | No |

### Out of scope

Heading levels and landmarks; group semantics; a JSON / Markdown export (the Figma frame is the only artifact for now — a machine-readable export is a later addition).

## Generation flow

1. Designer selects a single component and clicks the **Generate metadata** secondary CTA (beneath **Run audit**).
2. The plugin runs the existing read pipeline (classifier, form-input detection, image DTO, layer/component names).
3. Each candidate value is **validated** with the placeholder/reject logic from 2.4.6 (`matchesPlaceholder` / `isRejected` in `src/checks/runners/headings-labels.ts`). A value that is empty, a leaked layer name (`Frame 12`), raw numbers, or other junk becomes an empty slot rather than a wrong value.
4. **AI** drafts image alt text when AI is enabled — one call per image, on demand. No other field uses AI; accessible names are deterministic or an empty slot.
5. With AI disabled, or where nothing is derivable, the field renders as a visible empty slot the designer types into.
6. The plugin draws a new **Accessibility Spec** frame in the empty space beside the selected component.
7. A transient **"Metadata generated"** toast appears in the plugin and auto-dismisses.

## Regeneration

**A new frame is created on every generation.** The generator never updates or replaces a previously generated frame — designer edits in an existing frame are never touched, because a fresh frame is produced each time. There is no per-field "edited" tracking and no shared-plugin-data stamp, because nothing is re-discovered.

Each frame is named **`<Component name> — Metadata`**, identical across regenerations (no timestamp or suffix). Successive frames cascade-offset (each new one shifted a fixed amount from the last) so a fresh frame is never hidden directly behind a previous one; stale frames are the designer's to keep or delete.

## Frame structure

A generated auto-layout frame, placed beside the selected component:

```
┌ <Component name> — Metadata                              ┐
│ ── Reading / focus order ──                              │
│  1. Search field   2. Submit   3. Results list           │
│ ── Elements ──                                           │
│  ▸ icon-search  (button)                                 │
│     Accessible name : Search                             │
│     Intent          : ⟨slot⟩                             │
│     Opens new tab   : ⟨slot⟩                             │
│     Is download     : ⟨slot⟩                             │
│  ▸ hero.png  (image)                                     │
│     Role            : informative                        │
│     Alt text        : Family reviewing a loan offer      │
│  ▸ Email  (form field)                                   │
│     Label           : Email address                      │
│     Input purpose   : email                              │
│     Required        : ⟨slot⟩                             │
│     Error message   : ⟨slot⟩                             │
└──────────────────────────────────────────────────────────┘
```

- **Reading / focus order** is a single numbered block at the top (a whole-screen sequence).
- Every other field is grouped under its element as a per-element card, so a developer reads one element's full spec together.
- Each value is an editable Figma text node. Unknown / AI-off / non-derivable values render as a muted placeholder slot — italic grey text `⟨ add <field> ⟩` (e.g. `⟨ add alt text ⟩`, `⟨ add intent ⟩`) the designer types over.
- Layout uses vertical auto-layout so cards stay aligned regardless of value length.

### Visual design

A plain, neutral spec sheet with its **own light palette** — independent of the plugin UI's design tokens. Generous whitespace so it doesn't read cramped.

| Element | Spec |
|---|---|
| Font | **Inter** (Figma-bundled; `loadFontAsync`), styles Regular / Medium / Semi Bold |
| Frame | vertical auto-layout, fixed width **560 px**, background `#FFFFFF`, padding `32`, section spacing `24` |
| Title (`<Component> — Metadata`) | Inter Semi Bold 20 / `#111827` |
| Section header (`Reading / focus order`, `Elements`) | Inter Semi Bold 12, uppercase, tracked / `#6B7280`, 1 px `#E5E7EB` rule beneath |
| Focus-order list | Inter Regular 14 / `#1F2937`, numbered |
| Element card | vertical auto-layout, 12 px row gap; 1 px `#E5E7EB` top separator + 16 px top padding between cards |
| Element heading | Inter Medium 14 / `#111827`; element type in parens / `#9CA3AF` |
| Field label | Inter Medium 12 / `#6B7280` |
| Field value | Inter Regular 14 / `#1F2937` |
| Empty slot | Inter Regular 14 *italic* / `#9CA3AF`, text `⟨ add <field> ⟩` |
| Placement | right of the selected component's absolute bounds + 80 px gap, same top edge; each regeneration cascades +40 px x / +40 px y |

## Pipeline summary

```
read pipeline ─► deterministic pre-fill ─► validate (2.4.6 reject/placeholder)
              ─► AI (image alt only, when enabled) ─► empty slot otherwise
              ─► render new "<Component> — Metadata" frame beside the component
```

## Reuse

- Interactivity classifier (`src/read/interactivity.ts`) — clickables, icon-only candidates.
- Form-input detection (`src/read/form-input.ts`, `src/read/regex.ts`) — fields, label inference, input-purpose suffix.
- Image DTO + image-bytes path used by the image-of-text check — the same bytes feed AI alt-text drafting.
- `matchesPlaceholder` / `isRejected` (`src/checks/runners/headings-labels.ts`) — value validation.
- AI provider abstraction (`src/ui/ai/`) — image alt-text drafting only; honors the existing AI-enabled toggle.
- Figma frame construction (`figma.createFrame` / `createText`, auto-layout, `loadFontAsync`) — requires editor write access; in read-only Dev Mode the generator surfaces a clear "cannot write to this file" state.
