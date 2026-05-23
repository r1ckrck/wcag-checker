# Maanak — Accessibility Checker

> *Maanak* (मानक) — "standard."

Audit a Figma component against **WCAG 2.1 / 2.2 Level AA**, with the equivalent **GIGW 3.0** and **IS 17802** obligations surfaced inline. Two versions — pick the one that matches how you work.

| | Claude Code skill | Figma plugin |
|---|---|---|
| **Lives in** | Claude Code (CLI / IDE / web) | Figma Desktop |
| **You invoke it by** | Typing `/wcag-checker` in chat | Importing the manifest, then **Plugins → Development → Maanak — Accessibility Checker** |
| **Audience** | Anyone already using Claude Code; engineers, technical designers | Designers, PMs, anyone in Figma |
| **Talks to Figma via** | Figma Desktop MCP (Dev Mode) | Native Figma Plugin API |
| **AI for visual review** | Uses your Claude Code model | Bring your own OpenRouter / Anthropic / Google key |
| **Install** | Already there if you have Claude Code; this repo's skill files register automatically | Download zip from Releases, import manifest |
| **Lives in this repo at** | `SKILL.md`, `agents/`, `commands/`, `docs/`, `scripts/` | `figma-plugin/` |

Both share the same audit format and core WCAG math. The **Claude Code skill** (invoked as `/wcag-checker` — the command name is unchanged) covers the original 9-criteria set; the **Figma plugin**, *Maanak — Accessibility Checker*, has since grown the wider set listed below (Link Purpose, Headings & Labels, Target Size, a text-reflow heuristic, a designer marker layer, and the WCAG·GIGW·IS standards-mapping affordance). Pick the version that fits your workflow.

> **MCP** = Model Context Protocol — the bridge that lets Claude Code read structured data from Figma Desktop's Dev Mode. The plugin doesn't use MCP because it runs *inside* Figma and reads nodes via Figma's own Plugin API.

---

## Download — Figma plugin

The plugin ships as a single zip per release. No Node, no terminal, no source build.

