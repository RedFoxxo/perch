import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { BackendResult } from '../backend.js'
import { FocusedWindow } from '../upstream.js'
import { listWindows, readScreenshot, readWindow, windowId } from './read.js'
import { defineTool, failure, text, type Screenshot, type ToolContext } from './types.js'

// The tool description says what refs and points are, once; per-field descriptions would repeat it in every step.
const Ref = z.string().regex(/^e\d+$/)
// An array of two rather than a tuple: shorter in the tool list, and read the same by every JSON Schema draft.
const Point = z
  .array(z.number())
  .length(2)
  .transform((p) => p as [number, number])
const Target = z.union([Ref, Point])

const Step = z.union([
  z.strictObject({
    click: Target,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional().describe('2 for a double click'),
  }),
  z.strictObject({ type: z.string().describe('Literal text'), focused: z.boolean().optional() }),
  z.strictObject({ key: z.string().describe('Key or chord, e.g. Return, ctrl+s, alt+F4'), focused: z.boolean().optional() }),
  z.strictObject({ set: Ref, value: z.string().describe('Fills a field or slider directly') }),
  z.strictObject({ action: Ref, name: z.string().optional().describe('Named action; default: its first') }),
  z.strictObject({ scroll: Target, direction: z.enum(['up', 'down', 'left', 'right']), pages: z.number().positive().optional() }),
  z.strictObject({ drag: Point, to: Point }),
  z.strictObject({ focus: z.literal(true) }),
  z.strictObject({ wait: z.number().int().min(0).max(10_000).describe('Milliseconds') }),
])
type Step = z.infer<typeof Step>

/** A step perch refused before sending anything. */
class Refused extends Error {}

function element(ref: string, window: number, ctx: ToolContext) {
  const { snapshot } = ctx.session
  if (snapshot?.window !== window) throw new Refused(`read_window ${window} first: ${ref} comes from its last read.`)
  return { element_index: Number(ref.slice(1)), snapshot_id: snapshot.id }
}

/**
 * Converts image pixels of a screenshot to the capture pixels the server takes. A point outside the
 * image would land outside the window, in whatever the user has there.
 */
function toCapture([x, y]: [number, number], shot: Screenshot, of: string): [number, number] {
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) throw new Refused(`[${x}, ${y}] is outside ${of} (${shot.width}×${shot.height} px).`)
  return [Math.round(x / shot.scale), Math.round(y / shot.scale)]
}

/** The window-relative capture pixels of a point of the window's last screenshot. */
function point(p: [number, number], window: number, ctx: ToolContext) {
  const shot = ctx.session.screenshots.get(window)
  if (!shot) throw new Refused(`read_screenshot window ${window} first: [x, y] are pixels of its last screenshot.`)
  const [x, y] = toCapture(p, shot, `the last screenshot of window ${window}`)
  return { x, y }
}

function target(t: string | [number, number], window: number, ctx: ToolContext) {
  return typeof t === 'string' ? element(t, window, ctx) : { ...point(t, window, ctx), relative: true }
}

/** Refuses untargeted keys unless the window still has the focus, so they can't land in the user's windows. */
async function ensureFocused(window: number, ctx: ToolContext): Promise<void> {
  const res = await ctx.backend.call('focused_window', {})
  const answer = FocusedWindow.safeParse(res.data)
  const id = answer.success ? answer.data.focused_window?.window_id : undefined
  if (id !== window) throw new Refused(`window ${window} does not have the focus (the user may have moved it); nothing was sent.`)
}

/**
 * Window ids are compositor addresses that come back for new windows once a window closes.
 * Refuses when `window` is gone, or now belongs to another app than when perch last saw it.
 */
async function checkWindow(window: number, ctx: ToolContext): Promise<void> {
  const list = await listWindows(ctx)
  if ('error' in list) throw new Refused(`could not list windows: ${list.error}`)
  const known = ctx.session.windows.get(window)
  const windows = new Map(list.windows.map((w) => [w.window_id, w]))
  const now = windows.get(window)
  // Keep what perch knew about other windows, so their ids stay checked too.
  for (const [id, w] of windows) if (!ctx.session.windows.has(id) || id === window) ctx.session.windows.set(id, w)
  if (!now) throw new Refused(`window ${window} is gone; call read_windows.`)
  if (known && (known.app_id !== now.app_id || known.pid !== now.pid)) {
    ctx.session.windows.set(window, known)
    throw new Refused(`window ${window} was ${known.app_id ?? 'another app'} and is now ${now.app_id ?? 'another app'}: the first one closed and its id was reused. Call read_windows.`)
  }
}

