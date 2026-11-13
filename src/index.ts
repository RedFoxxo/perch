#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { computerUseLinuxCli, linuxBackend, unsupportedBackend } from './backend.js'
import { createServer } from './server.js'
import { newSession } from './tools/types.js'
import { windowsBackend } from './windows.js'

/**
 * Desktop setup that needs computer-use-linux's own CLI, run with the version perch bundles,
 * so setup tools never pin a second copy: `perch setup-window-targeting` (GNOME's Shell extension).
 */
const SETUP_COMMANDS: Record<string, true> = { 'setup-window-targeting': true }

function runSetup(command: string): never {
  if (process.platform !== 'linux') {
    process.stderr.write(`perch: ${command} is for Linux desktops.\n`)
    process.exit(1)
  }
  const r = spawnSync(process.execPath, [computerUseLinuxCli(), command], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' })
  // computer-use-linux prints a JSON report and exits 0 even when the setup failed; its
  // enable_command says whether the extension got enabled.
  const report = SetupReport.safeParse(parseJson(r.stdout ?? ''))
  if (!report.success) {
    process.stdout.write(r.stdout ?? '')
    process.exit(r.status ?? 1)
  }
  process.stdout.write(`${report.data.message}\n`)
  process.exit(report.data.enable_command.ok ? 0 : 1)
}

const SetupReport = z.object({ message: z.string(), enable_command: z.object({ ok: z.boolean() }).loose() }).loose()

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== undefined) {
    if (SETUP_COMMANDS[command]) runSetup(command)
    process.stderr.write(`perch: unknown command ${command}. Without arguments perch is an MCP server on stdio; setup: ${Object.keys(SETUP_COMMANDS).join(', ')}.\n`)
    process.exit(1)
  }
  let clientName: string | undefined
  // The desktop server starts on the first tool call, and shows the client's name on screen.
  const backend =
    process.platform === 'linux'
      ? linuxBackend(() => clientName)
      : process.platform === 'win32'
        ? windowsBackend()
        : unsupportedBackend(process.platform)
  const server = createServer({ backend, session: newSession() })
  server.server.oninitialized = () => {
    clientName = server.server.getClientVersion()?.name
  }
  await server.connect(new StdioServerTransport())
  // The stdio transport doesn't end when the client closes stdin; without this, perch and its
  // desktop server would keep running until the client kills them.
  process.stdin.on('end', () => process.exit(0))
  process.stderr.write('perch: ready on stdio\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`perch: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
