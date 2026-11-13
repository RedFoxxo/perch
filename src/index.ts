#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { linuxBackend, unsupportedBackend } from './backend.js'
import { createServer } from './server.js'
import { newSession } from './tools/types.js'

async function main(): Promise<void> {
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
