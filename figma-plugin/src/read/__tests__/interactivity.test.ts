import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClickableElements, isClickableName, normalizeLinkText } from '../interactivity.ts'
import { runTouchTargetCheck } from '../../checks/runners/touch-target.ts'
import type { AuditDTO } from '../../shared/dtos.ts'

// ── isClickableName ─────────────────────────────────────────────────

test('matches plain Button', () => {
  assert.equal(isClickableName('Button'), true)
})

test('matches Button with slash-variant path', () => {
  assert.equal(isClickableName('Button/Primary/Large'), true)
})

test('matches PrimaryButton via camelCase split', () => {
  assert.equal(isClickableName('PrimaryButton'), true)
})

test('matches IconButton', () => {
  assert.equal(isClickableName('IconButton'), true)
})

test('matches IconBtn', () => {
  assert.equal(isClickableName('IconBtn'), true)
})

test('matches Btn-Primary', () => {
  assert.equal(isClickableName('Btn-Primary'), true)
})

test('matches Link', () => {
  assert.equal(isClickableName('Link'), true)
})

test('matches Chip', () => {
  assert.equal(isClickableName('Chip'), true)
})

test('matches Tab', () => {
  assert.equal(isClickableName('Tab'), true)
})

test('matches MenuItem (compound include beats simple exclude)', () => {
  assert.equal(isClickableName('MenuItem'), true)
  assert.equal(isClickableName('Menu Item'), true)
  assert.equal(isClickableName('menu-item'), true)
})

test('matches NavItem and ListItem', () => {
  assert.equal(isClickableName('NavItem'), true)
  assert.equal(isClickableName('ListItem'), true)
})

test('matches Checkbox / Radio / Switch / Toggle', () => {
  assert.equal(isClickableName('Checkbox'), true)
  assert.equal(isClickableName('Radio'), true)
  assert.equal(isClickableName('Switch'), true)
  assert.equal(isClickableName('Toggle'), true)
})

test('matches Dropdown / Select / Combobox', () => {
  assert.equal(isClickableName('Dropdown'), true)
  assert.equal(isClickableName('Select'), true)
  assert.equal(isClickableName('Combobox'), true)
})

// ── Exclusions ──────────────────────────────────────────────────────

test('excludes ButtonGroup container', () => {
  assert.equal(isClickableName('ButtonGroup'), false)
  assert.equal(isClickableName('Button Group'), false)
  assert.equal(isClickableName('button-group'), false)
})

test('excludes Tabs (plural) container', () => {
  assert.equal(isClickableName('Tabs'), false)
  assert.equal(isClickableName('Tabs/Selected'), false)
})

test('excludes Menu container but allows MenuItem', () => {
  assert.equal(isClickableName('Menu'), false)
  assert.equal(isClickableName('MenuItem'), true)
})

test('excludes Toolbar / Navigation / Navbar', () => {
  assert.equal(isClickableName('Toolbar'), false)
  assert.equal(isClickableName('Navigation'), false)
  assert.equal(isClickableName('Navbar'), false)
})

test('excludes CheckboxGroup and RadioGroup', () => {
  assert.equal(isClickableName('CheckboxGroup'), false)
  assert.equal(isClickableName('RadioGroup'), false)
})

// ── Non-matches ─────────────────────────────────────────────────────

test('rejects unrelated names', () => {
  assert.equal(isClickableName('Card'), false)
  assert.equal(isClickableName('Container'), false)
  assert.equal(isClickableName('Header'), false)
  assert.equal(isClickableName('Avatar'), false)
})

test('rejects empty / whitespace', () => {
  assert.equal(isClickableName(''), false)
  assert.equal(isClickableName('   '), false)
})

// ── normalizeLinkText ───────────────────────────────────────────────

test('lowercases and trims', () => {
  assert.equal(normalizeLinkText('  Read More  '), 'read more')
})

test('strips trailing arrow', () => {
  assert.equal(normalizeLinkText('Read more →'), 'read more')
  assert.equal(normalizeLinkText('Read more>'), 'read more')
  assert.equal(normalizeLinkText('Read more »'), 'read more')
})

test('strips trailing punctuation', () => {
  assert.equal(normalizeLinkText('Read more.'), 'read more')
  assert.equal(normalizeLinkText('Click here!'), 'click here')
})

test('collapses internal whitespace', () => {
  assert.equal(normalizeLinkText('Read    more'), 'read more')
  assert.equal(normalizeLinkText('Read\n\tmore'), 'read more')
})

