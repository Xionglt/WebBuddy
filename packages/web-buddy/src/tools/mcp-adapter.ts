import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { browserClick } from '../browser/click.js'
import { browserClickText } from '../browser/click-text.js'
import { browserFillByLabel } from '../browser/fill-by-label.js'
import { browserFormAudit } from '../browser/form-audit.js'
import { browserFormSnapshot } from '../browser/form-snapshot.js'
import { browserInspectOptions } from '../browser/inspect-options.js'
import { browserOpen } from '../browser/open.js'
import { browserPressKey } from '../browser/press-key.js'
import { browserScreenshot } from '../browser/screenshot.js'
import { browserSelect } from '../browser/select.js'
import { browserSelectByText } from '../browser/select-by-text.js'
import { browserSetField } from '../browser/set-field.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserUploadFile } from '../browser/upload-file.js'
import { browserWait } from '../browser/wait.js'
import { getOrCreateProcessTrace } from '../agent-trace/index.js'
import { formatToolResult, toolFailure } from '../errors.js'
import { redactSensitiveData } from '../security/redaction.js'
import { getToolDef, listMcpToolDefs } from './catalog.js'

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  browser_open: (args) => browserOpen(args as Parameters<typeof browserOpen>[0]),
  browser_snapshot: (args) => browserSnapshot(args as Parameters<typeof browserSnapshot>[0]),
  browser_click: (args) => browserClick(args as Parameters<typeof browserClick>[0]),
  browser_click_text: (args) => browserClickText(args as Parameters<typeof browserClickText>[0]),
  browser_form_snapshot: (args) => browserFormSnapshot(args as Parameters<typeof browserFormSnapshot>[0]),
  browser_form_audit: (args) => browserFormAudit(args as Parameters<typeof browserFormAudit>[0]),
  browser_inspect_options: (args) => browserInspectOptions(args as Parameters<typeof browserInspectOptions>[0]),
  browser_upload_file: (args) => browserUploadFile(args as Parameters<typeof browserUploadFile>[0]),
  browser_fill_by_label: (args) => browserFillByLabel(args as Parameters<typeof browserFillByLabel>[0]),
  browser_select_by_text: (args) => browserSelectByText(args as Parameters<typeof browserSelectByText>[0]),
  browser_set_field: (args) => browserSetField(args as Parameters<typeof browserSetField>[0]),
  browser_type: (args) => browserType(args as Parameters<typeof browserType>[0]),
  browser_press_key: (args) => browserPressKey(args as Parameters<typeof browserPressKey>[0]),
  browser_select: (args) => browserSelect(args as Parameters<typeof browserSelect>[0]),
  browser_wait: (args) => browserWait(args as Parameters<typeof browserWait>[0]),
  browser_screenshot: (args) => browserScreenshot(args as Parameters<typeof browserScreenshot>[0]),
}

const MCP_OBSERVATION_TOOLS = new Set([
  'browser_snapshot',
  'browser_form_snapshot',
  'browser_form_audit',
  'browser_inspect_options',
  'browser_wait',
  'browser_screenshot',
])

export const TOOL_DEFINITIONS: Tool[] = listMcpToolDefs()
  .filter((tool) => MCP_OBSERVATION_TOOLS.has(tool.mcpName ?? tool.name))
  .map((tool) => ({
    name: tool.mcpName ?? tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Tool['inputSchema'],
  }))

export async function callBrowserTool(name: string, args: Record<string, unknown>) {
  const def = getToolDef(name)
  const category = def?.category
  const handler = handlers[name]
  if (!handler) {
    return formatToolResult(toolFailure('UNKNOWN', `Unknown tool: ${name}`, { recoverable: false }))
  }
  if (!MCP_OBSERVATION_TOOLS.has(name)) {
    return formatToolResult(toolFailure(
      'NAVIGATION_BLOCKED',
      `MCP_POLICY_DENIED: ${name} requires a trusted host-issued task/policy/approval envelope; the default MCP compatibility surface is observation-only.`,
      { recoverable: false },
    ))
  }

  const safeArgs = redactSensitiveData(args).value as Record<string, unknown>
  const trace = getOrCreateProcessTrace('mcp-server')
  const span = trace?.startSpan({
    spanType: 'mcp_tool_call',
    name,
    toolName: name,
    toolCategory: category,
    input: safeArgs,
    metadata: {
      sessionId: safeArgs.sessionId,
      category,
    },
  })

  try {
    const result = await handler(args)
    const text = formatToolResult(result as Parameters<typeof formatToolResult>[0])
    const safeResult = redactSensitiveData(result).value
    span?.end({
      status: (result as { ok?: boolean }).ok === false ? 'failed' : 'success',
      output: {
        result: safeResult,
        text: formatToolResult(safeResult as Parameters<typeof formatToolResult>[0]),
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
