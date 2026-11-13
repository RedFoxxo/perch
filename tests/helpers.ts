import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend, BackendResult } from '../src/backend.js'
import { newSession, type ToolContext } from '../src/tools/types.js'

export const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))

export const ok = (data: unknown, images: BackendResult['images'] = []): BackendResult => ({ ok: true, data, message: '', images })

/** The window most tests act in; the fake lists it unless a test answers list_windows itself. */
export const W = 7

/**
 * A backend that answers from `answers` per tool and records every call except
 * the window check act_window makes first (`list_windows`).
 */
export function fakeBackend(answers: Record<string, (args: Record<string, unknown>) => BackendResult>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  const all: Record<string, (args: Record<string, unknown>) => BackendResult> = {
    list_windows: () => ok({ windows: [{ window_id: W, app_id: 'app', pid: 1 }] }),
    ...answers,
  }
  const backend: Backend = {
    async call(tool, args) {
      if (tool !== 'list_windows') calls.push({ tool, args })
      const answer = all[tool]
      if (!answer) throw new Error(`unexpected call to ${tool}`)
      return answer(args)
    },
  }
  return { backend, calls }
}

export function context(backend: Backend): ToolContext {
  return { backend, session: newSession() }
}
