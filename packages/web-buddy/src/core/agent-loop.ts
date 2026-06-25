/**
 * Compatibility re-export.
 *
 * The self-owned local agent loop now lives under `src/runtime/local/` so it
 * is clearly separated from Claude Code runtime adapters and MCP tooling.
 */
export * from '../runtime/local/agent-loop.js'
