#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { computerUseLinuxCli, linuxBackend, unsupportedBackend } from './backend.js'
import { createServer } from './server.js'
import { newSession } from './tools/types.js'

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
  const r = spawnSync(process.execPath, [computerUseLinuxCli(), command], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
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
  const backend = process.platform === 'linux' ? linuxBackend(() => clientName) : unsupportedBackend(process.platform)
  const server = createServer({ backend, session: newSession() })
  server.server.oninitialized = () => {
    clientName = server.server.getClientVersion()?.name
  }
  await server.connect(new StdioServerTransport())
  process.stderr.write('perch: ready on stdio\n')
}

main().catch((error: unknown) => {
  process.stderr.write(`perch: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
