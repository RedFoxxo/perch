import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Outcome } from './upstream.js'
import { VERSION } from './version.js'

/** What perch needs from the server that does the real work. */
export interface Backend {
  call(tool: string, args: Record<string, unknown>): Promise<BackendResult>
}

export interface BackendResult {
  /** False when the server flagged an error or its JSON answer says `ok: false`. */
  ok: boolean
  /** The parsed JSON of the first text block, or its raw text when it is not JSON; parse it before use. */
  data: unknown
  /** The server's whole `message` (or its text): failures need its recovery hint, which often comes last. */
  message: string
  images: { data: string; mimeType: string }[]
}

interface Content {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

/** Turns an MCP tool answer into a `BackendResult`. */
export function parseResult(result: { content?: Content[]; isError?: boolean }): BackendResult {
  const content = result.content ?? []
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    // Not JSON: keep the text.
  }
  const outcome = Outcome.safeParse(data)
  const message = outcome.success ? outcome.data.message : undefined
  return {
    ok: !result.isError && !(outcome.success && outcome.data.ok === false),
    data,
    message: (message ?? (typeof data === 'string' ? data : '')).trim(),
    images: content.flatMap((c) => (c.type === 'image' && c.data ? [{ data: c.data, mimeType: c.mimeType ?? 'image/png' }] : [])),
  }
}

/** The npm wrapper of the computer-use-linux perch depends on; it downloads the binary if npm skipped the install script. */
export function computerUseLinuxCli(): string {
  const pkg = createRequire(import.meta.url).resolve('@agent-sh/computer-use-linux/package.json')
  return join(dirname(pkg), 'npm', 'bin', 'computer-use-linux.js')
}

/** computer-use-linux as an MCP server, started on first use and restarted if it exits. */
export function linuxBackend(agentName: () => string | undefined): Backend {
  let client: Promise<Client> | undefined

  const start = async (): Promise<Client> => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    // Background keys and window captures on Hyprland: on unless the user set 0.
    if (!env.COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND) env.COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND = '1'
    const name = agentName()
    if (name && !env.COMPUTER_USE_LINUX_AGENT_NAME) env.COMPUTER_USE_LINUX_AGENT_NAME = name
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [computerUseLinuxCli(), 'mcp'],
      env,
      stderr: 'ignore',
    })
    const c = new Client({ name: 'perch', version: VERSION })
    transport.onclose = () => {
      client = undefined
    }
    await c.connect(transport)
    return c
  }

  return {
    async call(tool, args) {
      client ??= start().catch((error: unknown) => {
        client = undefined
        throw error
      })
      const c = await client
      const result = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })
      // The SDK types tool content as a wide union; perch reads only these fields.
      return parseResult(result as unknown as { content?: Content[]; isError?: boolean })
    },
  }
}

/** For platforms perch has no backend for yet. */
export function unsupportedBackend(platform: string): Backend {
  return {
    async call() {
      return { ok: false, data: null, message: `perch: desktop control on ${platform} is not available yet.`, images: [] }
    },
  }
}
