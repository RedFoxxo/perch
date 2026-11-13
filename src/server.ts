import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { actTools } from './tools/act.js'
import { readTools } from './tools/read.js'
import type { ToolContext, ToolDef } from './tools/types.js'
import { VERSION } from './version.js'

// Each tool keeps its own argument type; the registry only needs the common shape.
export const allTools = [...readTools, ...actTools] as unknown as ToolDef[]

export function createServer(ctx: ToolContext, tools: ToolDef[] = allTools): McpServer {
  const server = new McpServer({ name: 'perch', version: VERSION })
  for (const tool of tools) {
    const reads = tool.name.startsWith('read_')
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: reads, destructiveHint: !reads, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => tool.handler(args, ctx),
    )
  }
  return server
}
