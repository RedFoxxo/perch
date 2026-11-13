import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { Backend } from '../backend.js'
import type { Window } from '../upstream.js'

/** What perch remembers between calls, so the agent passes short refs instead of ids and scales. */
export interface Session {
  /** The server keeps one tree at a time: element refs belong to this window's last `read_window`. */
  snapshot?: { window: number; id: string }
  /** Per window (or `screen`), how the last screenshot maps image pixels to capture pixels. */
  screenshots: Map<number | 'screen', { scale: number }>
  /** The last `read_windows` answer, for window positions. */
  windows: Map<number, Window>
}

export interface ToolContext {
  backend: Backend
  session: Session
}

export type ToolOutput = CallToolResult

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  /** `read_` tools only look; `act_` tools change something. */
  name: `read_${string}` | `act_${string}`
  description: string
  input: S
  handler: (args: z.output<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>
}

/** Keeps the handler's argument type tied to its schema. */
export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}

export function newSession(): Session {
  return { screenshots: new Map(), windows: new Map() }
}

export function text(body: string, images: { data: string; mimeType: string }[] = []): ToolOutput {
  return { content: [...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })), { type: 'text', text: body }] }
}

export function failure(message: string): ToolOutput {
  return { content: [{ type: 'text', text: message }], isError: true }
}
