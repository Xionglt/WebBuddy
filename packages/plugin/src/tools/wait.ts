import { getPage } from "../browser.js";

export async function wait(
  selector: string,
  options?: {
    state?: "attached" | "detached" | "visible" | "hidden";
    timeout?: number;
  }
): Promise<{ found: boolean; selector: string }> {
  const page = await getPage();

  await page.waitForSelector(selector, {
    state: options?.state ?? "visible",
    timeout: options?.timeout ?? 30000,
  });

  return { found: true, selector };
}

export async function wait_for_navigation(
  options?: {
    url?: string;
    timeout?: number;
  }
): Promise<{ url: string; title: string }> {
  const page = await getPage();

  if (options?.url) {
    await page.waitForURL(options.url, {
      timeout: options?.timeout ?? 30000,
    });
  }

  return {
    url: page.url(),
    title: await page.title(),
  };
}
