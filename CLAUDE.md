# Maanak — Accessibility Checker

> This folder lives inside `.claude/skills/` when deployed. This CLAUDE.md is for active development only.

## Goal
Build a Claude Code skill that audits Figma designs for WCAG 2.1 Level AA compliance via the Figma MCP. No screenshots—MCP only.

## Project Structure
```
wcag-checker/
├── SKILL.md                     (main skill definition & orchestration)
├── docs/
│   ├── testing-workflow.md      (5-phase workflow + all data schemas — source of truth)
│   └── old/                     (outdated — superseded by testing-workflow.md and use_figma integration)
│       ├── wcag/                (WCAG reference docs)
│       ├── figma-integration.md
│       ├── analysis-logic.md
│       ├── audit-format.md
│       ├── criteria-verification.md
│       └── workflow-plan.md
├── scripts/
│   ├── contrast-ratio.py        (WCAG contrast ratio calculator)
│   └── text-spacing-check.py    (WCAG text spacing validator)
├── commands/
│   ├── wcag-page.md             (page-level checklist)
│   ├── wcag-journey.md          (journey-level checklist)
│   ├── wcag-dev.md              (post-figma / dev-handoff checklist)
│   └── wcag-manual.md           (manual checks — not testable by AI or MCP)
└── agents/
    ├── contrast-agent.md        (1.4.3, 1.4.11)
    ├── typography-agent.md      (1.4.12, 1.4.5)
    ├── variant-agent.md         (1.4.1, 2.4.7, 3.3.1, 3.3.2, 3.3.3)
    └── visual-review-agent.md   (subjective visual analysis)
```

> **Note:** Files in `docs/old/` are outdated and should not be referenced. They have been superseded by `docs/testing-workflow.md`, which integrates `use_figma` as the primary data extraction tool and resolves all known audit bugs.

## Notes
- Token-efficient docs without sacrificing accuracy
- All test logic lives in agent files; SKILL.md orchestrates
- Supports both Figma Desktop MCP and Figma Remote MCP
