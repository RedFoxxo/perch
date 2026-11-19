import { describe, expect, it } from 'vitest'
import { parseResult } from '../src/backend.js'
import type { ToolContext, ToolOutput } from '../src/tools/types.js'
import { allTools } from '../src/server.js'
import { context, fakeBackend, fixture, ok, W } from './helpers.js'

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

  it('refuses a click on an element whose primary action is only named like an object key', async () => {
    const { backend, calls } = fakeBackend({
      get_app_state: () => ok({ snapshot_id: 's', accessibility_tree: [{ index: 5, role: 'button', name: 'Odd', states: ['enabled', 'showing'], actions: ['constructor'] }] }),
      perform_action: done,
    })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e5' }], then: 'none' }, ctx)
    expect(textOf(r)).toContain(`refused click e5: e5 can't be clicked in the background`)
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

  it('refuses points outside the screenshot, which would land in other windows', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 100, height: 80, scale: 0.5 }), activate_window: done, click: done, scroll: done })
    const ctx = context(backend)
    await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    for (const step of [{ click: [100, 10] }, { click: [-1, 10] }, { scroll: [10, 80], direction: 'down' }]) {
      const r = await call('act_window', { window: W, steps: [{ focus: true }, step], then: 'none' }, ctx)
      expect(textOf(r)).toContain(`is outside the last screenshot of window ${W} (100×80 px)`)
    }
    expect(calls.map((c) => c.tool)).not.toContain('click')
    expect(calls.map((c) => c.tool)).not.toContain('scroll')
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
    // The answer computer-use-linux 0.7.53 gives, with neutral names; only the window id changes.
    const answer = fixture('focused_window.json') as { focused_window: { window_id: number } }
    let focused = W
    const { backend, calls } = fakeBackend({ focused_window: () => ok({ ...answer, focused_window: { ...answer.focused_window, window_id: focused } }), type_text: done })
    const ctx = context(backend)
    expect(textOf(await call('act_window', { window: W, steps: [{ type: 'è', focused: true }], then: 'none' }, ctx))).toBe('1 ok type (1 characters)')
    expect(calls.at(-1)).toEqual({ tool: 'type_text', args: { text: 'è' } })

    focused = 42 // the user clicked into another window
    const r = await call('act_window', { window: W, steps: [{ type: 'è', focused: true }] }, ctx)
    expect(textOf(r)).toContain('does not have the focus')
    expect(calls.filter((c) => c.tool === 'type_text')).toHaveLength(1)
  })

  it('places a drag in whole-desktop pixels from the last full-screen screenshot', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 960, height: 270, scale: 0.25 }), activate_window: done, drag: done })
    const ctx = context(backend)
    await call('read_screenshot', { max_edge: 960 }, ctx)
    await call('act_window', { window: W, steps: [{ focus: true }, { drag: [10, 10], to: [50, 60] }], then: 'none' }, ctx)
    expect(calls.at(-1)).toEqual({ tool: 'drag', args: { start_x: 40, start_y: 40, end_x: 200, end_y: 240 } })
  })

  it('refuses a drag before a full-screen screenshot, even after one of the window', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 500, height: 500, scale: 0.5 }), activate_window: done, drag: done })
    const ctx = context(backend)
    await call('read_screenshot', { window: W, max_edge: 500 }, ctx)
    const r = await call('act_window', { window: W, steps: [{ focus: true }, { drag: [10, 10], to: [50, 60] }] }, ctx)
    expect(textOf(r)).toContain('refused drag [10,10] to [50,60]: read_screenshot without a window first')
    expect(calls.map((c) => c.tool)).not.toContain('drag')
  })

  it('refuses a drag that ends outside the whole-screen screenshot', async () => {
    const { backend, calls } = fakeBackend({ screenshot: () => ok({ width: 960, height: 270, scale: 0.25 }), activate_window: done, drag: done })
    const ctx = context(backend)
    await call('read_screenshot', { max_edge: 960 }, ctx)
    const r = await call('act_window', { window: W, steps: [{ focus: true }, { drag: [10, 10], to: [10, 300] }] }, ctx)
    expect(textOf(r)).toContain('refused drag [10,10] to [10,300]: [10, 300] is outside the last whole-screen screenshot (960×270 px)')
    expect(calls.map((c) => c.tool)).not.toContain('drag')
  })

  it('reports steps that already ran when the desktop server fails midway', async () => {
    const { backend } = fakeBackend({
      press_key: done,
      type_text: () => {
        throw new Error('MCP error -32000: Connection closed')
      },
    })
    const r = await call('act_window', { window: W, steps: [{ key: 'ctrl+l' }, { type: 'x' }, { key: 'Return' }], then: 'none' }, context(backend))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe(
      '1 ok key ctrl+l\n2 unknown type (1 characters): the desktop server failed (MCP error -32000: Connection closed); this step may have run. Look before retrying.\nStopped; steps 3–3 not run.',
    )
  })

  it('gives the reason from error when a step fails without a message', async () => {
    const { backend } = fakeBackend({
      activate_window: () => parseResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'window not found', permissions_hint: 'Run read_windows.' }) }] }),
    })
    const r = await call('act_window', { window: W, steps: [{ focus: true }], then: 'none' }, context(backend))
    expect(textOf(r)).toContain('1 failed focus: window not found Run read_windows.')
  })

  it('acts in windows whose position the compositor does not know (niri)', async () => {
    const { backend } = fakeBackend({ list_windows: () => ok({ windows: [{ window_id: W, app_id: 'app', pid: 1, bounds: { x: null, y: null, width: 800, height: 600 } }] }), press_key: done })
    expect(textOf(await call('act_window', { window: W, steps: [{ key: 'q' }], then: 'none' }, context(backend)))).toBe('1 ok key q')
  })

  it('says why the window list failed instead of calling the window gone', async () => {
    const { backend, calls } = fakeBackend({ list_windows: () => ok({ windows: [], error: 'GNOME Shell refused the call.', permissions_hint: 'Install the window extension.' }), press_key: done })
    const ctx = context(backend)
    expect(textOf(await call('read_windows', {}, ctx))).toBe('Could not list windows: GNOME Shell refused the call. Install the window extension.')
    expect(textOf(await call('act_window', { window: W, steps: [{ key: 'q' }] }, ctx))).toBe('Nothing sent: could not list windows: GNOME Shell refused the call. Install the window extension.')
    expect(calls).toEqual([])
  })

  it('shows the tree again after acting in a window that was read', async () => {
    const { backend } = fakeBackend({ get_app_state: tree('snap-3'), perform_action: done })
    const ctx = context(backend)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e5' }] }, ctx)
    expect(textOf(r)).toBe('1 ok click e5\n[e1 frame "App"]\n  [e5 button "Save"]\n  [e6 table cell "Places"]')
  })
})
