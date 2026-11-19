import type { TreeNode } from '../upstream.js'

/** Roles worth listing even without a name: you can act on them. */
const INTERACTIVE: Record<string, true> = {
  button: true,
  'toggle button': true,
  'radio button': true,
  'check box': true,
  'menu item': true,
  'check menu item': true,
  'radio menu item': true,
  'combo box': true,
  entry: true,
  text: true,
  'password text': true,
  'spin button': true,
  slider: true,
  link: true,
  'page tab': true,
  'tree item': true,
  // UI Automation's control types, as windows.ts names them.
  edit: true,
  document: true,
  hyperlink: true,
  'list item': true,
  'tab item': true,
  'split button': true,
  spinner: true,
}
/** States shown in a line; the common ones (enabled, visible, focusable…) are implied. */
const SHOWN_STATES = ['checked', 'selected', 'focused', 'expanded', 'editable', 'pressed'] as const
/** Characters of an element's text or value shown; an editor's whole document would flood the context. */
const MAX_TEXT = 1000

function quoted(s: string): string {
  if (s.length <= MAX_TEXT) return JSON.stringify(s)
  return `${JSON.stringify(`${s.slice(0, MAX_TEXT)}…`)} (${s.length - MAX_TEXT} more characters)`
}

/**
 * A window's accessibility tree as compact text, one element per line, indented
 * by nesting: `[e34 button "Open Parent"]`. Elements that are off screen, and
 * unnamed containers, are left out; their children move up a level.
 */
export function formatTree(nodes: TreeNode[]): string {
  const children = new Map<number | null, TreeNode[]>()
  const byIndex = new Map(nodes.map((n) => [n.index, n]))
  for (const n of nodes) {
    // A parent the server left out of the list counts as the root.
    const parent = n.parent_index != null && byIndex.has(n.parent_index) ? n.parent_index : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent)!.push(n)
  }

  const lines: string[] = []
  let hidden = 0
  const visit = (node: TreeNode, depth: number): void => {
    const states = new Set(node.states ?? [])
    if (node.role !== 'application' && node.role !== 'frame' && !states.has('showing')) {
      hidden++
      return
    }
    const text = node.text?.content ?? undefined
    const shown =
      node.role !== 'application' && Boolean(node.name || (text && text !== node.name) || states.has('editable') || INTERACTIVE[node.role])
    let next = depth
    if (shown) {
      const flags: string[] = []
      // Toolkits drop both for a disabled control; a page tab can be enabled without being sensitive.
      if (!states.has('enabled') && !states.has('sensitive')) flags.push('disabled')
      for (const s of SHOWN_STATES) if (states.has(s)) flags.push(s)
      let line = `${'  '.repeat(depth)}[e${node.index} ${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${flags.length ? ` ${flags.join(' ')}` : ''}]`
      if (text && text !== node.name) line += ` ${quoted(text)}`
      if (node.value?.text) line += ` = ${quoted(node.value.text)}`
      else if (node.value?.current != null) line += ` = ${node.value.current}`
      lines.push(line)
      next = depth + 1
    }
    for (const child of children.get(node.index) ?? []) visit(child, next)
  }
  for (const root of children.get(null) ?? []) visit(root, 0)

  if (hidden) lines.push(`(${hidden} off-screen elements left out)`)
  return lines.join('\n')
}
