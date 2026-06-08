import { getPage } from "../browser.js";

export async function fill(
  selector: string,
  value: string,
  options?: {
    clear?: boolean;
    pressEnter?: boolean;
  }
): Promise<{ filled: boolean; selector: string; value: string }> {
  const page = await getPage();
  const element = await page.$(selector);

  if (!element) {
    throw new Error(`Element not found: ${selector}`);
  }

  if (options?.clear !== false) {
    await element.fill("");
  }

  await element.fill(value);

  if (options?.pressEnter) {
    await element.press("Enter");
  }

  return { filled: true, selector, value };
}
