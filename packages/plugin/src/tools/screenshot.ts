import { getPage } from "../browser.js";
import * as fs from "fs";
import * as path from "path";

export async function screenshot(
  options?: {
    selector?: string;
    fullPage?: boolean;
    savePath?: string;
  }
): Promise<{ savedTo: string; size: string }> {
  const page = await getPage();
  const screenshotOptions: Record<string, unknown> = {
    type: "png",
    fullPage: options?.fullPage ?? false,
  };

  let buffer: Buffer;

  if (options?.selector) {
    const element = await page.$(options.selector);
    if (!element) {
      throw new Error(`Element not found: ${options.selector}`);
    }
    buffer = await element.screenshot(screenshotOptions);
  } else {
    buffer = await page.screenshot(screenshotOptions);
  }

  const savePath =
    options?.savePath ??
    path.join(process.cwd(), `screenshot-${Date.now()}.png`);
  fs.writeFileSync(savePath, buffer);

  const sizeKB = (buffer.length / 1024).toFixed(1);

  return {
    savedTo: savePath,
    size: `${sizeKB} KB`,
  };
}
