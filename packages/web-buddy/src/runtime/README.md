# Runtime Layout

This directory contains runtime implementations owned by this project.

```text
runtime/
└── local/   # Self-owned Web Agent loop used by CLI/Web UI raw/fill/demo paths.
```

The Claude Code path is not implemented here. It lives under
`scripts/adapters/claude-code/` and calls this package through the MCP server.

