import { describe, expect, it } from 'vitest'
import { parseResult } from '../src/backend.js'
import type { ToolContext, ToolOutput } from '../src/tools/types.js'
import { allTools } from '../src/server.js'
import { context, fakeBackend, ok, W } from './helpers.js'

// Handlers take parsed arguments; tests pass them as the MCP server would after validation.
async function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const tool = allTools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.handler(args, ctx)
}
const textOf = (r: ToolOutput) => r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')

const tree = (snapshot: string) => () =>
  ok({
    snapshot_id: snapshot,
    accessibility_tree: [
      { index: 1, role: 'frame', name: 'App', states: ['enabled', 'sensitive', 'showing'] },
      { index: 5, parent_index: 1, role: 'button', name: 'Save', states: ['enabled', 'sensitive', 'showing'], actions: ['click'] },
      { index: 6, parent_index: 1, role: 'table cell', name: 'Places', states: ['enabled', 'sensitive', 'showing'], actions: ['expand or contract', 'edit', 'activate'] },
    ],
  })
const done = () => ok({ ok: true, message: 'Action sent.' })
// Built the way the real backend answers.
const failed = (message: string) => () => parseResult({ content: [{ type: 'text', text: JSON.stringify({ ok: false, message }) }] })

describe('act_window', () => {
  it('runs a plain click on an e-ref as the element action, with the snapshot of the last read', async () => {
    const { backend, calls } = fakeBackend({ get_app_state: tree('snap-1'), perform_action: done })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e5' }], then: 'none' }, ctx)
    expect(textOf(r)).toBe('1 ok click e5')
    // perform_action never focuses or raises the window; a pointer click on a hidden workspace would show it to the user.
    expect(calls.at(-1)).toEqual({ tool: 'perform_action', args: { window_id: W, element_index: 5, snapshot_id: 'snap-1', action: 'click' } })
  })

  it('refuses to click an element whose primary action is not a click, rather than expanding or editing it', async () => {
    const { backend, calls } = fakeBackend({ get_app_state: tree('snap-1'), perform_action: done })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e6' }], then: 'none' }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(`refused click e6: e6 can't be clicked in the background (its actions are "expand or contract", "edit", "activate")`)
    expect(calls.map((c) => c.tool)).toEqual(['get_app_state'])
  })

  it('uses the pointer for right and double clicks, after a focus step', async () => {
    const { backend, calls } = fakeBackend({ get_app_state: tree('snap-1'), activate_window: done, click: done })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    await call('act_window', { window: W, steps: [{ focus: true }, { click: 'e5', button: 'right' }, { click: 'e5', count: 2 }], then: 'none' }, ctx)
    expect(calls.slice(-2).map((c) => [c.tool, c.args.button, c.args.click_count])).toEqual([
      ['click', 'right', undefined],
      ['click', undefined, 2],
    ])
  })

  it('refuses mouse steps without a focus step, so a hidden window never jumps in front of the user', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 100, height: 100, scale: 1 }), click: done })
    const ctx = context(backend)
    await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: [10, 10] }] }, ctx)
    expect(textOf(r)).toContain('refused click [10,10]: this step uses the mouse')
    expect(calls.map((c) => c.tool)).toEqual(['screenshot'])
  })

  it('refuses a window id that now belongs to another app, sending nothing', async () => {
    let windows = [{ window_id: W, app_id: 'kitty', pid: 10 }]
    const { backend, calls } = fakeBackend({ list_windows: () => ok({ windows }), press_key: done })
    const ctx = context(backend)
    await call('read_windows', {}, ctx)
    windows = [{ window_id: W, app_id: 'XCalc', pid: 20 }] // kitty closed, xcalc got its address
    const r = await call('act_window', { window: W, steps: [{ key: 'q' }] }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(`Nothing sent: window ${W} was kitty and is now XCalc: the first one closed and its id was reused. Call read_windows.`)
    expect(calls).toEqual([])
  })

  it('refuses a window that is gone', async () => {
    const { backend } = fakeBackend({ list_windows: () => ok({ windows: [] }) })
    const r = await call('act_window', { window: W, steps: [{ key: 'q' }] }, context(backend))
    expect(textOf(r)).toBe(`Nothing sent: window ${W} is gone; call read_windows.`)
  })

  it('refuses an e-ref after another window was read, without sending anything', async () => {
    const { backend, calls } = fakeBackend({ get_app_state: tree('snap-2'), perform_action: done })
    const ctx = context(backend)
    await call('read_window', { window: 99 }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e5' }] }, ctx)
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain(`refused click e5: read_window ${W} first`)
    expect(calls.map((c) => c.tool)).toEqual(['get_app_state'])
  })

  it('converts screenshot pixels to window capture pixels with the screenshot scale', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 1024, height: 561, scale: 0.5 }), activate_window: done, click: done })
    const ctx = context(backend)
    await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    await call('act_window', { window: W, steps: [{ focus: true }, { click: [100, 51] }], then: 'none' }, ctx)
    expect(calls.at(-1)?.args).toMatchObject({ window_id: W, x: 200, y: 102, relative: true })
  })

  it('refuses [x, y] before a screenshot of the window', async () => {
    const { backend, calls } = fakeBackend({ activate_window: done, click: done })
    const r = await call('act_window', { window: W, steps: [{ focus: true }, { click: [1, 1] }] }, context(backend))
    expect(textOf(r)).toContain(`read_screenshot window ${W} first`)
    expect(calls.map((c) => c.tool)).toEqual(['activate_window'])
  })

  it('stops at the first failing step and says which steps did not run', async () => {
    const { backend, calls } = fakeBackend({ press_key: done, type_text: failed('Did not send input: the active keymap is not US. More detail.') })
    const r = await call('act_window', { window: W, steps: [{ key: 'ctrl+l' }, { type: 'é' }, { key: 'Return' }], then: 'none' }, context(backend))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('1 ok key ctrl+l\n2 failed type (1 characters): Did not send input: the active keymap is not US. More detail.\nStopped; steps 3–3 not run.')
    expect(calls.map((c) => c.tool)).toEqual(['press_key', 'type_text'])
  })

  it('never echoes typed text', async () => {
    const { backend } = fakeBackend({ type_text: done })
    const r = await call('act_window', { window: W, steps: [{ type: 'hunter2' }], then: 'none' }, context(backend))
    expect(textOf(r)).not.toContain('hunter2')
  })

  it('sends focused keys only while the window still has the focus', async () => {
    let focused = W
    const { backend, calls } = fakeBackend({ focused_window: () => ok({ window_id: focused }), type_text: done })
    const ctx = context(backend)
    expect(textOf(await call('act_window', { window: W, steps: [{ type: 'è', focused: true }], then: 'none' }, ctx))).toBe('1 ok type (1 characters)')
    expect(calls.at(-1)).toEqual({ tool: 'type_text', args: { text: 'è' } })

    focused = 42 // the user clicked into another window
    const r = await call('act_window', { window: W, steps: [{ type: 'è', focused: true }] }, ctx)
    expect(textOf(r)).toContain('does not have the focus')
    expect(calls.filter((c) => c.tool === 'type_text')).toHaveLength(1)
  })

  it('places a drag on the desktop from the window position', async () => {
    const { backend, calls } = fakeBackend({
      screenshot: () => ok({ width: 500, height: 500, scale: 0.5 }),
      list_windows: () => ok({ windows: [{ window_id: W, bounds: { x: 1000, y: 20, width: 1000, height: 1000 } }] }),
      activate_window: done,
      drag: done,
    })
    const ctx = context(backend)
    await call('read_screenshot', { window: W, max_edge: 500 }, ctx)
    await call('act_window', { window: W, steps: [{ focus: true }, { drag: [10, 10], to: [50, 60] }], then: 'none' }, ctx)
    expect(calls.at(-1)).toEqual({ tool: 'drag', args: { start_x: 1020, start_y: 40, end_x: 1100, end_y: 140 } })
  })

  it('shows the tree again after acting in a window that was read', async () => {
    const { backend } = fakeBackend({ get_app_state: tree('snap-3'), perform_action: done })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e5' }] }, ctx)
    expect(textOf(r)).toBe('1 ok click e5\n[e1 frame "App"]\n  [e5 button "Save"]\n  [e6 table cell "Places"]')
  })
})
