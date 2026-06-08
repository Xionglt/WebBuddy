import { Page } from "playwright";
import { getPage } from "../browser.js";

export async function navigate(
  url: string,
  options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }
): Promise<{ title: string; url: string }> {
  const page = await getPage();
  const response = await page.goto(url, {
    waitUntil: options?.waitUntil ?? "domcontentloaded",
  });

  if (!response) {
    throw new Error(`Failed to navigate to ${url}: no response`);
  }

  if (response.status() >= 400) {
    throw new Error(
      `Navigation failed: HTTP ${response.status()} for ${url}`
    );
  }

  return {
    title: await page.title(),
    url: page.url(),
  };
}
