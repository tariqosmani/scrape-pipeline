import * as cheerio from "cheerio";
import type { Target } from "./config.ts";

export type Item = Record<string, string>;

export type PageResult = {
  items: Item[];
  nextUrl: string | null;
};

export function extractPage(html: string, pageUrl: string, target: Target): PageResult {
  const $ = cheerio.load(html);

  const items = $(target.itemSelector)
    .toArray()
    .map((element) => {
      const item: Item = {};
      for (const [name, field] of Object.entries(target.fields)) {
        const node = $(element).find(field.selector).first();
        const value = field.attr ? node.attr(field.attr) : node.text();
        item[name] = value?.trim() ?? "";
      }
      return item;
    });

  let nextUrl: string | null = null;
  if (target.nextPageSelector) {
    const href = $(target.nextPageSelector).first().attr("href");
    if (href) nextUrl = new URL(href, pageUrl).toString();
  }

  return { items, nextUrl };
}

/** Share of items with a non-empty value, per field. Used to catch a layout change that a 200 response hides. */
export function fillRates(items: Item[], fields: string[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const field of fields) {
    const filled = items.filter((item) => (item[field] ?? "") !== "").length;
    rates[field] = items.length === 0 ? 0 : filled / items.length;
  }
  return rates;
}
