/**
 * Built-in Plugin Initialization
 *
 * Initializes built-in plugins that ship with the CLI and appear in the
 * /plugin UI for users to enable/disable.
 *
 * Not all bundled features should be built-in plugins — use this for
 * features that users should be able to explicitly enable/disable. For
 * features with complex setup or automatic-enabling logic (e.g.
 * claude-in-chrome), use src/skills/bundled/ instead.
 *
 * To add a new built-in plugin:
 * 1. Import registerBuiltinPlugin from '../builtinPlugins.js'
 * 2. Call registerBuiltinPlugin() with the plugin definition here
 */

import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { registerBuiltinPlugin } from '../builtinPlugins.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginEntry = join(__dirname, '../../../../../plugin/dist/index.js')

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export function initBuiltinPlugins(): void {
  registerBuiltinPlugin({
    name: 'playwright',
    description:
      'Playwright 浏览器自动化 — 打开网页、截图、提取数据、填表、点击',
    version: '1.0.0',
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: 'node',
        args: [pluginEntry],
        env: {
          HEADED: '1',
        },
      },
    },
    defaultEnabled: true,
  })
}
