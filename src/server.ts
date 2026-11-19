import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { actTools } from './tools/act.js'
import { readTools } from './tools/read.js'
import type { ToolContext, ToolDef } from './tools/types.js'
import { VERSION } from './version.js'

// Each tool keeps its own argument type; the registry only needs the common shape.
export const allTools = [...readTools, ...actTools] as unknown as ToolDef[]

export function createServer(ctx: ToolContext, tools: ToolDef[] = allTools): McpServer {
  const server = new McpServer({ name: 'perch', version: VERSION })
  const listed: Tool[] = tools.map((tool) => {
    const reads = tool.name.startsWith('read_')
    // A window screenshot raises the window outside Hyprland's background mode, so it changes what the user sees.
    const readOnly = reads && !tool.raises
    const annotations = { readOnlyHint: readOnly, destructiveHint: !reads, openWorldHint: true }
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input, annotations }, async (args: Record<string, unknown>) =>
      tool.handler(args, ctx),
    )
    // The SDK's list adds a `$schema` line to every input schema and `execution: { taskSupport: "forbidden" }`
    // (the default) to every tool: tokens in every session that tell the model nothing.
    const { $schema: _, ...inputSchema } = z.toJSONSchema(z.object(tool.input), { io: 'input', target: 'draft-7' })
    return { name: tool.name, description: tool.description, inputSchema: inputSchema as Tool['inputSchema'], annotations }
  })
  // Replaces the SDK's tools/list handler; calls still go through its validation.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }))
  return server
}
