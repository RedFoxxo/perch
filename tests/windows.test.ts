import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodePng, encodeRgb, fitPng } from '../src/png.js'
import { allTools } from '../src/server.js'
import { newSession, type ToolContext, type ToolOutput } from '../src/tools/types.js'
import { openComputerUse, windowsBackend, type OpRequest, type OpResponse } from '../src/windows.js'

const W = 4242
const FOREGROUND = 'OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT'
const FOCUS = 'OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS'

// Shaped like open-computer-use's `op` answers for classic Notepad.
const frame = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height })
const records = [
  { index: 0, runtimeId: [42, 1], name: 'Untitled - Notepad', controlType: 'ControlType.Window', frame: frame(0, 0, 800, 600) },
  { index: 1, runtimeId: [42, 2], name: 'Application', controlType: 'ControlType.MenuBar', frame: frame(0, 30, 800, 20) },
  { index: 2, runtimeId: [42, 3], name: 'File', controlType: 'ControlType.MenuItem', frame: frame(0, 30), actions: ['Expand'] },
  { index: 3, runtimeId: [42, 4], name: 'Text Editor', controlType: 'ControlType.Edit', value: 'hello', frame: frame(0, 60, 800, 500), actions: ['SetValue', 'Scroll'] },
  { index: 4, runtimeId: [42, 5], automationId: 'save', name: 'Save', controlType: 'ControlType.Button', frame: frame(10, 570), actions: ['Invoke'] },
  { index: 5, runtimeId: [42, 6], name: 'Far away', controlType: 'ControlType.ListItem', frame: frame(0, 5000), actions: ['Select'] },
]
const lines = ['\t0 window Untitled - Notepad', '\t\t1 menu bar Application', '\t\t\t2 menu item File', '\t\t3 edit Text Editor', '\t\t4 button Save', '\t\t5 list item Far away']
const bounds = { x: 100, y: 50, width: 2048, height: 1024 }
const blank = encodeRgb(new Uint8Array(2048 * 1024 * 3), 2048, 1024)

/** `actionTakesFocus`: the app answers actions with the keyboard focus, as WinForms does for UI Automation clicks. */
function fakeRuntime(windowBounds: () => typeof bounds = () => bounds, actionTakesFocus = false) {
  const requests: OpRequest[] = []
  const answer = (r: OpRequest): OpResponse => {
    if (r.tool === 'list_windows') return { ok: true, windows: [{ app: 'Notepad', id: W, title: 'Untitled - Notepad' }] }
    if (r.tool === 'get_window_state') {
      return {
        ok: true,
        snapshot: {
          windowBounds: windowBounds(),
          elements: r.max_tree_nodes === 1 ? records.slice(0, 1) : records,
          treeLines: r.max_tree_nodes === 1 ? lines.slice(0, 1) : lines,
          ...(r.include_screenshot ? { screenshotPngBase64: blank.toString('base64') } : {}),
        },
      }
    }
    return { ok: true, snapshot: actionTakesFocus ? { focusedSummary: 'button Save' } : {} }
  }
  return {
    requests,
    runtime: {
      async op(r: OpRequest) {
        if (r.tool !== 'list_windows') requests.push(r)
        return answer(r)
      },
      async captureScreen() {
        return blank
      },
    },
  }
}

async function call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const tool = allTools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.handler(args, ctx)
}
const textOf = (r: ToolOutput) => r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')

function setup(windowBounds?: () => typeof bounds, actionTakesFocus?: boolean) {
  const fake = fakeRuntime(windowBounds, actionTakesFocus)
  return { ...fake, ctx: { backend: windowsBackend(fake.runtime), session: newSession() } }
}

