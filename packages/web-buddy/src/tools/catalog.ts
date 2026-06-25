import type { ToolCategory, ToolDef } from './types.js'

const sessionProperty = { type: 'string', description: 'Optional browser session id. Defaults to "default".' }

export const TOOL_CATALOG: ToolDef[] = [
  {
    name: 'browser_open',
    mcpName: 'browser_open',
    description: 'Open a URL in the browser session. Usually the first step of a web task.',
    category: 'action',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL, must include https://' },
        sessionId: sessionProperty,
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Navigation wait condition. Default: domcontentloaded',
        },
      },
      required: ['url'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { changesPage: true },
  },
  {
    name: 'browser_snapshot',
    mcpName: 'browser_snapshot',
    description:
      'Capture the current page structure and assign stable refs (e1, e2, ...) to interactive elements. Always snapshot before click/type/select.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional browser session id.' },
        maxElements: { type: 'number', description: 'Maximum interactive elements to include. Default: 80.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['PageSnapshot', 'PageState'] },
  },
  {
    name: 'browser_click',
    mcpName: 'browser_click',
    description: 'Click an element by ref from the latest browser_snapshot. Submit-like elements are tagged as high risk.',
    category: 'action',
    risk: 'L1',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. e4' },
        sessionId: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds.' },
        confirmed: { type: 'boolean', description: 'Required as true for high-risk L3 actions after user confirmation.' },
        highlight: {
          type: 'boolean',
          description: 'When true and headful, move the mouse to the element and flash an outline before clicking.',
        },
      },
      required: ['ref'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { requiresSnapshot: true, riskResolver: 'ref' },
  },
  {
    name: 'browser_click_text',
    mcpName: 'browser_click_text',
    description:
      'Click a visible text string directly, without requiring a snapshot ref. Use this for custom DOM lists/cards where visible job titles or links are present in body text but not exposed as refs.',
    category: 'action',
    risk: 'L1',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text to click, e.g. a job title.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'When true, require exact normalized text match. Default: false.' },
        nth: { type: 'number', description: 'Zero-based match index when multiple visible matches exist. Default: 0.' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds.' },
        confirmed: { type: 'boolean', description: 'Required as true for submit-like text such as 投递/申请/提交.' },
        highlight: {
          type: 'boolean',
          description: 'When true and headful, move the mouse to the matched text and flash an outline before clicking.',
        },
      },
      required: ['text'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { riskResolver: 'text' },
  },
  {
    name: 'browser_form_snapshot',
    mcpName: 'browser_form_snapshot',
    description:
      'Capture form-specific state: labels, placeholders, required flags, current values, validation errors, select options, and upload hints. Use this before uploading a resume or filling complex application forms.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        maxFields: { type: 'number', description: 'Maximum fields to include. Default: 120.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['FormSnapshot', 'FormState'] },
  },
  {
    name: 'browser_upload_file',
    mcpName: 'browser_upload_file',
    description:
      'Upload a local file, such as a resume PDF, through an input[type=file] or an upload button that opens a file chooser. Use browser_form_snapshot first to find upload hints. Requires confirmed=true.',
    category: 'action',
    risk: 'L4',
    parameters: {
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
        highlight: {
          type: 'boolean',
          description: 'When true and headful, show visual cursor/highlight before clicking upload trigger.',
        },
      },
      required: ['filePath'],
    },
    local: { enabled: false },
    mcp: { enabled: true },
    metadata: { sensitiveInput: true, requiresConfirmation: true },
  },
  {
    name: 'browser_fill_by_label',
    mcpName: 'browser_fill_by_label',
    description:
      'Fill a form field by matching label, placeholder, aria-label, name/id, or nearby form text. Use for complex application forms when snapshot refs are stale or hard to identify.',
    category: 'action',
    risk: 'L2',
    parameters: {
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
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { writesFormField: true },
  },
  {
    name: 'browser_select_by_text',
    mcpName: 'browser_select_by_text',
    description:
      'Select an option from a native select or custom dropdown by label/ref and visible option text. Useful for city, education, experience, and date-like fields.',
    category: 'action',
    risk: 'L2',
    parameters: {
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
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { writesFormField: true, riskResolver: 'refOrDefault' },
  },
  {
    name: 'browser_type',
    mcpName: 'browser_type',
    description: 'Type text into an input or textarea identified by ref.',
    category: 'action',
    risk: 'L2',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        text: { type: 'string', description: 'Text to input' },
        sessionId: { type: 'string' },
        clear: { type: 'boolean', description: 'Clear existing value before typing. Default: true.' },
        timeoutMs: { type: 'number' },
        highlight: {
          type: 'boolean',
          description: 'When true and headful, flash the field and type char-by-char so the fill is visible.',
        },
        typeDelayMs: { type: 'number', description: 'Per-character delay (ms) when highlight is on. Default: 12.' },
      },
      required: ['ref', 'text'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { requiresSnapshot: true, riskResolver: 'ref' },
  },
  {
    name: 'browser_select',
    mcpName: 'browser_select',
    description: 'Select an option in a select/combobox element by ref.',
    category: 'action',
    risk: 'L2',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        value: { type: 'string', description: 'Option label or value to select' },
        sessionId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['ref', 'value'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { requiresSnapshot: true, riskResolver: 'ref' },
  },
  {
    name: 'browser_wait',
    mcpName: 'browser_wait',
    description: 'Wait for page load state, URL, visible text, or a fixed delay.',
    category: 'action',
    risk: 'L0',
    parameters: {
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
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { mayChangePage: true },
  },
  {
    name: 'browser_screenshot',
    mcpName: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page and save it under outDir. Returns the file path.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        label: { type: 'string', description: 'Filename slug for the screenshot.' },
        outDir: { type: 'string', description: 'Directory to write the PNG into. Default: ./output/screenshots.' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page. Default: false.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['screenshot'] },
  },
  {
    name: 'agent_done',
    description:
      'Signal that the task is complete. Call this with a short summary when the requested task is finished or when you are blocked and cannot continue.',
    category: 'human',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        blocked: { type: 'boolean' },
      },
      required: ['summary'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { terminatesRun: true },
  },
]

export function listToolDefs(): ToolDef[] {
  return [...TOOL_CATALOG]
}

export function listLocalToolDefs(): ToolDef[] {
  return TOOL_CATALOG.filter((tool) => tool.local.enabled)
}

export function listMcpToolDefs(): ToolDef[] {
  return TOOL_CATALOG.filter((tool) => tool.mcp.enabled)
}

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_CATALOG.find((tool) => tool.name === name || tool.mcpName === name)
}

export function getToolCategory(name: string): ToolCategory | undefined {
  return getToolDef(name)?.category
}
