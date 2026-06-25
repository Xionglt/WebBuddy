# Local Web Agent Runtime

This is the self-owned lightweight Web Agent runtime.

Current path:

```text
CLI / Web UI
  -> sdk/orchestrator.ts
  -> runtime/local/agent-loop.ts
  -> runtime/local/tool-registry.ts
  -> browser/* tools
  -> Playwright
```

Files:

- `agent-loop.ts`: the current ReAct-style loop where the model calls browser tools.
- `tool-registry.ts`: local function-calling registry facade used by the loop.
  Tool definitions come from `src/tools/catalog.ts` through
  `src/tools/local-adapter.ts`; MCP uses `src/tools/mcp-adapter.ts`.
- `page-view.ts`: compact text renderer for browser snapshots.
- `login.ts`: saved-cookie login bootstrap for local runs.

Observation Model v1 lives in `src/observation/`. `browser_snapshot` writes
`page-state-latest.json` and `browser_form_snapshot` writes
`form-state-latest.json` under the active trace artifacts directory when a
trace session is available. These writes are best-effort and must not change
agent control flow.

The long-term plan is to evolve this directory into `AgentRuntime`,
`ContextManager`, `ObservationManager`, `PolicyEngine`, and workflow-driven
execution. For now it intentionally preserves the existing behavior.
