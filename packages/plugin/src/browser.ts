import { chromium, Browser, BrowserContext, Page } from "playwright";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export interface BrowserOptions {
  headed?: boolean;
  userDataDir?: string;
  viewport?: { width: number; height: number };
  timeout?: number;
}

const DEFAULT_OPTIONS: BrowserOptions = {
  headed: process.env.HEADED === "1",
  timeout: 30000,
  viewport: { width: 1280, height: 720 },
};

/**
 * Launch or reuse browser instance
 */
export async function launchBrowser(
  options: BrowserOptions = {}
): Promise<Page> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (page && !page.isClosed()) {
    return page;
  }

  const launchOptions: Record<string, unknown> = {
    headless: !opts.headed,
  };

  if (opts.userDataDir) {
    context = await chromium.launchPersistentContext(
      opts.userDataDir,
      {
        ...launchOptions,
        viewport: opts.viewport,
      }
    );
    browser = context.browser();
  } else {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({
      viewport: opts.viewport,
    });
  }

  page = await context.newPage();
  page.setDefaultTimeout(opts.timeout ?? 30000);
  page.setDefaultNavigationTimeout(opts.timeout ?? 30000);

  // Inject visible cursor + trail in headed mode
  if (opts.headed) {
    await context.addInitScript(() => {
      // Cursor dot
      const cursor = document.createElement("div");
      cursor.id = "__pw_cursor";
      Object.assign(cursor.style, {
        position: "fixed",
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "rgba(255, 60, 60, 0.9)",
        border: "2px solid #fff",
        pointerEvents: "none",
        zIndex: "999999",
        transition: "left 0.08s ease-out, top 0.08s ease-out",
        boxShadow: "0 0 8px rgba(255,60,60,0.6)",
      });
      document.documentElement.appendChild(cursor);

      // Trail container
      const trail = document.createElement("div");
      trail.id = "__pw_trail";
      Object.assign(trail.style, {
        position: "fixed",
        inset: "0",
        pointerEvents: "none",
        zIndex: "999998",
      });
      document.documentElement.appendChild(trail);

      let lastTrailTime = 0;

      document.addEventListener("mousemove", (e) => {
        cursor.style.left = e.clientX - 8 + "px";
        cursor.style.top = e.clientY - 8 + "px";

        // Leave trail dot every 30ms
        const now = Date.now();
        if (now - lastTrailTime < 30) return;
        lastTrailTime = now;

        const dot = document.createElement("div");
        Object.assign(dot.style, {
          position: "fixed",
          left: e.clientX - 3 + "px",
          top: e.clientY - 3 + "px",
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "rgba(255, 120, 50, 0.7)",
          pointerEvents: "none",
          transition: "opacity 1s ease-out",
        });
        trail.appendChild(dot);
        requestAnimationFrame(() => (dot.style.opacity = "0"));
        setTimeout(() => dot.remove(), 1200);
      });
    });
  }

  return page;
}

/**
 * Get current active page (launch if needed)
 */
export async function getPage(options: BrowserOptions = {}): Promise<Page> {
  if (page && !page.isClosed()) {
    return page;
  }
  return launchBrowser(options);
}

/**
 * Close browser and clean up
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
  }
  browser = null;
  context = null;
  page = null;
}
