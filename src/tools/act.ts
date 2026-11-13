import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { BackendResult } from '../backend.js'
import { WindowList } from '../upstream.js'
import { readScreenshot, readWindow } from './read.js'
import { defineTool, failure, text, type ToolContext } from './types.js'

const Ref = z.string().regex(/^e\d+$/).describe('Element ref from read_window, e.g. e34')
const Point = z.tuple([z.number(), z.number()]).describe('[x, y] in pixels of the last read_screenshot of this window')
const Target = z.union([Ref, Point])

const Step = z.union([
  z.strictObject({
    click: Target,
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional().describe('2 for a double click'),
  }),
  z.strictObject({
    type: z.string().describe('Literal text'),
    focused: z.boolean().optional().describe('Type into the focused window, after a focus step (any layout and characters)'),
  }),
  z.strictObject({
    key: z.string().describe('Key or chord, e.g. Return, ctrl+s, alt+F4'),
    focused: z.boolean().optional(),
  }),
  z.strictObject({ set: Ref, value: z.string().describe('Fills a field or slider directly') }),
  z.strictObject({ action: Ref, name: z.string().optional().describe('Named action; default: its first') }),
  z.strictObject({ scroll: Target, direction: z.enum(['up', 'down', 'left', 'right']), pages: z.number().positive().optional() }),
  z.strictObject({ drag: Point, to: Point }),
  z.strictObject({ focus: z.literal(true).describe('Bring the window to the front') }),
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

/** Converts image pixels of the window's last screenshot to the window-relative capture pixels the server takes. */
function point([x, y]: [number, number], window: number, ctx: ToolContext) {
  const shot = ctx.session.screenshots.get(window)
  if (!shot) throw new Refused(`read_screenshot window ${window} first: [x, y] are pixels of its last screenshot.`)
  return { x: Math.round(x / shot.scale), y: Math.round(y / shot.scale) }
}

function target(t: string | [number, number], window: number, ctx: ToolContext) {
  return typeof t === 'string' ? element(t, window, ctx) : { ...point(t, window, ctx), relative: true }
}

/** Refuses untargeted keys unless the window still has the focus, so they can't land in the user's windows. */
async function ensureFocused(window: number, ctx: ToolContext): Promise<void> {
  const res = await ctx.backend.call('focused_window', {})
  const focused = z.object({ window_id: z.number() }).loose().safeParse(res.data)
  const nested = z.object({ window: z.object({ window_id: z.number() }).loose() }).loose().safeParse(res.data)
  const id = focused.success ? focused.data.window_id : nested.success ? nested.data.window.window_id : undefined
  if (id !== window) throw new Refused(`window ${window} does not have the focus (the user may have moved it); nothing was sent.`)
}

/**
 * Window ids are compositor addresses that come back for new windows once a window closes.
 * Refuses when `window` is gone, or now belongs to another app than when perch last saw it.
 */
async function checkWindow(window: number, ctx: ToolContext): Promise<void> {
  const res = await ctx.backend.call('list_windows', {})
  if (!res.ok) throw new Refused(res.message || 'could not list windows.')
  const known = ctx.session.windows.get(window)
  const windows = new Map(WindowList.parse(res.data).windows.map((w) => [w.window_id, w]))
  const now = windows.get(window)
  // Keep what perch knew about other windows, so their ids stay checked too.
  for (const [id, w] of windows) if (!ctx.session.windows.has(id) || id === window) ctx.session.windows.set(id, w)
  if (!now) throw new Refused(`window ${window} is gone; call read_windows.`)
  if (known && (known.app_id !== now.app_id || known.pid !== now.pid)) {
    ctx.session.windows.set(window, known)
    throw new Refused(`window ${window} was ${known.app_id ?? 'another app'} and is now ${now.app_id ?? 'another app'}: the first one closed and its id was reused. Call read_windows.`)
  }
}

function dragArgs(step: { drag: [number, number]; to: [number, number] }, window: number, ctx: ToolContext) {
  const bounds = ctx.session.windows.get(window)?.bounds
  if (!bounds) throw new Refused(`the position of window ${window} is unknown, so a drag can't be placed.`)
  const from = point(step.drag, window, ctx)
  const to = point(step.to, window, ctx)
  return { start_x: bounds.x + from.x, start_y: bounds.y + from.y, end_x: bounds.x + to.x, end_y: bounds.y + to.y }
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
    // A plain click on an element runs its own action, which neither focuses nor raises the window.
    if (!usesPointer(step) && typeof step.click === 'string') {
      return backend.call('perform_action', { window_id: window, ...element(step.click, window, ctx) })
    }
    return backend.call('click', { window_id: window, ...target(step.click, window, ctx), button: step.button, click_count: step.count })
  }
  if ('type' in step) {
    if (!step.focused) return backend.call('type_text', { window_id: window, text: step.type })
    await ensureFocused(window, ctx)
    return backend.call('type_text', { text: step.type })
  }
  if ('key' in step) {
    if (!step.focused) return backend.call('press_key', { window_id: window, key: step.key })
    await ensureFocused(window, ctx)
    return backend.call('press_key', { key: step.key })
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
      'Run steps in one window, in order, stopping at the first that fails: click, type, key, set, action, scroll, drag, focus, wait. ' +
      'Targets are e-refs from read_window or [x, y] pixels of read_screenshot. Element clicks, keys and typing work without bringing the window ' +
      'to the front (keys on Hyprland; elsewhere keys focus it). Mouse steps ([x, y] clicks, right or double clicks, scroll, drag) need a ' +
      'focus step first, which shows the window to the user. focused: true sends keys to the focused window, refused if the focus moved. ' +
      'then: tree (default after read_window) or screenshot shows the result.',
    input: {
      window: z.number().int().describe('Window id from read_windows'),
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
          lines.push(`${i + 1} ok ${label}${res?.message.includes('send_key_state') ? ' (background)' : ''}`)
        } catch (error) {
          if (!(error instanceof Refused)) throw error
          lines.push(`${i + 1} refused ${label}: ${error.message}`)
          stopped = true
          break
        }
      }
      if (stopped && lines.length < steps.length) lines.push(`Stopped; steps ${lines.length + 1}–${steps.length} not run.`)
      const show = then ?? (ctx.session.snapshot?.window === window ? 'tree' : 'none')
      if (show === 'none') return stopped ? failure(lines.join('\n')) : text(lines.join('\n'))
      const after = show === 'tree' ? await readWindow(window, ctx) : await readScreenshot(window, 1024, undefined, ctx)
      const content = [{ type: 'text' as const, text: lines.join('\n') }, ...after.content]
      return stopped ? { content, isError: true } : { content }
    },
  }),
]