test('handles ALL CAPS', () => {
  assert.equal(normalizeLinkText('READ MORE →'), 'read more')
})

test('preserves substantive text', () => {
  assert.equal(
    normalizeLinkText('Read more about home loans'),
    'read more about home loans'
  )
})

test('empty input → empty', () => {
  assert.equal(normalizeLinkText(''), '')
  assert.equal(normalizeLinkText('   '), '')
})

// ── buildClickableElements marker suppression ──────────────────────

test('Include-marked parent suppresses descendant clickables', async () => {
  const root = node('root', 'Frame', 'FRAME')
  const parent = node('parent', 'Button', 'FRAME', root)
  const child = node('child', 'Link', 'TEXT', parent)

  root.findAllWithCriteria = () => [parent, child]
  parent.findAllWithCriteria = () => []

  const clickables = await buildClickableElements(
    root as unknown as SceneNode,
    [],
    [],
    { include: new Set(['parent']), exclude: new Set() }
  )

  assert.deepEqual(clickables.map(c => c.id), ['parent'])
})

test('small info frame with visible vector descendant classifies as icon-wrapper', async () => {
  const root = node('root', 'Card', 'FRAME')
  const icon = node('icon', 'info', 'FRAME', root, { width: 19, height: 19 })
  node('vector', 'Vector', 'VECTOR', icon, { width: 12, height: 12 })

  const clickables = await buildClickableElements(
    root as unknown as SceneNode,
    [],
    []
  )

  assert.equal(clickables.length, 1)
  assert.equal(clickables[0].id, 'icon')
  assert.deepEqual(clickables[0].signals, ['icon-wrapper'])
})

test('icon-wrapper touch target is flagged when under 24 px', async () => {
  const root = node('root', 'Card', 'FRAME')
  const icon = node('icon', 'info', 'FRAME', root, { width: 19, height: 19 })
  node('vector', 'Vector', 'VECTOR', icon, { width: 12, height: 12 })

  const clickables = await buildClickableElements(
    root as unknown as SceneNode,
    [],
    []
  )
  const findings = runTouchTargetCheck(dto({ clickables }))

  assert.equal(findings[0].criterion, '2.5.8')
  assert.equal(findings[0].status, 'flag')
  assert.equal(findings[0].nodeId, 'icon')
})

test('large or rectangular icon-like frames do not classify', async () => {
  const root = node('root', 'Card', 'FRAME')
  const large = node('large', 'info', 'FRAME', root, { width: 64, height: 64 })
  node('large-vector', 'Vector', 'VECTOR', large)
  const rect = node('rect', 'search', 'FRAME', root, { width: 48, height: 20 })
  node('rect-vector', 'Vector', 'VECTOR', rect)

  const clickables = await buildClickableElements(
    root as unknown as SceneNode,
    [],
    []
  )

  assert.deepEqual(clickables.map(c => c.id), [])
})

test('decorative icon-ish frames are rejected by name', async () => {
  const root = node('root', 'Card', 'FRAME')
  const logo = node('logo', 'brand/logo/info', 'FRAME', root, { width: 24, height: 24 })
  node('logo-vector', 'Vector', 'VECTOR', logo)

  const clickables = await buildClickableElements(
    root as unknown as SceneNode,
    [],
    []
  )

  assert.deepEqual(clickables.map(c => c.id), [])
})

const dto = (over: Partial<AuditDTO> = {}): AuditDTO => ({
  component: { id: '0:1', name: 'C', type: 'COMPONENT', width: 0, height: 0, pageId: 'p', pageName: 'P', modeName: null },
  texts: [],
  nonTextContrast: [],
  images: [],
  formInputs: [],
  clickables: over.clickables ?? [],
  variants: null,
  warnings: [],
})

function node(
  id: string,
  name: string,
  type: string,
  parent: Record<string, unknown> | null = null,
  box: { width?: number; height?: number } = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id,
    name,
    type,
    parent,
    visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: box.width ?? 40, height: box.height ?? 40 },
    children: [],
  }
  if (parent) {
    const children = parent.children as Record<string, unknown>[] | undefined
    if (children) children.push(out)
  }
  out.findAllWithCriteria = ({ types }: { types: string[] }) => {
    const found: Record<string, unknown>[] = []
    const visit = (n: Record<string, unknown>): void => {
      for (const child of (n.children as Record<string, unknown>[] | undefined) ?? []) {
        if (types.includes(child.type as string)) found.push(child)
        visit(child)
      }
    }
    visit(out)
    return found
  }
  return out
}
