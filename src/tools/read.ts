import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { formatTree } from '../format/tree.js'
import { AppState, Doctor, ScreenshotMeta, TreeNode, WindowList, type Window } from '../upstream.js'
import { defineTool, failure, text, type ToolContext, type ToolOutput } from './types.js'

const windowId = z.number().int().describe('Window id from read_windows')

/** The window list, or why it can't be had: the server answers a failed listing with no windows and an `error`. */
export async function listWindows(ctx: ToolContext): Promise<{ windows: Window[] } | { error: string }> {
  const res = await ctx.backend.call('list_windows', {})
  if (!res.ok) return { error: res.message || 'could not list windows.' }
  const list = WindowList.parse(res.data)
  if (list.error) return { error: [list.error, list.permissions_hint].filter(Boolean).join(' ') }
  return { windows: list.windows }
}

/** Reads one window's tree, remembers its snapshot, and returns it as compact text. */
export async function readWindow(window: number, ctx: ToolContext): Promise<ToolOutput> {
  const res = await ctx.backend.call('get_app_state', { window_id: window, include_screenshot: false })
  if (!res.ok) return failure(res.message || 'Could not read the window.')
  const state = AppState.parse(res.data)
  // Refs from an earlier read stay valid only until this one replaced the server's tree.
  ctx.session.snapshot = undefined
  const problem = state.window_error ?? state.accessibility_error
  if (problem) return failure(`Could not read window ${window}: ${problem}`)
  // Large trees come back in a file; read it now, the server replaces it on the next read.
  const nodes = state.accessibility_tree_spill
    ? z.array(TreeNode).parse(JSON.parse(readFileSync(state.accessibility_tree_spill.path, 'utf8')))
    : (state.accessibility_tree ?? [])
  if (state.snapshot_id) {
    const actions = new Map(nodes.flatMap((n) => (n.actions?.length ? [[n.index, n.actions] as const] : [])))
    ctx.session.snapshot = { window, id: state.snapshot_id, actions }
  }
  const tree = formatTree(nodes)
  if (!tree) {
    return text(
      `Window ${window} shows no buttons or fields to accessibility (old toolkit, Wine, canvas, or accessibility off). ` +
        'Use read_screenshot, then act_window click [x, y].',
    )
  }
  return text(state.accessibility_tree_truncated ? `${tree}\n(the tree was cut short: the window has more elements)` : tree)
}

/** Takes a screenshot of a window (or the whole screen) and remembers its scale for clicks. */
export async function readScreenshot(window: number | undefined, maxEdge: number, file: string | undefined, ctx: ToolContext): Promise<ToolOutput> {
  const res = await ctx.backend.call('screenshot', {
    ...(window === undefined ? { full_screen: true } : { window_id: window }),
    max_width: maxEdge,
    max_height: maxEdge,
    ...(file ? { screenshot_file_path: file } : {}),
  })
  if (!res.ok) return failure(res.message || 'Could not take the screenshot.')
  const meta = ScreenshotMeta.parse(res.data)
  ctx.session.screenshots.set(window ?? 'screen', { scale: meta.scale })
  const size = `${meta.width}×${meta.height} px`
  const how = window === undefined ? '' : ' act_window click [x, y] takes pixels of this image.'
  return text(meta.file_path ? `Saved ${meta.file_path} (${size}).${how}` : `${size}.${how}`, res.images)
}

export const readTools = [
  defineTool({
    name: 'read_windows',
    description: 'Open windows, one per line: id, app, title, focused, workspace.',
    input: {},
    async handler(_args, ctx) {
      const list = await listWindows(ctx)
      if ('error' in list) return failure(`Could not list windows: ${list.error}`)
      const { windows } = list
      ctx.session.windows = new Map(windows.map((w) => [w.window_id, w]))
      if (!windows.length) return text('No windows.')
      return text(
        windows
          .map((w) => {
            const flags = [w.focused ? 'focused' : '', w.hidden ? 'hidden' : '', w.workspace != null ? `workspace ${w.workspace}` : ''].filter(Boolean)
            return `${w.window_id} ${w.app_id ?? '?'} ${JSON.stringify(w.title ?? '')}${flags.length ? ` ${flags.join(' ')}` : ''}`
          })
          .join('\n'),
      )
    },
  }),

  defineTool({
    name: 'read_window',
    description:
      'A window\'s buttons, fields and text as compact lines, e.g. [e34 button "Save" disabled]. ' +
      'Act on them with act_window using the e-refs; a new read_window (of any window) replaces them.',
    input: { window: windowId },
    handler: ({ window }, ctx) => readWindow(window, ctx),
  }),

  defineTool({
    name: 'read_screenshot',
    raises: true,
    description:
      'Picture of one window (or the whole screen without window), longest side max_edge px. A window is captured in the background ' +
      'on Hyprland and Windows; elsewhere it comes to the front. Costs image tokens: prefer read_window. With file, saves a PNG there instead.',
    input: {
      window: windowId.optional(),
      max_edge: z.number().int().min(200).max(1920).default(1024),
      file: z.string().optional().describe('New absolute path ending in .png'),
    },
    handler: ({ window, max_edge, file }, ctx) => readScreenshot(window, max_edge, file, ctx),
  }),

  defineTool({
    name: 'read_status',
    description: 'Whether desktop control works here: accessibility, input, windows, and what blocks it.',
    input: {},
    async handler(_args, ctx) {
      const res = await ctx.backend.call('doctor', {})
      if (!res.ok) return failure(res.message || 'Could not check the desktop.')
      const { readiness: r, notes, setup_hint } = Doctor.parse(res.data)
      const mark = (ok: boolean) => (ok ? '✔' : '✘')
      const lines = [
        `${mark(r.can_build_accessibility_tree)} buttons and fields (accessibility)`,
        `${mark(r.can_send_development_input)} mouse and keyboard`,
        `${mark(r.can_query_windows)} window list`,
        ...r.blockers.map((b) => `blocked: ${b}`),
        ...(notes ?? []),
      ]
      if (r.blockers.length) {
        lines.push(`Setup: ${setup_hint ?? 'https://github.com/agent-sh/computer-use-linux#quick-start (GNOME: npx -y @redfoxxo/perch@1 setup-window-targeting).'}`)
      }
      return text(lines.join('\n'))
    },
  }),
]
