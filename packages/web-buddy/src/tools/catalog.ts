import type { ToolCategory, ToolDef } from './types.js'
import type { ToolExecutionPolicyV1 } from './tool-execution-policy.js'

const sessionProperty = { type: 'string', description: 'Optional browser session id. Defaults to "default".' }

const RAW_TOOL_CATALOG: Omit<ToolDef, 'execution'>[] = [
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
      'Capture viewport-only form state: labels, placeholders, required flags, current values, validation errors, select options, and upload hints. Contract: scope=viewport and complete=false; use browser_form_audit for full-form coverage.',
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
    name: 'browser_form_audit',
    mcpName: 'browser_form_audit',
    description:
      'Scroll the whole page, merge visible form fields across segments, and return full_audit formCoverage evidence. Read-only observation; restores scroll position when done.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        maxFields: { type: 'number', description: 'Maximum unique fields to include. Default: 240.' },
        waitMs: { type: 'number', description: 'Delay after each scroll segment in milliseconds. Default: 120.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['FormSnapshot', 'FormState', 'FormCoverage'], readOnly: true },
  },
  {
    name: 'browser_inspect_options',
    mcpName: 'browser_inspect_options',
    description:
      'Inspect options for a native select or custom dropdown/listbox by ref or label. Opens the popup if needed, reads visible options, then presses Escape.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        ref: { type: 'string', description: 'Optional ref from browser_snapshot for the select/combobox control.' },
        label: { type: 'string', description: 'Optional field label or nearby text for the dropdown.' },
        exact: { type: 'boolean', description: 'Require exact label match. Default: false.' },
        nth: { type: 'number', description: 'Zero-based control match index when multiple labels match. Default: 0.' },
        maxOptions: { type: 'number', description: 'Maximum options to return. Default: 120.' },
        open: { type: 'boolean', description: 'When false, only inspect already-visible option panels. Default: true.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['FormOptions'], readOnly: true },
  },
  {
    name: 'resume_query',
    description:
      'Query the recruiting profile by section. Use this compatibility tool when application fields need details beyond the governed CONTEXT_ITEMS section, such as projects, responsibilities, education, skills, or target roles.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['contact', 'summary', 'skills', 'experience', 'projects', 'education', 'targetRoles', 'all'],
          description: 'Resume section to return.',
        },
        query: {
          type: 'string',
          description: 'Optional natural-language hint for what you are looking for in the section.',
        },
      },
      required: ['section'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { produces: ['ResumeProfileV2'], readOnly: true },
  },
  {
    name: 'job_match_candidates',
    description:
      'Read-only candidate discovery for job lists. Scans the current visible/list page, optionally across list pages, ranks job candidates against the resume, and returns detail URLs, reasons, confidence, missing skill gaps, and non-skill context. This tool never decides task completion and never enters an application flow.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        maxPages: {
          type: 'number',
          description: 'Maximum list pages/batches to scan when the site supports pagination. Default: 1.',
        },
        maxJobs: {
          type: 'number',
          description: 'Maximum unique jobs to scan. Default: 50.',
        },
        limit: {
          type: 'number',
          description: 'Maximum ranked candidates to return. Default: 10.',
        },
      },
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { produces: ['JobMatchCandidates'], readOnly: true },
  },
  {
    name: 'plan_form_fill',
    description:
      'Create or refresh a deterministic FieldPlan for the current form using the full resume profile and saved user answers. Read-only planning tool; use before browser_set_field on application forms.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'When true, recompute even if an existing FieldPlan is attached. Default: true.',
        },
      },
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { produces: ['FieldPlan'], readOnly: true },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user for a short missing piece of information needed to fill a form field. Use only when the answer is not in the resume and cannot be inferred from the page. Do not use for dangerous-action confirmation.',
    category: 'human',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'The form field this answer will fill, e.g. expected salary.' },
        question: { type: 'string', description: 'A concise one-sentence question shown to the user.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional answer choices visible to the user.',
        },
      },
      required: ['field', 'question'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { requiresHumanInput: true, readOnly: true },
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
    local: { enabled: true },
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
    name: 'browser_set_field',
    mcpName: 'browser_set_field',
    description:
      'Set one form field from a planned field or explicit label/ref/selector, then immediately read it back and compare with intendedValue. Supports text, textarea, native/custom select, cascader, date, radio, and checkbox. Does not submit or upload files.',
    category: 'action',
    risk: 'L2',
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'object',
          description: 'Optional PlannedField from FieldPlan. field.label, field.controlKind, field.fieldKey, field.fieldIndex, and field.intendedValue are used when present.',
        },
        intendedValue: {
          description: 'Value to set and verify. Use string for text/select/date/radio, string[] for cascader path, boolean for checkbox.',
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
            { type: 'boolean' },
            { type: 'null' },
          ],
        },
        controlKind: {
          type: 'string',
          enum: ['text', 'textarea', 'select_native', 'select_custom', 'cascader', 'date', 'radio', 'checkbox', 'file', 'unknown'],
          description: 'Expected control kind. file is rejected; use browser_upload_file.',
        },
        label: { type: 'string', description: 'Field label or nearby text.' },
        ref: { type: 'string', description: 'Optional ref from browser_snapshot.' },
        selector: { type: 'string', description: 'Optional CSS selector for the field/control.' },
        fieldKey: { type: 'string', description: 'Optional fieldKey from browser_form_snapshot/FormFieldState.' },
        fieldIndex: { type: 'number', description: 'Optional field index from browser_form_snapshot/FormFieldState.' },
        sessionId: { type: 'string' },
        exact: { type: 'boolean', description: 'Require exact label/option match where applicable. Default: false.' },
        nth: { type: 'number', description: 'Zero-based field match index when multiple labels match. Default: 0.' },
        optionNth: { type: 'number', description: 'Zero-based option match index for dropdowns. Default: 0.' },
        clear: { type: 'boolean', description: 'Clear existing value before typing where applicable. Default: true.' },
        timeoutMs: { type: 'number' },
      },
      required: ['intendedValue'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { writesFormField: true, verifiesReadback: true },
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
    name: 'browser_press_key',
    mcpName: 'browser_press_key',
    description:
      'Press a navigation/action key such as Enter, Escape, Tab, ArrowDown, or Backspace. Optionally focus a snapshot ref first. Use after filling search boxes that require Enter.',
    category: 'action',
    risk: 'L2',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete', 'Space'],
          description: 'Key to press.',
        },
        ref: { type: 'string', description: 'Optional element ref to focus before pressing the key.' },
        sessionId: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Action timeout in milliseconds.' },
        highlight: {
          type: 'boolean',
          description: 'When true and headful, flash the focused element before pressing the key.',
        },
      },
      required: ['key'],
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { mayChangePage: true },
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
        timeoutMs: { type: 'number', description: 'Screenshot timeout in milliseconds. Default: 7000.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: true },
    metadata: { produces: ['screenshot'] },
  },
  {
    name: 'trace_summarization',
    description: 'Start the Wave 6 read-only trace summarization pilot from one immutable trace artifact. Returns a task reference immediately.',
    category: 'eval',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        traceArtifactRef: { type: 'object', description: 'Same-session immutable trace artifact reference.' },
        title: { type: 'string', description: 'Optional short task title.' },
      },
      required: ['traceArtifactRef'],
    },
    // Wave 6 pilot only. Keeping this out of the local registry prevents the
    // foreground Loop from routing it before the background gate is accepted.
    local: { enabled: false },
    mcp: { enabled: false },
    metadata: { readOnly: true, backgroundPilot: true },
  },
  {
    name: 'agent_task_spawn',
    description:
      'Start a read-only or analysis-only background task and return immediately. Use this for independent research, trace summarization, memory retrieval, workflow evaluation, or delivery probes while the main agent keeps control of the browser.',
    category: 'eval',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['candidate_job_research', 'trace_summarization', 'memory_retrieval', 'workflow_evaluation', 'delivery_probe'],
        },
        title: { type: 'string', description: 'Short task title.' },
        goal: { type: 'string', description: 'Concrete, self-contained goal for the background worker.' },
        artifactIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Immutable session artifact ids the worker may read.',
        },
        blockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional task ids that must complete first.',
        },
        requiredForCompletion: {
          type: 'boolean',
          description: 'When true, agent_done is blocked until this task satisfies its terminal policy.',
        },
        terminalPolicy: {
          type: 'string',
          enum: ['must_complete_successfully', 'terminal_is_sufficient', 'does_not_block'],
        },
        idempotencyKey: {
          type: 'string',
          description: 'Stable session-scoped key. Reusing it with identical input returns the existing task.',
        },
      },
      required: ['kind', 'title', 'goal', 'idempotencyKey'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { readOnly: true, asyncControlPlane: true },
  },
  {
    name: 'agent_task_status',
    description: 'Inspect one background task or list the current session task graph without blocking.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task id. Omit to list all tasks.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { readOnly: true, asyncControlPlane: true },
  },
  {
    name: 'agent_task_wait',
    description: 'Wait briefly for a task to become terminal or for any background notification to arrive.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task id. Omit to wait for any session task notification.' },
        timeoutMs: { type: 'number', description: 'Maximum wait duration. Capped by the runtime.' },
      },
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { readOnly: true, asyncControlPlane: true },
  },
  {
    name: 'agent_task_result',
    description: 'Read the terminal metadata and immutable output references for a background task. Results are advisory until the main agent verifies them.',
    category: 'observation',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { readOnly: true, asyncControlPlane: true },
  },
  {
    name: 'agent_task_cancel',
    description: 'Cancel a pending or running background task. This never cancels or transfers browser ownership from the main agent.',
    category: 'eval',
    risk: 'L0',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
      },
      required: ['taskId'],
    },
    local: { enabled: true },
    mcp: { enabled: false },
    metadata: { asyncControlPlane: true },
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

