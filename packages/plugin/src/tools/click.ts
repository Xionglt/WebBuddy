import { getPage } from "../browser.js";

export async function click(
  selector: string,
  options?: {
    button?: "left" | "right" | "middle";
    clickCount?: number;
    delay?: number;
  }
): Promise<{ clicked: boolean; selector: string }> {
  const page = await getPage();
  const element = await page.$(selector);

  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }

  await element.click({
    button: options?.button ?? "left",
    clickCount: options?.clickCount ?? 1,
    delay: options?.delay,
  });

  return { clicked: true, selector };
}
