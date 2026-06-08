#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { closeBrowser } from "./browser.js";
import { navigate } from "./tools/navigate.js";
import { screenshot } from "./tools/screenshot.js";
import { extract } from "./tools/extract.js";
import { click } from "./tools/click.js";
import { fill } from "./tools/fill.js";
import { wait, wait_for_navigation } from "./tools/wait.js";

const server = new Server(
  {
    name: "playwright-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: "web_navigate",
    description:
      "Open a URL in the browser. Returns the page title and final URL after navigation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
        waitUntil: {
          type: "string",
          enum: ["load", "domcontentloaded", "networkidle"],
          description:
            'When to consider navigation complete. Default: "domcontentloaded"',
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_screenshot",
    description:
      "Take a screenshot of the current page or a specific element. Saves PNG to disk and returns base64.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description:
            "CSS selector of the element to screenshot. Screenshots full page if omitted.",
        },
        fullPage: {
          type: "boolean",
          description: "Whether to capture the full scrollable page. Default: false",
        },
        savePath: {
          type: "string",
          description:
            "File path to save the screenshot. Auto-generates a path if omitted.",
        },
      },
    },
  },
  {
    name: "web_extract",
    description:
      "Extract content from the page. Defaults to body text; auto-detects and parses tables.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to extract from. Default: body",
        },
        property: {
          type: "string",
          enum: ["textContent", "innerText", "innerHTML", "href", "src"],
          description: "Which property to extract. Default: innerText",
        },
        attribute: {
          type: "string",
          description:
            "Extract a specific HTML attribute instead of a property (e.g. 'href' from links).",
        },
      },
    },
  },
  {
    name: "web_click",
    description: "Click an element on the page by CSS selector.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to click",
        },
        button: {
          type: "string",
          enum: ["left", "right", "middle"],
          description: "Mouse button. Default: left",
        },
        clickCount: {
          type: "number",
          description: "Number of clicks. Default: 1 (double-click: 2)",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "web_fill",
    description: "Fill a form field with a value. Optionally press Enter after.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the input field",
        },
        value: {
          type: "string",
          description: "The value to fill in",
        },
        clear: {
          type: "boolean",
          description: "Clear existing value before filling. Default: true",
        },
        pressEnter: {
          type: "boolean",
          description: "Press Enter after filling. Default: false",
        },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "web_wait",
    description: "Wait for an element to appear on the page.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: {
          type: "string",
          description: "CSS selector of the element to wait for",
        },
        state: {
          type: "string",
          enum: ["attached", "detached", "visible", "hidden"],
          description: "State to wait for. Default: visible",
        },
        timeout: {
          type: "number",
          description: "Maximum wait time in ms. Default: 30000",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "web_wait_for_navigation",
    description: "Wait for the page to navigate to a specific URL pattern.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description:
            "URL or glob pattern to wait for (e.g. '**/dashboard')",
        },
        timeout: {
          type: "number",
          description: "Maximum wait time in ms. Default: 30000",
        },
      },
    },
  },
];

// ─── Tool Handlers ─────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "web_navigate":
        result = await navigate(args!.url as string, {
          waitUntil: args!.waitUntil as "load" | "domcontentloaded" | "networkidle" | undefined,
        });
        break;

      case "web_screenshot":
        result = await screenshot({
          selector: args!.selector as string | undefined,
          fullPage: args!.fullPage as boolean | undefined,
          savePath: args!.savePath as string | undefined,
        });
        break;

      case "web_extract":
        result = await extract({
          selector: args!.selector as string | undefined,
          property: args!.property as "textContent" | "innerText" | "innerHTML" | "href" | "src" | undefined,
          attribute: args!.attribute as string | undefined,
        });
        break;

      case "web_click":
        result = await click(args!.selector as string, {
          button: args!.button as "left" | "right" | "middle" | undefined,
          clickCount: args!.clickCount as number | undefined,
        });
        break;

      case "web_fill":
        result = await fill(args!.selector as string, args!.value as string, {
          clear: args!.clear as boolean | undefined,
          pressEnter: args!.pressEnter as boolean | undefined,
        });
        break;

      case "web_wait":
        result = await wait(args!.selector as string, {
          state: args!.state as "attached" | "detached" | "visible" | "hidden" | undefined,
          timeout: args!.timeout as number | undefined,
        });
        break;

      case "web_wait_for_navigation":
        result = await wait_for_navigation({
          url: args!.url as string | undefined,
          timeout: args!.timeout as number | undefined,
        });
        break;

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ─── Start Server ──────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