/**
 * A drag runs in whole-desktop capture pixels: window positions from the compositor are logical
 * and per-monitor, so the points come from a full-screen screenshot instead. Backends that place
 * window-relative points themselves (Windows) take them from the window's screenshot.
 */
function dragArgs(step: { drag: [number, number]; to: [number, number] }, window: number, ctx: ToolContext) {
  const inWindow = ctx.backend.dragInWindow
  const shot = ctx.session.screenshots.get(inWindow ? window : 'screen')
  if (!shot) {
    throw new Refused(
      inWindow ? `read_screenshot window ${window} first: drag points are pixels of its last screenshot.` : 'read_screenshot without a window first: drag points are pixels of the whole screen.',
    )
  }
  const of = inWindow ? `the last screenshot of window ${window}` : 'the last whole-screen screenshot'
  const [sx, sy] = toCapture(step.drag, shot, of)
  const [ex, ey] = toCapture(step.to, shot, of)
  return { ...(inWindow ? { window_id: window } : {}), start_x: sx, start_y: sy, end_x: ex, end_y: ey }
}

/** How a step is reported; typed text is never echoed. */
function labelOf(step: Step): string {
  const where = (t: string | [number, number]) => (typeof t === 'string' ? t : JSON.stringify(t))
  if ('click' in step) return `click ${where(step.click)}`
  if ('type' in step) return `type (${step.type.length} characters)`
  if ('key' in step) return `key ${step.key}`
  if ('set' in step) return `set ${step.set}`
  if ('action' in step) return `action ${step.action}${step.name ? ` ${step.name}` : ''}`
  if ('scroll' in step) return `scroll ${where(step.scroll)} ${step.direction}`
  if ('drag' in step) return `drag ${where(step.drag)} to ${where(step.to)}`
  if ('focus' in step) return 'focus'
  return `wait ${step.wait} ms`
}

/**
 * Primary actions that mean "click" (AT-SPI's, then UI Automation's); the server substitutes only these for a pointer click too.
 * Looked up with `Object.hasOwn`: apps name their actions, and `constructor` must not count.
 */
const CLICK_ACTIONS: Record<string, true> = { click: true, press: true, toggle: true, invoke: true, select: true }

/** Steps that move the real pointer: the window, and its workspace, must be on screen, so they come to the front. */
function usesPointer(step: Step): boolean {
  if ('click' in step) return typeof step.click !== 'string' || (step.button ?? 'left') !== 'left' || (step.count ?? 1) !== 1
  return 'scroll' in step || 'drag' in step
}

/** Sends one step; `undefined` for a wait. Throws `Refused` when it can't be sent safely. */
async function run(step: Step, window: number, ctx: ToolContext, focused: boolean): Promise<BackendResult | undefined> {
  const { backend } = ctx
  if (usesPointer(step) && !focused) {
    throw new Refused('this step uses the mouse, which brings the window (and its workspace) in front of the user: add { focus: true } before it.')
  }
  if ('click' in step) {
    // A plain click on an element runs its own action, which neither focuses nor raises the window,
    // but only when that action is a click; otherwise it would expand, edit or activate instead.
    if (!usesPointer(step) && typeof step.click === 'string') {
      const el = element(step.click, window, ctx)
      const actions = ctx.session.snapshot?.actions.get(el.element_index) ?? []
      const primary = actions[0]
      if (primary === undefined || !Object.hasOwn(CLICK_ACTIONS, primary.toLowerCase())) {
        const has = actions.length ? `its actions are ${actions.map((a) => JSON.stringify(a)).join(', ')}` : 'it has no actions'
        throw new Refused(`${step.click} can't be clicked in the background (${has}): use { action: "${step.click}", name } or a focus step and a click on a screenshot point.`)
      }
      return backend.call('perform_action', { window_id: window, ...el, action: primary })
    }
    return backend.call('click', { window_id: window, ...target(step.click, window, ctx), button: step.button, click_count: step.count })
  }
  if ('type' in step || 'key' in step) {
    const tool = 'type' in step ? 'type_text' : 'press_key'
    const input = 'type' in step ? { text: step.type } : { key: step.key }
    if (!step.focused) return backend.call(tool, { window_id: window, ...input })
    if (backend.focusedInputByWindow) {
      // The backend brings the window forward itself; require the explicit focus step all the same.
      if (!focused) throw new Refused('focused keys bring the window in front of the user: add { focus: true } before them.')
      return backend.call(tool, { window_id: window, ...input, focused: true })
    }
    await ensureFocused(window, ctx)
    return backend.call(tool, input)
  }
  if ('set' in step) return backend.call('set_value', { window_id: window, ...element(step.set, window, ctx), value: step.value })
  if ('action' in step) return backend.call('perform_action', { window_id: window, ...element(step.action, window, ctx), action: step.name })
  if ('scroll' in step) return backend.call('scroll', { window_id: window, ...target(step.scroll, window, ctx), direction: step.direction, pages: step.pages })
  if ('drag' in step) return backend.call('drag', dragArgs(step, window, ctx))
  if ('focus' in step) return backend.call('activate_window', { window_id: window })
  await sleep(step.wait)
  return undefined
}

