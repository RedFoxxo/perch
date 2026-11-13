import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { parseResult } from '../src/backend.js'
import { createServer } from '../src/server.js'
import { VERSION } from '../src/version.js'
import { context, fakeBackend } from './helpers.js'

async function listTools() {
  const server = createServer(context(fakeBackend({}).backend))
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { tools: (await client.listTools()).tools, instructions: client.getInstructions() }
}

describe('server', () => {
  it('lists five tools; only those that never change the screen are read-only', async () => {
    const { tools } = await listTools()
    expect(tools.map((t) => t.name)).toEqual(['read_windows', 'read_window', 'read_screenshot', 'read_status', 'act_window'])
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)
    // A window screenshot raises the window outside Hyprland's background mode.
    expect(readOnly).toEqual(['read_windows', 'read_window', 'read_status'])
  })

  it('rejects a step that mixes kinds before anything is sent', async () => {
    const { backend, calls } = fakeBackend({})
    const server = createServer(context(backend))
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' })
    await Promise.all([server.connect(a), client.connect(b)])
    const r = await client.callTool({ name: 'act_window', arguments: { window: 7, steps: [{ type: 'x', click: 'e1' }] } })
    expect(r.isError).toBe(true)
    expect(calls).toEqual([])
  })

  // computer-use-linux lists 19 tools in 67.8 KB plus 7.6 KB of instructions; perch exists to cost a fraction of that.
  it('keeps the tool list small and sends no server instructions', async () => {
    const { tools, instructions } = await listTools()
    expect(JSON.stringify(tools).length).toBeLessThan(8_000)
    expect(instructions).toBeUndefined()
  })

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})

describe('parseResult', () => {
  it('treats ok: false in the answer as a failure and keeps the whole message, recovery hint included', () => {
    const r = parseResult({ content: [{ type: 'text', text: JSON.stringify({ ok: false, message: 'click was not sent: stale. Call get_app_state.' }) }] })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('click was not sent: stale. Call get_app_state.')
  })

  it('treats isError as a failure even without JSON, and passes images on', () => {
    const r = parseResult({ isError: true, content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }, { type: 'text', text: 'boom' }] })
    expect(r).toMatchObject({ ok: false, message: 'boom', images: [{ data: 'AAA', mimeType: 'image/png' }] })
  })
})
