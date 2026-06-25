# Claude Code Runtime

English | [简体中文](./README.zh-CN.md)

`claude-code` is the recovered Claude Code runtime package used by [multi-functional-agent](../../README.md) as an optional external agent runtime.

It is **not** the Web Buddy mainline. New self-owned Web Agent logic, Playwright browser tools, the MCP server, Web UI, and local runtime work belong in `packages/web-buddy`; this package is kept as the recovered Claude Code runtime adapter target.

## Overview

This package is derived from a recovered Claude Code 2.1.88 source rebuild. It is reorganized as a standard npm project for:

- local development and debugging
- agent loop execution
- MCP server integration through the Web Buddy MCP server

Verified working:

- `npm install`
- `npm run build`
- `node dist/cli.js --help`

## Requirements

- Node.js `>= 18`
- npm `>= 9`

## Quick Start

```bash
cp .env.example .env   # fill in your API credentials
npm install
npm run build
npm start
```

Or use the convenience script (loads `.env` automatically):

```bash
chmod +x start.sh bin/claude-code-glm.sh
./start.sh
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_BASE_URL` | Anthropic-compatible API endpoint |
| `ANTHROPIC_AUTH_TOKEN` | API authentication token |
| `ANTHROPIC_MODEL` | Model name (default: `glm-4.7`) |
| `API_TIMEOUT_MS` | Request timeout in milliseconds |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Disable non-essential telemetry |

See [`.env.example`](./.env.example) for a template.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build `dist/` from source |
| `npm start` | Launch CLI |
| `npm run dev` | Launch via `start.sh` (auto-loads `.env`) |

## Project Layout

```text
packages/claude-code/
├── bin/           # CLI launcher scripts
├── src/           # Recovered source modules
├── scripts/       # Build scripts
├── vendor/        # Native/vendor source
├── dist/          # Build output (generated)
└── package.json
```

## Notes

This is not the official Anthropic Claude Code repository. It is a recovered and reconstructed project suitable for research, debugging, and extension within the multi-functional-agent ecosystem.