1. Grab the latest zip from [Releases](https://github.com/r1ckrck/wcag-checker/releases/latest)
2. Unzip
3. Open Figma Desktop → **Plugins → Development → Import plugin from manifest…** → pick `manifest.json`
4. Run via **Plugins → Development → Maanak — Accessibility Checker**

The deterministic checks (color contrast, typography, form labels, variant focus/error states) run immediately on whatever component you have selected — no setup needed.

For the **AI checks** (visual review and image-of-text), click the gear icon at the top right of the plugin and add a key from one of:

- [OpenRouter](https://openrouter.ai/keys) — single key reaches Claude, GPT, Gemini, and others
- [Anthropic](https://console.anthropic.com)
- [Google AI Studio](https://aistudio.google.com/apikey)

Pick a provider, paste your key, Save. Your key is stored per-user on your own machine and never leaves it except as the request header to the provider you chose.

For source / development work on the plugin, see [`figma-plugin/README.md`](./figma-plugin/README.md).

---

## Use — Claude Code skill

Requires the Figma Desktop MCP (Dev Mode) to be connected to Claude Code.

1. Select a single component in Figma
2. In Claude Code, type `/wcag-checker`

The skill validates the selection, pulls the node data through MCP, runs four parallel subagents (one per WCAG cluster), and prints a structured audit with passes, flags, AI visual observations, and manual checks you'll need to do yourself.

Sibling commands for broader scopes:

| Command | What it does |
|---|---|
| `/wcag-checker` | Audit one component |
| `/wcag-page` | Page-level checklist (heading hierarchy, landmarks, language, etc.) |
| `/wcag-journey` | Multi-screen flow checks (focus order across screens, error recovery) |
| `/wcag-dev` | Post-handoff checks (after the Figma design has been built into code) |
| `/wcag-manual` | The checks AI cannot reliably do — for human review |

The full skill workflow is documented in [`docs/testing-workflow.md`](./docs/testing-workflow.md).

---

## What gets checked

Core criteria both versions share:

| Code | Name | What it tests |
|---|---|---|
| 1.4.1 | Use of Color | Error states differ from default by more than just color *(plugin: opt-in variant audit)* |
| 1.4.3 | Contrast (Minimum) | Text contrast ≥ 4.5:1 (or 3:1 for large text) |
| 1.4.5 | Images of Text | Asset names + AI classifier for baked-in UI text |
| 1.4.11 | Non-Text Contrast | Interactive shapes vs background ≥ 3:1 |
| 2.4.7 | Focus Visible | Focus state is visually distinct from default *(plugin: opt-in variant audit)* |
| 3.3.1 | Error Identification | Errors use more than just color to communicate *(plugin: opt-in variant audit)* |
| 3.3.2 | Labels or Instructions | Form inputs have labels (real or geometrically inferred) |
| 3.3.3 | Error Suggestion | Error text is specific, not vague *(plugin: opt-in variant audit)* |

**Figma plugin — additional coverage** beyond the shared set:

| Code | Name | What it tests |
|---|---|---|
| 2.4.4 | Link Purpose (In Context) | Flags vague clickable text (`read more`, `click here`, …) |
| 2.4.6 | Headings & Labels | Flags placeholder copy on clickables, form labels, and standalone text, behind a numeric/URL/date/short-word reject filter |
| 2.5.8 | Target Size (Minimum) | Clickable + form-input bbox ≥ 24×24 px |
| — | Typography readability | Line-height / letter-spacing / paragraph-spacing floors (a design-stage readability check, not a codified SC) |
| — | Text reflow | Fixed-height text-box heuristic; surfaced in the UI as 1.4.4 · 1.4.10 · 1.4.12 |

The plugin also generates a **handoff metadata frame** beside the selected component — alt text + image role (AI-drafted when AI is enabled), accessible names, reading / focus order, form-field semantics, and link / button intent — every value editable in Figma. See [`figma-plugin/docs/metadata-generator.md`](./figma-plugin/docs/metadata-generator.md).

Plus an **AI-augmented visual review** for issues a deterministic check can't catch (visual hierarchy gaps, color-coded grouping, etc.) and **manual checks** always shown as a bottom note (1.3.3 Sensory Characteristics, 2.2.1 Timing Adjustable, 2.2.2 Pause/Stop/Hide, 2.5.1 Pointer Gestures + Motion Actuation).

---

## How it was built

The project started as a **Claude Code skill**. One `SKILL.md` orchestrates the audit; four subagents — contrast, typography, variant, visual-review — run in parallel via Claude Code's `Agent` tool. Python helpers (`scripts/contrast-ratio.py`, `scripts/text-spacing-check.py`) handle the WCAG math. All Figma data comes through the **Figma MCP** — `get_design_context()`, `get_metadata()`, `use_figma()` — so the audit reads structured node trees, never screenshots. The 5-phase workflow (validate → collect → parse → test → output) is documented in `docs/testing-workflow.md`.

The **Figma plugin** is a ground-up port of that skill into native TypeScript that runs inside Figma's plugin sandbox. It reads nodes through the Figma Plugin API instead of MCP. The deterministic checks are direct re-implementations of the Python helpers in TypeScript, so the math gives identical results. The two AI-augmented checks (visual review and image-of-text) call the user's chosen provider directly from the UI iframe using a key the user pastes once and stores per-user via `figma.clientStorage`. A small **provider abstraction** in `figma-plugin/src/ui/ai/` hides the per-service quirks of OpenRouter, Anthropic, and Google behind a single `VisionProvider` interface.

Both versions converge on the same audit format. Whichever you use, the result is the same.

---

## Repo layout

```
wcag-checker/
├── README.md                 (this file)
├── SKILL.md                  Claude Code skill definition + audit orchestration
├── CLAUDE.md                 development notes for the skill side
├── agents/                   one prompt file per WCAG cluster
│   ├── contrast-agent.md         1.4.3, 1.4.11
│   ├── typography-agent.md       1.4.5, 1.4.12
│   ├── variant-agent.md          1.4.1, 2.4.7, 3.3.1, 3.3.3
│   └── visual-review-agent.md    subjective visual analysis
├── commands/                 slash-command wrappers (page / journey / dev / manual)
├── docs/
│   └── testing-workflow.md   the 5-phase audit workflow
├── scripts/                  Python helpers (contrast + spacing math)
└── figma-plugin/             standalone Figma plugin port
    ├── README.md             plugin install + iterate guide
    ├── CLAUDE.md             plugin architecture + decisions
    └── …
```