const POLICY = (
  readOnly: boolean,
  foreground: ToolExecutionPolicyV1['foreground'],
  resource: ToolExecutionPolicyV1['resource'],
  interruptBehavior: ToolExecutionPolicyV1['interruptBehavior'],
): ToolExecutionPolicyV1 => ({
  schemaVersion: 'tool-execution-policy/v1',
  readOnly,
  foreground,
  resource,
  interruptBehavior,
  background: 'never',
})

const RESUME_QUERY_POLICY = POLICY(true, 'parallel', 'none', 'cancel')
const BROWSER_POLICY = POLICY(false, 'exclusive', 'browser_session', 'block')
const BROWSER_READ_POLICY = POLICY(true, 'exclusive', 'browser_session', 'block')
const HUMAN_POLICY = POLICY(true, 'exclusive', 'human', 'block')
const RUN_STATE_READ_POLICY = POLICY(true, 'exclusive', 'run_state', 'block')
const RUN_STATE_POLICY = POLICY(false, 'exclusive', 'run_state', 'block')
const TRACE_BACKGROUND_POLICY: ToolExecutionPolicyV1 = {
  schemaVersion: 'tool-execution-policy/v1', readOnly: true, foreground: 'exclusive',
  resource: 'none', interruptBehavior: 'cancel', background: 'eligible',
}
/**
 * Every catalog entry receives an explicit S001 contract. The mapping lives
 * beside the catalog so future tools cannot accidentally inherit scheduling
 * authority from legacy metadata.
 */
