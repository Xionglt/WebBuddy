# Web Buddy

English | [简体中文](./README.zh-CN.md)

`web-buddy` is the Agent Runtime for [multi-functional-agent](../../README.md). It provides a CLI-based agent loop with tool calling and MCP integration, serving as the execution engine for web automation tasks such as form filling and page interaction.

## Overview

Web Buddy is derived from a recovered Claude Code 2.1.88 source rebuild. It is reorganized as a standard npm project for:

- local development and debugging
- agent loop execution
- MCP server integration (Playwright MCP planned)

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
chmod +x start.sh bin/web-buddy-glm.sh
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
packages/web-buddy/
├── bin/           # CLI launcher scripts
├── src/           # Recovered source modules
├── scripts/       # Build scripts
├── vendor/        # Native/vendor source
├── dist/          # Build output (generated)
└── package.json
```

## Notes

This is not the official Anthropic Claude Code repository. It is a recovered and reconstructed project suitable for research, debugging, and extension within the multi-functional-agent ecosystem.
