import { getPage } from "../browser.js";

export async function extract(
  options: {
    selector?: string;
    property?: "textContent" | "innerText" | "innerHTML" | "href" | "src";
    attribute?: string;
  } = {}
): Promise<{ data: string | Record<string, string>[] }> {
  const page = await getPage();
  const selector = options.selector ?? "body";
  const property = options.property ?? "innerText";

  if (options.attribute) {
    // Extract a specific attribute from matching elements
    const values = await page.$$eval(selector, (elements, attr) => {
      return elements.map((el) => el.getAttribute(attr) ?? "");
    }, options.attribute);
    return { data: values.join("\n") };
  }

  // Try to extract as table if no specific selector
  if (selector === "body" && property === "innerText") {
    const text = await page.evaluate(() => {
      // Try table extraction first
      const tables = document.querySelectorAll("table");
      if (tables.length > 0) {
        const rows: string[][] = [];
        tables.forEach((table) => {
          table.querySelectorAll("tr").forEach((tr) => {
            const cells: string[] = [];
            tr.querySelectorAll("th, td").forEach((cell) => {
              cells.push(cell.textContent?.trim() ?? "");
            });
            if (cells.length > 0) rows.push(cells);
          });
        });
        return JSON.stringify(rows);
      }
      return document.body.innerText;
    });
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { data: text };
    }
  }

  // Extract property from specific selector
  const elements = await page.$$(selector);
  const results = await Promise.all(
    elements.map(async (el) => {
      const value = await el.getProperty(property);
      return value?.jsonValue() ?? "";
    })
  );

  return { data: results.join("\n") };
}
