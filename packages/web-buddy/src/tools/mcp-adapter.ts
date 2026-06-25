import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { browserClick } from '../browser/click.js'
import { browserClickText } from '../browser/click-text.js'
import { browserFillByLabel } from '../browser/fill-by-label.js'
import { browserFormSnapshot } from '../browser/form-snapshot.js'
import { browserOpen } from '../browser/open.js'
import { browserScreenshot } from '../browser/screenshot.js'
import { browserSelect } from '../browser/select.js'
import { browserSelectByText } from '../browser/select-by-text.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserUploadFile } from '../browser/upload-file.js'
import { browserWait } from '../browser/wait.js'
import { getOrCreateProcessTrace } from '../agent-trace/index.js'
import { formatToolResult } from '../errors.js'
import { getToolDef, listMcpToolDefs } from './catalog.js'

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  browser_open: (args) => browserOpen(args as Parameters<typeof browserOpen>[0]),
  browser_snapshot: (args) => browserSnapshot(args as Parameters<typeof browserSnapshot>[0]),
  browser_click: (args) => browserClick(args as Parameters<typeof browserClick>[0]),
  browser_click_text: (args) => browserClickText(args as Parameters<typeof browserClickText>[0]),
  browser_form_snapshot: (args) => browserFormSnapshot(args as Parameters<typeof browserFormSnapshot>[0]),
  browser_upload_file: (args) => browserUploadFile(args as Parameters<typeof browserUploadFile>[0]),
  browser_fill_by_label: (args) => browserFillByLabel(args as Parameters<typeof browserFillByLabel>[0]),
  browser_select_by_text: (args) => browserSelectByText(args as Parameters<typeof browserSelectByText>[0]),
  browser_type: (args) => browserType(args as Parameters<typeof browserType>[0]),
  browser_select: (args) => browserSelect(args as Parameters<typeof browserSelect>[0]),
  browser_wait: (args) => browserWait(args as Parameters<typeof browserWait>[0]),
  browser_screenshot: (args) => browserScreenshot(args as Parameters<typeof browserScreenshot>[0]),
}

export const TOOL_DEFINITIONS: Tool[] = listMcpToolDefs().map((tool) => ({
  name: tool.mcpName ?? tool.name,
  description: tool.description,
  inputSchema: tool.parameters as Tool['inputSchema'],
}))

export async function callBrowserTool(name: string, args: Record<string, unknown>) {
  const def = getToolDef(name)
  const category = def?.category
  const trace = getOrCreateProcessTrace('mcp-server')
  const span = trace?.startSpan({
    spanType: 'mcp_tool_call',
    name,
    toolName: name,
    toolCategory: category,
    input: args,
    metadata: {
      sessionId: args.sessionId,
      category,
    },
  })
  const handler = handlers[name]
  if (!handler) {
    const text = formatToolResult({
      ok: false,
      observation: `Unknown tool: ${name}`,
      error: {
        code: 'UNKNOWN',
        message: `Unknown tool: ${name}`,
        recoverable: false,
      },
    })
    span?.end({
      status: 'failed',
      output: text,
      errorCode: 'UNKNOWN',
      errorMessage: `Unknown tool: ${name}`,
    })
    return text
  }

  try {
    const result = await handler(args)
    const text = formatToolResult(result as Parameters<typeof formatToolResult>[0])
    span?.end({
      status: (result as { ok?: boolean }).ok === false ? 'failed' : 'success',
      output: {
        result,
        text,
      },
    })
    return text
  } catch (error) {
    span?.end({
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
