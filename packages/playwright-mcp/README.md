# Playwright MCP Server

Phase 1 browser automation MCP server for [multi-functional-agent](../../README.md).

Exposes ref-based Playwright tools to `web-buddy` over MCP stdio.

## Tools (Phase 1)

| Tool | Description |
|------|-------------|
| `browser_open` | Open a URL and create/reuse a browser session |
| `browser_snapshot` | Capture interactive page structure with stable refs (`e1`, `e2`, ...) |
| `browser_click` | Click an element by ref |
| `browser_type` | Type into an input by ref |
| `browser_select` | Select an option by ref |
| `browser_wait` | Wait for load state, URL, text, or delay |

## Quick Start

```bash
cd packages/playwright-mcp
npm install
npm run build
npm start
```

## web-buddy Integration

Add to your MCP config (project or user scope):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/absolute/path/to/multi-functional-agent/packages/playwright-mcp/dist/server.js"],
      "env": {
        "PLAYWRIGHT_HEADLESS": "false",
        "PLAYWRIGHT_ALLOWED_DOMAINS": "example.com,*.example.com"
      }
    }
  }
}
```

Or from repo root after build:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npm",
      "args": ["--prefix", "packages/playwright-mcp", "start"]
    }
  }
}
```

## Typical Agent Flow

```text
browser_open(url)
browser_snapshot()
browser_type(ref=e1, text="张三")
browser_type(ref=e2, text="zhangsan@example.com")
browser_snapshot()
# stop before clicking submit (risk L3)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLAYWRIGHT_HEADLESS` | `true` | Set `false` to show browser window |
| `PLAYWRIGHT_ALLOWED_DOMAINS` | empty | Comma-separated domain allowlist |
| `PLAYWRIGHT_BLOCK_LOCALHOST` | `true` | Block localhost navigation |
| `PLAYWRIGHT_VIEWPORT_WIDTH` | `1280` | Browser viewport width |
| `PLAYWRIGHT_VIEWPORT_HEIGHT` | `800` | Browser viewport height |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `30000` | Navigation timeout |
| `PLAYWRIGHT_ACTION_TIMEOUT_MS` | `10000` | Action timeout |

## Response Format

All tools return JSON text content:

```json
{
  "ok": true,
  "observation": "Typed into ref e1 (Full Name): \"张三\"",
  "data": { "ref": "e1", "risk": "L2", "chars": 2 },
  "pageChanged": true
}
```

On failure:

```json
{
  "ok": false,
  "observation": "Ref \"e9\" is stale or no longer visible.",
  "error": {
    "code": "REF_STALE",
    "message": "Ref \"e9\" is stale or no longer visible.",
    "recoverable": true,
    "suggestedNextActions": ["browser_snapshot"]
  }
}
```

## Notes

- Always call `browser_snapshot` before using refs.
- Refs are invalidated after navigation or page-changing actions.
- Submit-like buttons are tagged with risk level `L3`.
