# Playwright MCP Server

A Model Context Protocol (MCP) server that provides browser automation capabilities via Playwright.

## Features

| Tool | Description |
|------|-------------|
| `web_navigate` | Open a URL, wait for navigation |
| `web_screenshot` | Capture full page or element screenshot |
| `web_extract` | Extract text, tables, attributes from page |
| `web_click` | Click elements by CSS selector |
| `web_fill` | Fill form fields, optionally press Enter |
| `web_wait` | Wait for element to appear/disappear |
| `web_wait_for_navigation` | Wait for URL change |

## Install

```bash
git clone https://github.com/Xionglt/playwright-mcp-server.git
cd playwright-mcp-server
npm install
npm run build
```

## Quick Start — WorkBuddy

Add to `~/.workbuddy/mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/path/to/playwright-mcp-server/dist/index.js"]
    }
  }
}
```

### Headed mode (see browser UI for debugging)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/path/to/playwright-mcp-server/dist/index.js"],
      "env": {
        "HEADED": "1"
      }
    }
  }
}
```

### Reuse Chrome profile (skip login)

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["/path/to/playwright-mcp-server/dist/index.js"],
      "env": {
        "USER_DATA_DIR": "/path/to/chrome/profile"
      }
    }
  }
}
```

## Tool Reference

### web_navigate

```json
{ "url": "https://example.com", "waitUntil": "networkidle" }
```

### web_screenshot

```json
{ "selector": "#chart", "fullPage": false, "savePath": "./screenshot.png" }
```

### web_extract

```json
{ "selector": "table", "property": "innerText" }
```

```json
{ "selector": "a.download", "attribute": "href" }
```

### web_click

```json
{ "selector": "button.submit", "clickCount": 1 }
```

### web_fill

```json
{ "selector": "input#username", "value": "admin", "pressEnter": true }
```

### web_wait

```json
{ "selector": ".result-table", "state": "visible", "timeout": 10000 }
```

### web_wait_for_navigation

```json
{ "url": "**/dashboard", "timeout": 15000 }
```

## Development

```bash
npm install
npm run build    # compile TypeScript
npm run dev      # watch mode
```

## License

MIT
