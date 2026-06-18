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
        confirmed: { type: 'boolean', description: 'Required as true for high-risk L3 actions after user confirmation.' },
        highlight: { type: 'boolean', description: 'When true and headful, move the mouse to the element and flash an outline before clicking.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_click_text',
    description:
      'Click a visible text string directly, without requiring a snapshot ref. Use this for custom DOM lists/cards where visible job titles or links are present in body text but not exposed as refs.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text to click, e.g. a job title.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'When true, require exact normalized text match. Default: false.' },
        nth: { type: 'number', description: 'Zero-based match index when multiple visible matches exist. Default: 0.' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds.' },
        confirmed: { type: 'boolean', description: 'Required as true for submit-like text such as 投递/申请/提交.' },
        highlight: { type: 'boolean', description: 'When true and headful, move the mouse to the matched text and flash an outline before clicking.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_form_snapshot',
    description:
      'Capture form-specific state: labels, placeholders, required flags, current values, validation errors, select options, and upload hints. Use this before uploading a resume or filling complex application forms.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        maxFields: { type: 'number', description: 'Maximum fields to include. Default: 120.' },
      },
    },
  },
  {
    name: 'browser_upload_file',
    description:
      'Upload a local file, such as a resume PDF, through an input[type=file] or an upload button that opens a file chooser. Use browser_form_snapshot first to find upload hints. Requires confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to local file to upload.' },
        ref: { type: 'string', description: 'Optional ref from browser_snapshot for an upload button or file input.' },
        text: { type: 'string', description: 'Optional visible upload button text, e.g. 上传简历.' },
        selector: { type: 'string', description: 'Optional CSS selector for input[type=file] or upload button.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'When using text, require exact normalized text match. Default: false.' },
        nth: { type: 'number', description: 'Zero-based match index when multiple text matches exist. Default: 0.' },
        timeoutMs: { type: 'number' },
        confirmed: { type: 'boolean', description: 'Required as true because resume upload contains sensitive data.' },
        highlight: { type: 'boolean', description: 'When true and headful, show visual cursor/highlight before clicking upload trigger.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'browser_fill_by_label',
    description:
      'Fill a form field by matching label, placeholder, aria-label, name/id, or nearby form text. Use for complex application forms when snapshot refs are stale or hard to identify.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Field label or nearby text, e.g. 姓名, 手机, 邮箱.' },
        text: { type: 'string', description: 'Text to enter.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'Require exact normalized label match. Default: false.' },
        nth: { type: 'number', description: 'Zero-based match index when multiple fields match. Default: 0.' },
        clear: { type: 'boolean', description: 'Clear existing value before typing. Default: true.' },
        timeoutMs: { type: 'number' },
      },
      required: ['label', 'text'],
    },
  },
  {
    name: 'browser_select_by_text',
    description:
      'Select an option from a native select or custom dropdown by label/ref and visible option text. Useful for city, education, experience, and date-like fields.',
    inputSchema: {
      type: 'object',
      properties: {
        option: { type: 'string', description: 'Visible option text to choose, e.g. 杭州.' },
        label: { type: 'string', description: 'Optional field label or nearby text for the dropdown.' },
        ref: { type: 'string', description: 'Optional ref from browser_snapshot for the dropdown/control.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'Require exact text match for label/option. Default: false.' },
        nth: { type: 'number', description: 'Zero-based control match index when multiple labels match. Default: 0.' },
        optionNth: { type: 'number', description: 'Zero-based option match index when multiple options match. Default: 0.' },
        timeoutMs: { type: 'number' },
      },
      required: ['option'],
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
        highlight: { type: 'boolean', description: 'When true and headful, flash the field and type char-by-char so the fill is visible.' },
        typeDelayMs: { type: 'number', description: 'Per-character delay (ms) when highlight is on. Default: 12.' },
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
  {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page and save it under outDir. Returns the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        label: { type: 'string', description: 'Filename slug for the screenshot.' },
        outDir: { type: 'string', description: 'Directory to write the PNG into. Default: ./output/screenshots.' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page. Default: false.' },
      },
    },
  },
]

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
  return formatToolResult(result as Parameters<typeof formatToolResult>[0])
}