export const actTools = [
  defineTool({
    name: 'act_window',
    description:
      'Run steps in one window, in order; stops at the first that fails. ' +
      "Targets: e-refs from read_window, or [x, y] pixels of this window's last read_screenshot (drag: of a whole-screen read_screenshot; Windows: of the window's). " +
      "Element clicks, set and action don't bring the window to the front (Windows: classic controls may, and the step says so). " +
      'Keys and typing stay in the background on Hyprland and Windows (some Windows apps ignore them: check); elsewhere they focus the window. ' +
      'Mouse steps ([x, y] clicks, right or double clicks, scroll, drag) need a focus step first, which shows the window to the user. ' +
      'focused: true sends real keys (any layout and characters) to the window after a focus step; refused if the focus moved. ' +
      'then: tree (default after read_window), screenshot (raises the window except on Hyprland and Windows) or none.',
    input: {
      window: windowId,
      steps: z.array(Step).min(1).max(20),
      then: z.enum(['tree', 'screenshot', 'none']).optional(),
    },
    async handler({ window, steps, then }, ctx) {
      try {
        await checkWindow(window, ctx)
      } catch (error) {
        if (error instanceof Refused) return failure(`Nothing sent: ${error.message}`)
        throw error
      }
      const lines: string[] = []
      let stopped = false
      let focused = false
      for (const [i, step] of steps.entries()) {
        const label = labelOf(step)
        try {
          const res = await run(step, window, ctx, focused)
          if ('focus' in step && res?.ok) focused = true
          if (res && !res.ok) {
            lines.push(`${i + 1} failed ${label}: ${res.message || 'no reason given'}`)
            stopped = true
            break
          }
          const note = res?.note ?? (res?.message.includes('send_key_state') ? 'background' : undefined)
          lines.push(`${i + 1} ok ${label}${note ? ` (${note})` : ''}`)
        } catch (error) {
          // Report what already ran, so the agent doesn't send those steps again.
          if (error instanceof Refused) lines.push(`${i + 1} refused ${label}: ${error.message}`)
          else lines.push(`${i + 1} unknown ${label}: the desktop server failed (${error instanceof Error ? error.message : String(error)}); this step may have run. Look before retrying.`)
          stopped = true
          break
        }
      }
      if (stopped && lines.length < steps.length) lines.push(`Stopped; steps ${lines.length + 1}–${steps.length} not run.`)
      const show = then ?? (ctx.session.snapshot?.window === window ? 'tree' : 'none')
      if (show === 'none') return stopped ? failure(lines.join('\n')) : text(lines.join('\n'))
      let after
      try {
        after = show === 'tree' ? await readWindow(window, ctx) : await readScreenshot(window, 1024, undefined, ctx)
      } catch (error) {
        after = failure(`Could not show the result: ${error instanceof Error ? error.message : String(error)}`)
      }
      const content = [{ type: 'text' as const, text: lines.join('\n') }, ...after.content]
      return stopped || after.isError ? { content, isError: true } : { content }
    },
  }),
]
