import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'
import type { Backend, BackendResult } from './backend.js'
import { fitPng, pngSize } from './png.js'

// Windows runs open-computer-use's Go runtime (UI Automation, Win32 messages, WGC/PrintWindow capture).
// perch calls its `op` command, one short-lived process per operation: open-computer-use's own MCP
// server does the same internally, but answers with trees as text, while `op` returns element records.
// This file answers perch's tools in the shapes computer-use-linux uses, so the tools stay one.

const Frame = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
type Frame = z.infer<typeof Frame>

/** An element as the runtime reports it; sent back unchanged so the runtime can find it again. */
const ElementRecord = z
  .object({
    index: z.number(),
    name: z.string().optional(),
    controlType: z.string().optional(),
    value: z.string().optional(),
    frame: Frame.nullish(),
    actions: z.array(z.string()).optional(),
  })
  .loose()
type ElementRecord = z.infer<typeof ElementRecord>

const OpResponse = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    snapshot: z
      .object({
        windowBounds: Frame.nullish(),
        screenshotPngBase64: z.string().optional(),
        /** The focused element, when it belongs to this window's app: only the app in front has one. */
        focusedSummary: z.string().optional(),
        treeLines: z.array(z.string()).optional(),
        elements: z.array(ElementRecord).optional(),
      })
      .loose()
      .nullish(),
    windows: z.array(z.object({ app: z.string(), id: z.number(), title: z.string().optional() }).loose()).nullish(),
  })
  .loose()
export type OpResponse = z.infer<typeof OpResponse>

/** The fields of open-computer-use's operation request that perch sends. */
export interface OpRequest {
  tool: string
  windowId?: number
  element?: ElementRecord
  windowBounds?: Frame
  x?: number
  y?: number
  from_x?: number
  from_y?: number
  to_x?: number
  to_y?: number
  scrollX?: number
  scrollY?: number
  click_count?: number
  mouse_button?: string
  click_method?: string
  input_method?: string
  allow_foreground_input?: boolean
  env_flags?: Record<string, string>
  action?: string
  direction?: string
  pages?: number
  text?: string
  key?: string
  value?: string
  include_screenshot?: boolean
  max_tree_nodes?: number
}

export interface WindowsRuntime {
  op(request: OpRequest): Promise<OpResponse>
  /** The whole virtual desktop as a PNG. */
  captureScreen(): Promise<Buffer>
}

/** The runtime's own maximum: a tree this long was cut short. */
const MAX_TREE_NODES = 1200
/** Wheel notches per scrolled page; the runtime counts 40 pixels per notch. */
const NOTCHES_PER_PAGE = 5
const FLAG_FOREGROUND = 'OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOREGROUND_INPUT'
const FLAG_FOCUS = 'OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS'
const BACKGROUND_NOTE = 'background: some apps ignore it, check the result'
const RAISED_NOTE = 'the app came to the front'

/**
 * Every request states every gate, so the user's environment can't widen one. Background requests
 * keep the runtime's own refusals: it won't move the real pointer, focus a window, or set a field
 * through UI Automation (which can raise the app).
 */
function gates({ foreground = false, focus = false } = {}): Pick<OpRequest, 'allow_foreground_input' | 'env_flags'> {
  return {
    allow_foreground_input: foreground,
    env_flags: {
      [FLAG_FOREGROUND]: foreground ? '1' : '0',
      [FLAG_FOCUS]: focus ? '1' : '0',
      OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH: '0',
      OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '0',
    },
  }
}

const done = (data: unknown = {}, note?: string): BackendResult => ({ ok: true, data, message: '', images: [], ...(note ? { note } : {}) })
const failed = (message: string): BackendResult => ({ ok: false, data: null, message, images: [] })

