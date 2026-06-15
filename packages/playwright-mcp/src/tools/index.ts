import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { browserClick } from '../browser/click.js'
import { browserOpen } from '../browser/open.js'
import { browserSelect } from '../browser/select.js'
import { browserSnapshot } from '../browser/snapshot.js'
import { browserType } from '../browser/type.js'
import { browserWait } from '../browser/wait.js'
import { formatToolResult } from '../errors.js'

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'browser_open',
    description: 'Open a URL in the browser session. Usually the first step of a web task.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL, must include https://' },
        sessionId: { type: 'string', description: 'Optional browser session id. Defaults to "default".' },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Navigation wait condition. Default: domcontentloaded',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture the current page structure and assign stable refs (e1, e2, ...) to interactive elements. Always snapshot before click/type/select.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional browser session id.' },
        maxElements: { type: 'number', description: 'Maximum interactive elements to include. Default: 80.' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref from the latest browser_snapshot. Submit-like elements are tagged as high risk.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. e4' },
        sessionId: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input or textarea identified by ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        text: { type: 'string', description: 'Text to input' },
        sessionId: { type: 'string' },
        clear: { type: 'boolean', description: 'Clear existing value before typing. Default: true.' },
        timeoutMs: { type: 'number' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select',
    description: 'Select an option in a select/combobox element by ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        value: { type: 'string', description: 'Option label or value to select' },
        sessionId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for page load state, URL, visible text, or a fixed delay.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        for: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'url', 'text', 'ms'],
          description: 'Wait mode. Default: ms',
        },
        value: { type: 'string', description: 'Required when for=url or for=text' },
        ms: { type: 'number', description: 'Delay in milliseconds when for=ms. Default: 1000' },
        timeoutMs: { type: 'number', description: 'Maximum wait timeout.' },
      },
    },
  },
]

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  browser_open: (args) => browserOpen(args as Parameters<typeof browserOpen>[0]),
  browser_snapshot: (args) => browserSnapshot(args as Parameters<typeof browserSnapshot>[0]),
  browser_click: (args) => browserClick(args as Parameters<typeof browserClick>[0]),
  browser_type: (args) => browserType(args as Parameters<typeof browserType>[0]),
  browser_select: (args) => browserSelect(args as Parameters<typeof browserSelect>[0]),
  browser_wait: (args) => browserWait(args as Parameters<typeof browserWait>[0]),
}

export async function callBrowserTool(name: string, args: Record<string, unknown>) {
  const handler = handlers[name]
  if (!handler) {
    return formatToolResult({
      ok: false,
      observation: `Unknown tool: ${name}`,
      error: {
        code: 'UNKNOWN',
        message: `Unknown tool: ${name}`,
        recoverable: false,
      },
    })
  }

  const result = await handler(args)
  return formatToolResult(result as { ok: boolean; observation: string; data?: unknown; error?: { code: string; message: string; recoverable: boolean; suggestedNextActions?: string[] }; pageChanged?: boolean })
}
