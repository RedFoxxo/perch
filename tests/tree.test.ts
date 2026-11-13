import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { formatTree } from '../src/format/tree.js'
import { TreeNode } from '../src/upstream.js'
import { fixture } from './helpers.js'

// Thunar's full tree as computer-use-linux returned it (145 nodes, 42.8 KB of JSON).
const thunar = z.array(TreeNode).parse(fixture('thunar-tree-full.json'))

describe('formatTree', () => {
  const out = formatTree(thunar)

  it('lists what the agent can act on, with e-refs, names and states', () => {
    expect(out).toContain('[e34 button "Open Parent"]')
    expect(out).toContain('[e32 button "Back" disabled]')
    expect(out).toContain('[e61 text editable] "/tmp/test-folder/"')
    expect(out).toContain('[e24 menu "Edit"]')
  })

  it('nests children under their nearest listed ancestor', () => {
    const lines = out.split('\n')
    expect(lines[0]).toBe('[e1 frame "test-folder - Thunar"]')
    expect(lines).toContain('  [e34 button "Open Parent"]')
  })

  it('leaves out unnamed containers, off-screen elements, and says how many are off screen', () => {
    expect(out).not.toMatch(/\[e63 /)
    expect(out).not.toContain('Empty Trash') // in the tree, but not showing
    expect(out).toMatch(/\(\d+ off-screen elements left out\)$/)
  })

  it('stays a small fraction of the JSON tree', () => {
    expect(out.length).toBeLessThan(JSON.stringify(thunar).length / 10)
  })

  it('returns nothing for a window without a tree', () => {
    expect(formatTree([{ index: 0, role: 'application', name: 'xcalc' }])).toBe('')
  })
})