/** `ControlType.CheckBox` → `check box`, the words AT-SPI uses for its roles. */
export function roleOf(controlType: string | undefined): string {
  if (!controlType) return 'unknown'
  return controlType
    .replace(/^ControlType\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
}

/**
 * Actions perch can run as an `action` step; values and scrolling have their own steps. Looked up
 * with `Object.hasOwn`: apps name their actions, and `constructor` must not count.
 */
const ACTIONS: Record<string, true> = { Invoke: true, Toggle: true, Select: true, Expand: true, Collapse: true, ScrollIntoView: true }

/**
 * The runtime's records in computer-use-linux's tree shape. Nesting comes from the tree lines
 * (one per record, in the same order, indented with a tab per level); an element whose frame lies
 * wholly outside the window counts as off screen.
 */
export function treeOf(records: ElementRecord[], lines: string[], bounds: Frame | null | undefined) {
  const depths = lines.length === records.length ? lines.map((l) => /^\t*/.exec(l)![0].length) : undefined
  const parents: number[] = []
  return records.map((r, i) => {
    let parent: number | undefined
    if (depths) {
      const depth = depths[i]!
      parents.length = depth
      parent = parents[depth - 1]
      parents[depth] = r.index
    }
    const f = r.frame
    const off = Boolean(f && bounds && (f.x + f.width <= 0 || f.y + f.height <= 0 || f.x >= bounds.width || f.y >= bounds.height))
    const states = ['enabled', ...(off ? [] : ['showing']), ...(r.actions?.includes('SetValue') ? ['editable'] : [])]
    return {
      index: r.index,
      parent_index: parent ?? null,
      role: roleOf(r.controlType),
      name: r.name || null,
      states,
      actions: (r.actions ?? []).filter((a) => Object.hasOwn(ACTIONS, a)),
      value: r.value ? { text: r.value } : null,
    }
  })
}

function opFailure(res: OpResponse, fallback: string): BackendResult {
  return failed(res.error || fallback)
}

/** Windows desktop control over open-computer-use; `runtime` is replaced in tests. */
export function windowsBackend(runtime: WindowsRuntime = openComputerUse()): Backend {
  let snapshot: { id: string; window: number; records: Map<number, ElementRecord> } | undefined
  let snapshots = 0
  /** Per window, its bounds when the last screenshot was taken: [x, y] points are relative to them. */
  const shots = new Map<number, Frame>()
  /** Per window, whether its app had the keyboard focus, so was in front, at the last answer about it. */
  const inFront = new Map<number, boolean>()

  const op = async (request: OpRequest): Promise<OpResponse> => {
    const res = await runtime.op(request)
    if (request.windowId !== undefined && res.ok && res.snapshot) inFront.set(request.windowId, Boolean(res.snapshot.focusedSummary))
    return res
  }

  const record = (args: Record<string, unknown>): ElementRecord | BackendResult => {
    const r = snapshot?.id === args.snapshot_id ? snapshot?.records.get(args.element_index as number) : undefined
    return r ?? failed(`e${String(args.element_index)} is not in the last read of this window; read_window again.`)
  }

  /**
   * The window's bounds now, for pointer input at screenshot points: refused when the window
   * changed size since the screenshot, since the points would land elsewhere in it.
   */
  const boundsForPoints = async (window: number): Promise<Frame | BackendResult> => {
    const shot = shots.get(window)
    if (!shot) return failed(`read_screenshot window ${window} first.`)
    const res = await op({ tool: 'get_window_state', windowId: window, include_screenshot: false, max_tree_nodes: 1, ...gates() })
    const now = res.ok ? res.snapshot?.windowBounds : undefined
    if (!now) return opFailure(res, `could not find window ${window}'s position.`)
    if (Math.abs(now.width - shot.width) > 1 || Math.abs(now.height - shot.height) > 1) {
      return failed(`window ${window} changed size since its screenshot: take a new read_screenshot.`)
    }
    return now
  }

  /**
   * Runs one action. Some background routes still bring the window forward (UI Automation clicks
   * on classic Win32 and WinForms controls do), so a background step whose app was behind and now
   * has the focus says so.
   */
  const act = async (request: OpRequest, note?: string): Promise<BackendResult> => {
    const window = request.windowId
    const before = window === undefined ? undefined : inFront.get(window)
    const res = await op(request)
    if (!res.ok) return opFailure(res, `${request.tool} failed.`)
    if (window === undefined) return done({}, note)
    if (request.allow_foreground_input || request.tool === 'activate_window') {
      // Meant to come forward, which sends every other window behind; activate_window answers
      // without a snapshot, so this one's state is unknown until the next answer about it.
      for (const other of inFront.keys()) inFront.set(other, false)
      inFront.delete(window)
      return done({}, note)
    }
    const raised = before === false && inFront.get(window) === true
    return done({}, [note, raised ? RAISED_NOTE : undefined].filter(Boolean).join('; ') || undefined)
  }

  const isResult = (v: unknown): v is BackendResult => typeof v === 'object' && v !== null && 'ok' in v && 'images' in v

  async function screenshot(args: Record<string, unknown>): Promise<BackendResult> {
    const maxEdge = (args.max_width as number | undefined) ?? 1024
    const file = args.screenshot_file_path as string | undefined
    if (file !== undefined && (!isAbsolute(file) || extname(file).toLowerCase() !== '.png')) {
      return failed(`file must be a new absolute path ending in .png, not ${file}.`)
    }
    let png: Buffer
    let unitWidth: number
    const window = args.window_id as number | undefined
    if (window === undefined) {
      png = await runtime.captureScreen()
      unitWidth = pngSize(png).width
    } else {
      const res = await op({ tool: 'get_window_state', windowId: window, include_screenshot: true, max_tree_nodes: 1, ...gates() })
      if (!res.ok) return opFailure(res, `could not capture window ${window}.`)
      const bounds = res.snapshot?.windowBounds
      const data = res.snapshot?.screenshotPngBase64
      if (!bounds || !data) return failed(`window ${window} could not be captured (minimized, or the capture failed).`)
      png = Buffer.from(data, 'base64')
      unitWidth = bounds.width
      shots.set(window, bounds)
    }
    const fit = fitPng(png, maxEdge)
    // Image pixels per window (or screen) unit: act_window divides points by it.
    const meta = { width: fit.width, height: fit.height, scale: fit.width / unitWidth }
    if (file) {
      // As computer-use-linux does: a new file only, so a screenshot never replaces one.
      try {
        writeFileSync(file, fit.png, { flag: 'wx' })
      } catch (error) {
        return failed(`could not save ${file}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return done({ ...meta, file_path: file })
    }
    return { ...done(meta), images: [{ data: fit.png.toString('base64'), mimeType: 'image/png' }] }
  }

  async function call(tool: string, args: Record<string, unknown>): Promise<BackendResult> {
    const window = args.window_id as number
    switch (tool) {
      case 'list_windows': {
        const res = await runtime.op({ tool: 'list_windows', ...gates() })
        if (!res.ok) return opFailure(res, 'could not list windows.')
        return done({ windows: (res.windows ?? []).map((w) => ({ window_id: w.id, app_id: w.app, title: w.title ?? '' })) })
      }
      case 'get_app_state': {
        const res = await op({ tool: 'get_window_state', windowId: window, include_screenshot: false, ...gates() })
        if (!res.ok || !res.snapshot) return opFailure(res, `could not read window ${window}.`)
        const records = res.snapshot.elements ?? []
        snapshot = { id: `w${++snapshots}`, window, records: new Map(records.map((r) => [r.index, r])) }
        return done({
          snapshot_id: snapshot.id,
          accessibility_tree: treeOf(records, res.snapshot.treeLines ?? [], res.snapshot.windowBounds),
          accessibility_tree_truncated: records.length >= MAX_TREE_NODES,
        })
      }
      case 'screenshot':
        return screenshot(args)
      case 'doctor': {
        const res = await runtime.op({ tool: 'list_windows', ...gates() }).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        const works = res.ok
        return done({
          readiness: {
            can_build_accessibility_tree: works,
            can_send_development_input: works,
            can_query_windows: works,
            blockers: works ? [] : [`open-computer-use could not list windows: ${res.error ?? 'no reason given'}`],
          },
          notes: [
            'Windows: apps running as administrator can be read but not clicked or typed into unless perch runs as administrator too.',
            'Terminals, PowerShell, password managers and Windows Security are refused by open-computer-use.',
          ],
          setup_hint: 'Run perch in the signed-in desktop session (not over SSH or as a service).',
        })
      }
      case 'activate_window':
        return act({ tool: 'activate_window', windowId: window, ...gates({ focus: true }) })
      case 'perform_action': {
        const r = record(args)
        if (isResult(r)) return r
        const name = (args.action as string | undefined) ?? r.actions?.find((a) => Object.hasOwn(ACTIONS, a))
        if (!name) return failed(`e${r.index} has no actions.`)
        return act({ tool: 'perform_secondary_action', windowId: window, element: r, action: name.toLowerCase(), ...gates() })
      }
      case 'set_value': {
        const r = record(args)
        if (isResult(r)) return r
        return act({ tool: 'set_value', windowId: window, element: r, value: args.value as string, ...gates() })
      }
      case 'type_text':
      case 'press_key': {
        const field = tool === 'type_text' ? { text: args.text as string } : { key: args.key as string }
        // Focused input: the runtime brings this window forward itself right before SendInput.
        if (args.focused) return act({ tool, windowId: window, ...field, input_method: 'global', ...gates({ foreground: true }) })
        return act({ tool, windowId: window, ...field, input_method: 'auto', ...gates() }, BACKGROUND_NOTE)
      }
      case 'click': {
        const pointer = { mouse_button: (args.button as string | undefined) ?? 'left', click_count: (args.click_count as number | undefined) ?? 1 }
        if (args.element_index !== undefined) {
          const r = record(args)
          if (isResult(r)) return r
          return act({ tool: 'click', windowId: window, element: r, ...pointer, click_method: 'global', ...gates({ foreground: true }) })
        }
        const bounds = await boundsForPoints(window)
        if (isResult(bounds)) return bounds
        return act({ tool: 'click', windowId: window, windowBounds: bounds, x: args.x as number, y: args.y as number, ...pointer, click_method: 'global', ...gates({ foreground: true }) })
      }
      case 'scroll': {
        const pages = (args.pages as number | undefined) ?? 1
        const direction = args.direction as string
        if (args.element_index !== undefined) {
          const r = record(args)
          if (isResult(r)) return r
          // The element's scroll pattern, or wheel messages posted to it: no pointer, no focus.
          return act({ tool: 'scroll', windowId: window, element: r, direction, pages, input_method: 'auto', ...gates() })
        }
        const bounds = await boundsForPoints(window)
        if (isResult(bounds)) return bounds
        const delta = pages * NOTCHES_PER_PAGE * 40
        const scrollX = direction === 'left' ? -delta : direction === 'right' ? delta : 0
        const scrollY = direction === 'up' ? -delta : direction === 'down' ? delta : 0
        return act({ tool: 'scroll', windowId: window, windowBounds: bounds, x: args.x as number, y: args.y as number, scrollX, scrollY, input_method: 'global', ...gates({ foreground: true }) })
      }
      case 'drag': {
        const bounds = await boundsForPoints(window)
        if (isResult(bounds)) return bounds
        return act({
          tool: 'drag',
          windowId: window,
          windowBounds: bounds,
          from_x: args.start_x as number,
          from_y: args.start_y as number,
          to_x: args.end_x as number,
          to_y: args.end_y as number,
          input_method: 'global',
          ...gates({ foreground: true }),
        })
      }
      default:
        return failed(`perch: ${tool} is not available on Windows.`)
    }
  }

  return { call, focusedInputByWindow: true, dragInWindow: true }
}

/** The runtime's executable inside the npm package perch depends on. */
export function openComputerUseExe(): string {
  const pkg = createRequire(import.meta.url).resolve('@opensymph/open-computer-use/package.json')
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  return join(dirname(pkg), 'dist', 'windows', arch, 'open-computer-use.exe')
}

/** Reads that crashed are retried, as open-computer-use does: a window still settling can kill the worker. */
const RETRIED: Record<string, true> = { list_windows: true, get_window_state: true }

/** The runtime as separate processes; `findExe` is replaced in tests. */
export function openComputerUse(findExe: () => string = openComputerUseExe): WindowsRuntime {
  let exe: string | undefined
  const run = (args: string[], input?: string): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>()
    try {
      exe ??= findExe()
    } catch {
      reject(new Error('open-computer-use is not installed: reinstall perch (npm skipped an optional dependency).'))
      return promise
    }
    // Without a DPI manifest the runtime would see scaled coordinates on scaled displays, while
    // UI Automation reports real ones; system DPI awareness keeps both in pixels.
    const env = { ...process.env, __COMPAT_LAYER: process.env.__COMPAT_LAYER ?? 'HighDpiAware' }
    const child = spawn(exe, args, { env, windowsHide: true, timeout: 90_000 })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout)
      else reject(new Error(`open-computer-use ${args[0]} exited with ${code}: ${(stderr || stdout).trim().slice(0, 300)}`))
    })
    // A runtime that exits before reading its request breaks the pipe; `close` reports it instead.
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
    return promise
  }

  return {
    async op(request) {
      const attempts = RETRIED[request.tool] ? 3 : 1
      for (let attempt = 1; ; attempt++) {
        try {
          const out = await run(['op'], JSON.stringify(request))
          return OpResponse.parse(JSON.parse(out.trim().split('\n').at(-1)!))
        } catch (error) {
          if (attempt >= attempts) throw error
          await sleep(600)
        }
      }
    },
    async captureScreen() {
      return Buffer.from((await run(['screenshot'])).trim(), 'base64')
    },
  }
}