describe('Windows backend', () => {
  it('reads a window as a nested compact tree, leaving out elements outside the window', async () => {
    const { ctx } = setup()
    expect(textOf(await call('read_windows', {}, ctx))).toBe(`${W} Notepad "Untitled - Notepad"`)
    expect(textOf(await call('read_window', { window: W }, ctx))).toBe(
      [
        '[e0 window "Untitled - Notepad"]',
        '  [e1 menu bar "Application"]',
        '    [e2 menu item "File"]',
        '  [e3 edit "Text Editor" editable] = "hello"',
        '  [e4 button "Save"]',
        '(1 off-screen elements left out)',
      ].join('\n'),
    )
  })

  it('clicks an Invoke button through UI Automation with the exact record, never with foreground input', async () => {
    const { ctx, requests } = setup()
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e4' }], then: 'none' }, ctx)
    expect(textOf(r)).toBe('1 ok click e4')
    expect(requests.at(-1)).toMatchObject({ tool: 'perform_secondary_action', windowId: W, element: records[4], action: 'invoke', allow_foreground_input: false })
    expect(requests.at(-1)?.env_flags).toMatchObject({ [FOREGROUND]: '0', [FOCUS]: '0' })
  })

  it('says when a background click brought an app that was behind to the front', async () => {
    const { ctx } = setup(undefined, true)
    await call('read_window', { window: W }, ctx)
    const r = await call('act_window', { window: W, steps: [{ click: 'e4' }, { click: 'e4' }], then: 'none' }, ctx)
    // The second click finds the app already in front: nothing new to report.
    expect(textOf(r)).toBe('1 ok click e4 (the app came to the front)\n2 ok click e4')
  })

  it('types in the background with the foreground gates closed, and says it may not arrive', async () => {
    const { ctx, requests } = setup()
    const r = await call('act_window', { window: W, steps: [{ type: 'hello' }] }, ctx)
    expect(textOf(r)).toBe('1 ok type (5 characters) (background: some apps ignore it, check the result)')
    expect(requests.at(-1)).toMatchObject({ tool: 'type_text', windowId: W, text: 'hello', input_method: 'auto', allow_foreground_input: false })
    expect(requests.at(-1)?.env_flags?.[FOREGROUND]).toBe('0')
  })

  it('sends focused keys only after a focus step, as real input to that window', async () => {
    const { ctx, requests } = setup()
    const refused = await call('act_window', { window: W, steps: [{ key: 'ctrl+s', focused: true }] }, ctx)
    expect(textOf(refused)).toContain('refused key ctrl+s: focused keys bring the window in front of the user')
    expect(requests).toEqual([])

    await call('act_window', { window: W, steps: [{ focus: true }, { key: 'ctrl+s', focused: true }] }, ctx)
    const [focus, key] = requests
    expect(focus).toMatchObject({ tool: 'activate_window', windowId: W, allow_foreground_input: false })
    expect(focus?.env_flags).toMatchObject({ [FOCUS]: '1', [FOREGROUND]: '0' })
    expect(key).toMatchObject({ tool: 'press_key', windowId: W, key: 'ctrl+s', input_method: 'global', allow_foreground_input: true })
  })

  it('shrinks a window screenshot to max_edge and clicks its pixels at the window position of the moment', async () => {
    let now = bounds
    const { ctx, requests } = setup(() => now)
    const shot = await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    expect(textOf(shot)).toContain('1024×512 px.')
    now = { ...bounds, x: 300 } // moved, same size
    const r = await call('act_window', { window: W, steps: [{ focus: true }, { click: [100, 40] }], then: 'none' }, ctx)
    expect(r.isError).toBeUndefined()
    expect(requests.at(-1)).toMatchObject({ tool: 'click', windowId: W, x: 200, y: 80, windowBounds: now, click_method: 'global', allow_foreground_input: true })
  })

  it('refuses screenshot points after the window changed size, sending no click', async () => {
    let now = bounds
    const { ctx, requests } = setup(() => now)
    await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    now = { ...bounds, width: 1000 }
    const r = await call('act_window', { window: W, steps: [{ focus: true }, { click: [100, 40] }], then: 'none' }, ctx)
    expect(textOf(r)).toContain(`2 failed click [100,40]: window ${W} changed size since its screenshot`)
    expect(requests.map((q) => q.tool)).not.toContain('click')
  })

  it('drags between pixels of the window screenshot', async () => {
    const { ctx, requests } = setup()
    await call('read_screenshot', { window: W, max_edge: 1024 }, ctx)
    await call('act_window', { window: W, steps: [{ focus: true }, { drag: [10, 20], to: [30, 40] }], then: 'none' }, ctx)
    expect(requests.at(-1)).toMatchObject({ tool: 'drag', windowId: W, from_x: 20, from_y: 40, to_x: 60, to_y: 80, input_method: 'global' })
  })

  it('saves a screenshot only to a new absolute .png path, never over an existing file', async () => {
    const { ctx } = setup()
    const dir = mkdtempSync(join(tmpdir(), 'perch-test-'))
    try {
      const existing = join(dir, 'notes.png')
      writeFileSync(existing, 'keep')
      const over = await call('read_screenshot', { window: W, max_edge: 400, file: existing }, ctx)
      expect(over.isError).toBe(true)
      expect(readFileSync(existing, 'utf8')).toBe('keep')
      for (const file of ['shot.png', join(dir, 'shot.txt')]) {
        const r = await call('read_screenshot', { window: W, max_edge: 400, file }, ctx)
        expect(textOf(r)).toContain('a new absolute path ending in .png')
        expect(existsSync(file)).toBe(false)
      }
      const fresh = join(dir, 'shot.png')
      expect(textOf(await call('read_screenshot', { window: W, max_edge: 400, file: fresh }, ctx))).toContain(`Saved ${fresh} (400×200 px).`)
      expect(readFileSync(fresh).subarray(1, 4).toString()).toBe('PNG')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a runtime that exits without reading its request, instead of crashing perch', async () => {
    // Node exits at once on a missing script `op`, while perch is still writing the request.
    const runtime = openComputerUse(() => process.execPath)
    await expect(runtime.op({ tool: 'type_text', text: 'x'.repeat(8 << 20) })).rejects.toThrow(/open-computer-use op exited with 1/)
  })
})

describe('PNG', () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name))

  it.each(['go-rgb.png', 'go-rgba.png'])('decodes what Go image/png writes (%s)', (name) => {
    const { width, height, rgb } = decodePng(fixture(name))
    expect([width, height]).toEqual([64, 48])
    for (const [x, y] of [[0, 0], [63, 0], [5, 7], [63, 47], [31, 24]] as const) {
      const at = (y * width + x) * 3
      expect([...rgb.subarray(at, at + 3)]).toEqual([(x * 7) & 0xff, (y * 11) & 0xff, (x * y * 3) & 0xff])
    }
  })

  it('shrinks to the longest edge by averaging the pixels each output pixel covers', () => {
    // Left half black, right half white.
    const src = new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255].concat([0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]))
    const fit = fitPng(encodeRgb(src, 4, 2), 2)
    expect([fit.width, fit.height, fit.scale]).toEqual([2, 1, 0.5])
    expect([...decodePng(fit.png).rgb]).toEqual([0, 0, 0, 255, 255, 255])
  })
})
