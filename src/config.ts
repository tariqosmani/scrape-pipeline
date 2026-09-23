import { readFile } from "node:fs/promises";
import { z } from "zod";

const fieldSchema = z.object({
  // Omitted: the value comes from the item element itself, e.g. an attribute on it.
  selector: z.string().optional(),
  attr: z.string().optional(),
});

export const targetSchema = z.object({
  // Lands in a file name and a sheet tab name, so it stays plain.
  name: z.string().regex(/^[a-z0-9-]+$/, "use lowercase letters, digits and hyphens"),
  // The sheet tab listing this target's current items. Defaults to the name.
  sheetTab: z.string().optional(),
  startUrl: z.url(),
  // "xml" for feeds such as the ECB's daily rates: tag names are case-sensitive there.
  // "json" for an API: itemSelector and each field's selector are dotted paths, "" being the response itself.
  format: z.enum(["html", "xml", "json"]).default("html"),
  maxPages: z.number().int().positive().default(1),
  requestDelayMs: z.number().int().min(0).default(1000),
  userAgent: z.string(),
  itemSelector: z.string(),
  fields: z.record(z.string(), fieldSchema),
  key: z.string(),
  // The field alerts and the Changes tab name an item by. Defaults to key; set it when the key is an opaque ID.
  label: z.string().optional(),
  nextPageSelector: z.string().optional(),
  minItemsExpected: z.number().int().min(0).default(1),
  // Slack only: the sheet's Changes tab still records every change.
  alerts: z
    .object({
      // A numeric field (price, rate) alerts only when it moves at least this many percent.
      minChangePct: z.number().min(0).default(0),
      // Fields whose changes never alert, e.g. a view count.
      ignore: z.array(z.string()).default([]),
    })
    .default({ minChangePct: 0, ignore: [] }),
});

export type Target = z.infer<typeof targetSchema>;

export async function loadTarget(path: string): Promise<Target> {
  return parseTarget(JSON.parse(await readFile(path, "utf8")), path);
}

/** Validates an already-loaded target, e.g. one a Trigger.dev task imports into its bundle. */
export function parseTarget(raw: unknown, source: string): Target {
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid target config ${source}:\n${z.prettifyError(parsed.error)}`);
  }
  const { name, key, label, fields, format, nextPageSelector, alerts } = parsed.data;
  const unknownIgnored = alerts.ignore.filter((field) => !(field in fields));
  if (unknownIgnored.length > 0) {
    throw new Error(`Target "${name}": alerts.ignore names unknown field(s): ${unknownIgnored.join(", ")}`);
  }
  if (!(key in fields)) {
    throw new Error(`Target "${name}": key "${key}" is not one of the configured fields.`);
  }
  if (label !== undefined && !(label in fields)) {
    throw new Error(`Target "${name}": label "${label}" is not one of the configured fields.`);
  }
  if (format === "json") {
    const bad = Object.entries(fields).filter(([, f]) => f.selector === undefined || f.attr !== undefined);
    if (bad.length > 0) {
      throw new Error(`Target "${name}": JSON fields need a "selector" path and no "attr": ${bad.map(([n]) => n).join(", ")}`);
    }
    if (nextPageSelector) throw new Error(`Target "${name}": JSON targets do not paginate; remove "nextPageSelector".`);
  }
  return parsed.data;
}
