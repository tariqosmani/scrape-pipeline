import * as cheerio from "cheerio";
import type { Target } from "./config.ts";

export type Item = Record<string, string>;

export type PageResult = {
  items: Item[];
  nextUrl: string | null;
};

export function extractPage(body: string, pageUrl: string, target: Target): PageResult {
  // ponytail: one request per JSON target, no pagination; add a page/offset parameter when an API needs it.
  if (target.format === "json") return { items: extractJson(body, target), nextUrl: null };

  const $ = cheerio.load(body, { xml: target.format === "xml" });

  const items = $(target.itemSelector)
    .toArray()
    .map((element) => {
      const item: Item = {};
      for (const [name, field] of Object.entries(target.fields)) {
        const node = field.selector === undefined ? $(element) : $(element).find(field.selector).first();
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

// A 200 that is really an HTML block page or an API error object throws here, so the run fails instead of
// reporting every item as removed.
function extractJson(body: string, target: Target): Item[] {
  const list = at(JSON.parse(body), target.itemSelector);
  if (!Array.isArray(list)) throw new Error(`no list at "${target.itemSelector}" in the JSON response`);
  return list.map((entry) => {
    const item: Item = {};
    for (const [name, field] of Object.entries(target.fields)) item[name] = cell(at(entry, field.selector ?? ""));
    return item;
  });
}

/** Dotted path where a number indexes an array, e.g. "Products.0.Name". "" is the value itself. */
function at(value: unknown, path: string): unknown {
  if (path === "") return value;
  return path.split(".").reduce<unknown>((v, part) => (v as Record<string, unknown> | null | undefined)?.[part], value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return (typeof value === "object" ? JSON.stringify(value) : String(value)).trim();
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
