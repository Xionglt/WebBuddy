# Claude Code Runtime Adapter

This directory contains the optional Claude Code runtime path.

Current path:

```text
Claude Code recovered runtime / claude-code
  -> Playwright MCP server
  -> src/tools/index.ts
  -> browser/* tools
  -> Playwright
```

`alibaba-apply.mjs` keeps the existing Alibaba task runner behavior, but it is
now visibly separated from the self-owned local Web Agent runtime.

The old `scripts/claude-runtime-alibaba.mjs` path remains as a compatibility
wrapper.