const EXECUTION_BY_TOOL: Readonly<Record<string, ToolExecutionPolicyV1>> = {
  resume_query: RESUME_QUERY_POLICY,
  // Wave 6 may propose a narrower background mapping. Through Wave 5 this
  // post-freeze tool remains fail-closed on the foreground run-state boundary.
  trace_summarization: RUN_STATE_READ_POLICY,
  browser_snapshot: BROWSER_READ_POLICY,
  browser_form_snapshot: BROWSER_READ_POLICY,
  browser_form_audit: BROWSER_READ_POLICY,
  browser_inspect_options: BROWSER_READ_POLICY,
  browser_wait: BROWSER_READ_POLICY,
  browser_screenshot: BROWSER_READ_POLICY,
  job_match_candidates: BROWSER_READ_POLICY,
  browser_open: BROWSER_POLICY,
  browser_click: BROWSER_POLICY,
  browser_click_text: BROWSER_POLICY,
  browser_upload_file: BROWSER_POLICY,
  browser_fill_by_label: BROWSER_POLICY,
  browser_select_by_text: BROWSER_POLICY,
  browser_set_field: BROWSER_POLICY,
  browser_type: BROWSER_POLICY,
  browser_press_key: BROWSER_POLICY,
  browser_select: BROWSER_POLICY,
  ask_user: HUMAN_POLICY,
  plan_form_fill: RUN_STATE_READ_POLICY,
  agent_task_status: RUN_STATE_READ_POLICY,
  agent_task_wait: RUN_STATE_READ_POLICY,
  agent_task_result: RUN_STATE_READ_POLICY,
  agent_task_spawn: RUN_STATE_POLICY,
  agent_task_cancel: RUN_STATE_POLICY,
  agent_done: RUN_STATE_POLICY,
}

export const TOOL_CATALOG: ToolDef[] = RAW_TOOL_CATALOG.map((tool) => {
  const execution = EXECUTION_BY_TOOL[tool.name]
  if (!execution) throw new Error(`Missing S001 execution policy for catalog tool: ${tool.name}`)
  return { ...tool, execution }
})

export function listToolDefs(): ToolDef[] {
  return [...TOOL_CATALOG]
}

export function listLocalToolDefs(options: { traceSummarizationBackground?: boolean } = {}): ToolDef[] {
  return TOOL_CATALOG.flatMap((tool) => {
    if (tool.name === 'trace_summarization' && options.traceSummarizationBackground === true) {
      return [{ ...tool, local: { enabled: true }, execution: TRACE_BACKGROUND_POLICY }]
    }
    return tool.local.enabled ? [tool] : []
  })
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
